import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { canonicalToolJson } from '../src/json.js'
import type { ConversationMessage } from '../src/request.js'
import {
  assistantFingerprint,
  createReplayEnvelope,
  DEGRADED_REPLAY_PREAMBLE,
  degradedReplayText,
  MAX_DEGRADED_REPLAY_BYTES,
  messageFingerprint,
  planColdStart,
} from '../src/replay.js'

const sessionId = '11111111-1111-4111-8111-111111111111'
const transcriptAt = '22222222-2222-4222-8222-222222222222'
const system = 'DSH owns the harness.'
const cwd = '/workspace/project'

function user(id: string, text: string): ConversationMessage {
  return {
    id: id as never,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function assistant(
  id: string,
  content: ContentBlock[],
  replayState?: unknown,
): ConversationMessage {
  return {
    id: id as never,
    role: 'assistant',
    content,
    source: {
      kind: 'model',
      provider: 'claude-code',
      model: 'default',
      ...(replayState === undefined ? {} : { replayState }),
    },
  }
}

function envelope(
  messages: ConversationMessage[],
  content: ContentBlock[],
  phase: 'settled' | 'awaiting-tools' = 'settled',
) {
  return createReplayEnvelope({
    messages,
    assistant: content,
    phase,
    sessionId,
    transcriptAt,
    model: 'sonnet',
    system,
    cwd,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    },
  })!
}

describe('durable Claude replay planning', () => {
  it('creates a versioned exact-resume anchor bound to prefix and assistant content', () => {
    const u1 = user('u1', 'remember blue')
    const content: ContentBlock[] = [{ type: 'text', text: 'I will remember blue.' }]
    const replayState = envelope([u1], content)
    const a1 = assistant('a1', content, replayState)
    const u2 = user('u2', 'what color?')

    expect(planColdStart([u1, a1, u2], system, cwd)).toEqual({
      mode: 'exact',
      pending: [u2],
      resume: sessionId,
      resumeSessionAt: transcriptAt,
      forkSession: true,
    })
    expect(planColdStart([u1, a1, u2], 'changed system', cwd).mode).toBe('degraded')
    expect(planColdStart([u1, a1, u2], system, '/other/workspace').mode).toBe('degraded')
    expect(replayState).toMatchObject({
      response: {
        kind: 'dsh-claude-plugin/replay',
        version: 1,
        phase: 'settled',
        prefix: { messageCount: 1, digest: messageFingerprint([u1]) },
        assistant: { blockCount: 1, digest: assistantFingerprint(content) },
      },
    })
  })

  it('does not let nested replay metadata alter the visible-message fingerprint', () => {
    const content: ContentBlock[] = [{ type: 'text', text: 'answer' }]
    const plain = assistant('a1', content)
    const decorated = assistant('a1', content, { response: { arbitrary: true } })
    expect(messageFingerprint([plain])).toBe(messageFingerprint([decorated]))
  })

  it('exact-resumes a settled transcript containing a correlated tool error', () => {
    const u1 = user('u1', 'read a missing fixture')
    const call: ContentBlock = {
      type: 'tool-call',
      id: 'toolu_read_1' as never,
      name: 'read',
      arguments: '{"path":"/missing"}',
    }
    const toolAssistant = assistant('a1', [call])
    const failedTool: ToolResultMessage = {
      id: 'r1' as never,
      role: 'tool',
      toolCallId: 'toolu_read_1' as never,
      content: [{ type: 'text', text: 'not found' }],
      isError: true,
      source: { kind: 'tool', callId: 'toolu_read_1' as never },
    }
    const finalContent: ContentBlock[] = [{ type: 'text', text: 'The fixture is missing.' }]
    const prefix = [u1, toolAssistant, failedTool]
    const finalAssistant = assistant('a2', finalContent, envelope(prefix, finalContent))
    const followUp = user('u2', 'summarize the outcome')

    expect(planColdStart([...prefix, finalAssistant, followUp], system, cwd)).toEqual({
      mode: 'exact',
      pending: [followUp],
      resume: sessionId,
      resumeSessionAt: transcriptAt,
      forkSession: true,
    })
  })

  it('fingerprints a DSH 0.2 tool-role result exactly as its DSH 0.1 tool-result block', () => {
    const result: ToolResultMessage = {
      id: 'r1' as never,
      role: 'tool',
      toolCallId: 'toolu_read_1' as never,
      content: [{ type: 'text', text: 'fixture-value' }],
      isError: false,
      source: { kind: 'tool', callId: 'toolu_read_1' as never },
    }
    const legacyProjection = [
      {
        id: 'r1',
        role: 'user',
        source: { kind: 'tool', callId: 'toolu_read_1' },
        content: [
          {
            type: 'tool-result',
            toolCallId: 'toolu_read_1',
            content: [{ type: 'text', text: 'fixture-value' }],
            isError: false,
          },
        ],
      },
    ]
    expect(messageFingerprint([result])).toBe(
      createHash('sha256').update(canonicalToolJson(legacyProjection), 'utf8').digest('hex'),
    )
    expect(messageFingerprint([result])).not.toBe(
      messageFingerprint([{ ...result, isError: true }]),
    )
  })

  it('fingerprints request-only user input without inventing an identity', () => {
    const input: ConversationMessage = { role: 'user', content: [{ type: 'text', text: 'title' }] }
    expect(degradedReplayText([input])).toContain('"source":{"kind":"request"}')
    expect(degradedReplayText([input])).not.toContain('"id"')
    expect(planColdStart([input], system, cwd)).toEqual({ mode: 'fresh', pending: [input] })
  })

  it('degrades divergent, imported, malformed, or forced history to one canonical envelope', () => {
    const u1 = user('u1', 'first')
    const content: ContentBlock[] = [
      { type: 'reasoning', text: 'private chain' },
      { type: 'text', text: 'answer' },
    ]
    const valid = envelope([u1], content)
    const changed = assistant('a1', [{ type: 'text', text: 'changed' }], valid)
    const malformed = assistant('a1', content, {
      response: { kind: 'dsh-claude-plugin/replay', version: 1 },
    })
    const imported = assistant('a1', content)
    const compacted = assistant('a1', content, valid)
    const u2 = user('u2', 'continue')

    for (const messages of [
      [u1, changed, u2],
      [u1, malformed, u2],
      [u1, imported, u2],
      [user('summary', 'compacted history'), compacted, u2],
    ]) {
      const plan = planColdStart(messages, system, cwd)
      expect(plan.mode).toBe('degraded')
      if (plan.mode !== 'degraded') throw new Error('expected degraded replay')
      expect(plan.text.startsWith(DEGRADED_REPLAY_PREAMBLE)).toBe(true)
      const body = JSON.parse(plan.text.slice(DEGRADED_REPLAY_PREAMBLE.length))
      expect(body).toMatchObject({ mode: 'degraded', version: 1 })
    }

    const forced = planColdStart([u1, assistant('a1', content, valid), u2], system, cwd, true)
    expect(forced.mode).toBe('degraded')
    if (forced.mode === 'degraded') {
      expect(forced.text).toContain('"omittedCharacters":13')
      expect(forced.text).not.toContain('private chain')
    }
  })

  it('fails explicitly for a persisted in-flight MCP boundary', () => {
    const u1 = user('u1', 'read')
    const content: ContentBlock[] = [
      {
        type: 'tool-call',
        id: 'toolu_1' as never,
        name: 'read',
        arguments: '{"path":"/fixture"}',
      },
    ]
    const pending = assistant('a1', content, envelope([u1], content, 'awaiting-tools'))
    expect(() => planColdStart([u1, pending, user('u2', 'continue')], system, cwd)).toThrowError(
      expect.objectContaining({ code: 'CLAUDE_IN_FLIGHT_RECOVERY_UNSUPPORTED' }),
    )
    expect(() =>
      planColdStart([u1, pending, user('u2', 'continue')], system, cwd, true),
    ).toThrowError(expect.objectContaining({ code: 'CLAUDE_IN_FLIGHT_RECOVERY_UNSUPPORTED' }))
  })

  it('bounds degraded history and preserves durable image descriptors without bytes', () => {
    const oversized = user('large', 'x'.repeat(MAX_DEGRADED_REPLAY_BYTES))
    expect(() => degradedReplayText([oversized])).toThrow(/exceeds/)
    const image: ConversationMessage = {
      ...user('image', 'unused'),
      content: [
        {
          type: 'image',
          attachment: {
            attachmentId: 'sha256:fixture' as never,
            mediaType: 'image/png',
            bytes: 68,
            width: 1,
            height: 1,
          },
        },
      ],
    }
    const replay = degradedReplayText([image])
    expect(replay).toContain('sha256:fixture')
    expect(replay).toContain('"mediaType":"image/png"')
    expect(replay).not.toContain('base64')
  })

  it('uses a fresh query for user-only history and omits replay state without safe UUIDs', () => {
    const messages = [user('a', 'context'), user('b', 'go')]
    expect(planColdStart(messages, system, cwd)).toEqual({ mode: 'fresh', pending: messages })
    expect(
      createReplayEnvelope({
        messages,
        assistant: [{ type: 'text', text: 'answer' }],
        phase: 'settled',
        sessionId: 'not-a-uuid',
        transcriptAt,
        model: 'sonnet',
        system,
        cwd,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    ).toBeUndefined()
  })
})
