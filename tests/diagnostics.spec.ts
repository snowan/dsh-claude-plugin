import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ClaudeDiagnostics, MAX_DIAGNOSTIC_BYTES } from '../src/diagnostics.js'
import { toolProtocolError } from '../src/errors.js'
import { claudeGenerateOptions, type ClaudeGenerateOptions } from '../src/request.js'

const promptSecret = 'PROMPT_SECRET_9f2f'
const systemSecret = 'SYSTEM_SECRET_71aa'
const toolSecret = 'TOOL_PAYLOAD_SECRET_0ac3'
const sessionSecret = 'SESSION_SECRET_88de'
const credentialSecret = 'sk-ant-fixture-credential-55c1'
const environmentSecret = 'ENVIRONMENT_SECRET_a04d'

function options(): ClaudeGenerateOptions {
  const result: ToolResultMessage = {
    id: 'tool-result' as never,
    role: 'tool',
    source: { kind: 'tool', callId: 'toolu_1' as never },
    toolCallId: 'toolu_1' as never,
    content: [{ type: 'text', text: toolSecret }],
  }
  return claudeGenerateOptions({
    provider: 'claude-code',
    model: 'sonnet',
    sessionId: sessionSecret as never,
    messages: [
      {
        id: 'system' as never,
        role: 'system',
        source: { kind: 'system-prompt' },
        content: [{ type: 'text', text: systemSecret }],
      },
      {
        id: 'user' as never,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: promptSecret }],
      },
      result,
    ],
    tools: [
      {
        name: 'secret-tool-name',
        description: `description ${toolSecret}`,
        parameters: { type: 'object', secret: toolSecret },
      },
    ],
  })
}

describe('redacted Claude diagnostics', () => {
  it('uses one correlation ID and never records prompts, system, session, or tool payloads', () => {
    const previousEnvironment = process.env.DSH_CLAUDE_DIAGNOSTIC_FIXTURE
    process.env.DSH_CLAUDE_DIAGNOSTIC_FIXTURE = environmentSecret
    const debug = vi.fn()
    try {
      const generation = new ClaudeDiagnostics(true, { debug }).begin(options(), 'sonnet')
      generation.attempt(1, 'planned')
      generation.finish(
        'stop',
        {
          inputTokens: 4,
          outputTokens: 2,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          reasoningTokens: 1,
          costUsd: 0.01,
          queryCostUsd: 0.01,
          models: [],
        },
        { reasoningTokens: 1, costUsd: 0.01, queryCostUsd: 0.01 },
      )
      generation.finish(
        'ignored-duplicate',
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        { costUsd: 0, queryCostUsd: 0 },
      )
      const lines = debug.mock.calls.map((call) => String(call[1]))
      expect(lines).toHaveLength(3)
      const combined = lines.join('\n')
      for (const secret of [
        promptSecret,
        systemSecret,
        toolSecret,
        sessionSecret,
        credentialSecret,
        environmentSecret,
        'secret-tool-name',
      ]) {
        expect(combined).not.toContain(secret)
      }
      const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(new Set(parsed.map((entry) => entry.generationId))).toEqual(new Set([generation.id]))
      expect(parsed[0]).toMatchObject({
        event: 'generation.start',
        messageCount: 2,
        textCharacters: promptSecret.length + toolSecret.length,
        toolCount: 1,
      })
      expect(parsed[2]).toMatchObject({
        event: 'generation.finish',
        usage: { costUsd: 0.01, reasoningTokens: 1 },
      })
      for (const line of lines) {
        expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(MAX_DIAGNOSTIC_BYTES)
      }
    } finally {
      if (previousEnvironment === undefined) delete process.env.DSH_CLAUDE_DIAGNOSTIC_FIXTURE
      else process.env.DSH_CLAUDE_DIAGNOSTIC_FIXTURE = previousEnvironment
    }
  })

  it('logs only stable failure identity and emits nothing when disabled', () => {
    const debug = vi.fn()
    const enabled = new ClaudeDiagnostics(true, { debug }).begin(options(), 'sonnet')
    enabled.fail(toolProtocolError(`unsafe failure ${promptSecret} ${credentialSecret}`))
    expect(String(debug.mock.calls.at(-1)?.[1])).not.toContain(promptSecret)
    expect(String(debug.mock.calls.at(-1)?.[1])).not.toContain(credentialSecret)
    expect(JSON.parse(String(debug.mock.calls.at(-1)?.[1]))).toMatchObject({
      event: 'generation.fail',
      code: 'CLAUDE_TOOL_PROTOCOL_ERROR',
      errorType: 'ClaudePluginError',
    })

    const generic = new ClaudeDiagnostics(true, { debug }).begin(options(), 'sonnet')
    generic.fail(new Error(`generic unsafe ${systemSecret}`))
    expect(JSON.parse(String(debug.mock.calls.at(-1)?.[1]))).toMatchObject({
      event: 'generation.fail',
      code: 'CLAUDE_UNEXPECTED_ERROR',
      errorType: 'Error',
    })
    expect(String(debug.mock.calls.at(-1)?.[1])).not.toContain(systemSecret)

    const disabledDebug = vi.fn()
    const disabled = new ClaudeDiagnostics(false, { debug: disabledDebug }).begin(
      options(),
      'sonnet',
    )
    disabled.attempt(1, 'planned')
    disabled.abandoned()
    expect(disabledDebug).not.toHaveBeenCalled()
  })

  it('replaces an oversized diagnostic with a bounded truncation marker', () => {
    const debug = vi.fn()
    const diagnostics = new ClaudeDiagnostics(true, { debug })
    diagnostics.emit({ event: 'fixture', value: 'x'.repeat(MAX_DIAGNOSTIC_BYTES * 2) })
    const line = String(debug.mock.calls[0]?.[1])
    expect(JSON.parse(line)).toMatchObject({ event: 'diagnostic.truncated' })
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(MAX_DIAGNOSTIC_BYTES)
  })
})
