import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message, RequestMessage } from '@deepseek-ai/dsh-llm'
import { claudeGenerateOptions } from '../src/request.js'

const system: Message = {
  id: 'system' as never,
  role: 'system',
  content: [{ type: 'text', text: 'DSH owns the harness.' }],
  source: { kind: 'system-prompt' },
}

const user: Message = {
  id: 'u1' as never,
  role: 'user',
  content: [{ type: 'text', text: 'hello' }],
  source: { kind: 'user' },
}

function options(
  messages: RequestMessage[],
  extra: Partial<GenerateOptions> = {},
): GenerateOptions {
  return { provider: 'claude-code', model: 'default', messages, ...extra }
}

describe('DSH request conversion', () => {
  it('moves a leading system message into the Claude system prompt', () => {
    const converted = claudeGenerateOptions(
      options([system, user], { sessionId: 's1' as never, purpose: 'session-title' }),
    )
    expect(converted).toEqual({
      provider: 'claude-code',
      model: 'default',
      sessionId: 's1',
      purpose: 'session-title',
      system: 'DSH owns the harness.',
      messages: [user],
    })
  })

  it('keeps a one-shot system option and records an empty system message as no prompt', () => {
    expect(claudeGenerateOptions(options([user], { system: 'one-shot' })).system).toBe('one-shot')
    expect(claudeGenerateOptions(options([user])).system).toBeUndefined()
    expect(claudeGenerateOptions(options([{ ...system, content: [] }, user])).system).toBe('')
  })

  it('rejects system prompts Claude Code cannot represent', () => {
    expect(() => claudeGenerateOptions(options([system, user], { system: 'both' }))).toThrow(
      /both a system option and a system message/,
    )
    expect(() => claudeGenerateOptions(options([user, system]))).toThrow(
      /reads only a leading DSH system prompt/,
    )
    expect(() =>
      claudeGenerateOptions(
        options([
          {
            ...system,
            content: [
              {
                type: 'image',
                attachment: {
                  attachmentId: 'sha256:prompt' as never,
                  mediaType: 'image/png',
                  bytes: 1,
                  width: 1,
                  height: 1,
                },
              },
            ],
          },
          user,
        ]),
      ),
    ).toThrow(/system prompt contains unsupported "image" content/)
  })

  it('rejects developer tool-update messages', () => {
    const developer: Message = {
      id: 'd1' as never,
      role: 'developer',
      content: [{ type: 'tool-addition', toolName: 'read' }],
      source: { kind: 'user' },
    }
    expect(() => claudeGenerateOptions(options([user, developer]))).toThrow(
      /does not accept DSH developer tool-update messages/,
    )
  })

  it('replaces offloaded images with the DSH placeholder text', () => {
    const converted = claudeGenerateOptions(
      options([
        {
          ...user,
          content: [
            {
              type: 'image',
              offloaded: true,
              attachment: {
                attachmentId: 'sha256:offloaded' as never,
                mediaType: 'image/png',
                bytes: 1,
                width: 1,
                height: 1,
              },
            },
          ],
        },
      ]),
    )
    expect(converted.messages[0]?.content).toEqual([
      { type: 'text', text: expect.stringContaining('sha256:offloaded') },
    ])
  })
})
