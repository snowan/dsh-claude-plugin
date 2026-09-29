import { describe, expect, it } from 'vitest'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { assertSdkUserInput, LiveInputCursor } from '../src/input.js'
import type { ClaudeGenerateOptions, ConversationMessage } from '../src/request.js'

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  source: ConversationMessage['source'] = { kind: 'user' },
): ConversationMessage {
  return {
    id: id as never,
    role,
    content: [{ type: 'text', text }],
    source,
  } as ConversationMessage
}

function options(
  messages: ConversationMessage[],
  extra: Partial<ClaudeGenerateOptions> = {},
): ClaudeGenerateOptions {
  return { provider: 'claude-code', model: 'default', messages, ...extra }
}

describe('live SDK input cursor', () => {
  it('coalesces same-step DSH messages into one querying SDK frame', async () => {
    const cursor = new LiveInputCursor()
    const prepared = await cursor.prepare(
      options([message('a', 'user', 'context'), message('b', 'user', 'go')]),
    )
    expect(prepared.map((entry) => entry.shouldQuery)).toEqual([true])
    expect(prepared[0]?.message).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'context' },
        { type: 'text', text: 'go' },
      ],
    })
  })

  it('accepts an exact mirrored assistant response before the next user message', async () => {
    const cursor = new LiveInputCursor()
    const first = [message('u1', 'user', 'first')]
    await cursor.prepare(options(first))
    cursor.commit(first, {
      model: 'default',
      content: [{ type: 'text', text: 'answer' }],
    })
    const assistant = message('a1', 'assistant', 'answer', {
      kind: 'model',
      provider: 'claude-code',
      model: 'default',
    })
    expect(
      await cursor.prepare(options([...first, assistant, message('u2', 'user', 'second')])),
    ).toHaveLength(1)
  })

  it('degrades cold history and fails closed on divergent live history', async () => {
    const cold = new LiveInputCursor()
    const degraded = await cold.prepareStep(
      options([
        message('old', 'assistant', 'old', {
          kind: 'model',
          provider: 'claude-code',
          model: 'default',
        }),
        message('new', 'user', 'new'),
      ]),
    )
    expect(degraded).toMatchObject({
      kind: 'prompt',
      start: { mode: 'degraded' },
      messages: [{ message: { role: 'user' }, shouldQuery: true }],
    })

    const cursor = new LiveInputCursor()
    const first = [message('u1', 'user', 'first')]
    await cursor.prepare(options(first))
    cursor.commit(first, { model: 'default', content: [{ type: 'text', text: 'answer' }] })
    await expect(
      cursor.prepare(
        options([
          message('u1', 'user', 'changed'),
          message('a1', 'assistant', 'answer', {
            kind: 'model',
            provider: 'claude-code',
            model: 'default',
          }),
          message('u2', 'user', 'next'),
        ]),
      ),
    ).rejects.toThrow(/diverged/)
    await expect(
      cursor.prepare(
        options([
          ...first,
          message('a1', 'assistant', 'wrong', {
            kind: 'model',
            provider: 'claude-code',
            model: 'default',
          }),
          message('u2', 'user', 'next'),
        ]),
      ),
    ).rejects.toThrow(/exact assistant response/)
  })

  it('never reconstructs history with assistant-role SDK input', async () => {
    const prepared = await new LiveInputCursor().prepareStep(
      options([
        message('old', 'assistant', 'old answer', {
          kind: 'model',
          provider: 'claude-code',
          model: 'default',
        }),
        message('new', 'user', 'continue'),
      ]),
    )
    expect(prepared.kind).toBe('prompt')
    if (prepared.kind !== 'prompt') throw new Error('fixture expected a prompt plan')
    for (const input of prepared.messages) {
      expect(input).toMatchObject({ type: 'user', message: { role: 'user' } })
      expect(() => assertSdkUserInput(input)).not.toThrow()
    }
    expect(() =>
      assertSdkUserInput({
        type: 'assistant',
        message: { role: 'assistant', content: [] },
      } as never),
    ).toThrowError(expect.objectContaining({ code: 'CLAUDE_PROTOCOL_ERROR' }))
  })

  it.each([{ temperature: 0 }, { maxTokens: 100 }, { stop: ['END'] }])(
    'rejects controls not owned by the Claude transport: %#',
    async (extra) => {
      await expect(
        new LiveInputCursor().prepare(options([message('u', 'user', 'go')], extra)),
      ).rejects.toThrow(/does not expose/)
    },
  )

  it('accepts exact DSH tool results as an MCP resume plan without a user prompt', async () => {
    const cursor = new LiveInputCursor()
    const first = [message('u1', 'user', 'read the fixture')]
    expect(
      (
        await cursor.prepareStep(
          options(first, {
            tools: [
              {
                name: 'read',
                description: 'read a fixture',
                parameters: { type: 'object', properties: {} },
              },
            ],
          }),
        )
      ).kind,
    ).toBe('prompt')
    const toolCall = {
      type: 'tool-call' as const,
      id: 'toolu_read_1' as never,
      name: 'read',
      arguments: '{"path":"/fixture"}',
    }
    cursor.commit(first, { model: 'default', content: [toolCall] })
    const assistant: ConversationMessage = {
      id: 'a1' as never,
      role: 'assistant',
      content: [toolCall],
      source: {
        kind: 'model',
        provider: 'claude-code',
        model: 'default',
      },
    }
    const toolResult: ToolResultMessage = {
      id: 'r1' as never,
      role: 'tool',
      toolCallId: 'toolu_read_1' as never,
      content: [{ type: 'text', text: 'fixture-value' }],
      isError: false,
      source: { kind: 'tool', callId: 'toolu_read_1' as never },
    }
    expect(await cursor.prepareStep(options([...first, assistant, toolResult]))).toEqual({
      kind: 'tool-results',
      results: [toolResult],
    })
    await expect(cursor.prepare(options([...first, assistant, toolResult]))).rejects.toThrow(
      /resume/,
    )
  })

  it('rejects malformed DSH tool-result continuation messages', async () => {
    const cursor = new LiveInputCursor()
    const first = [message('u1', 'user', 'use a tool')]
    await cursor.prepare(options(first))
    const call = {
      type: 'tool-call' as const,
      id: 'toolu_1' as never,
      name: 'read',
      arguments: '{}',
    }
    cursor.commit(first, { model: 'default', content: [call] })
    const assistant: ConversationMessage = {
      id: 'a1' as never,
      role: 'assistant',
      content: [call],
      source: { kind: 'model', provider: 'claude-code', model: 'default' },
    }
    const valid: ToolResultMessage = {
      id: 'r1' as never,
      role: 'tool',
      toolCallId: 'toolu_1' as never,
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'tool', callId: 'toolu_1' as never },
    }
    for (const invalid of [
      message('r1', 'user', 'a user message is not a tool result'),
      { ...valid, role: 'assistant' as const },
      { ...valid, toolCallId: 'other' as never },
      { ...valid, source: { kind: 'tool' as const, callId: 'other' as never } },
    ]) {
      await expect(
        cursor.prepareStep(options([...first, assistant, invalid as ConversationMessage])),
      ).rejects.toThrow(/tool boundary|correlation/)
    }
  })

  it('rejects empty and non-text user content', async () => {
    const base = message('u', 'user', 'go')
    await expect(
      new LiveInputCursor().prepare(options([{ ...base, content: [] }])),
    ).rejects.toThrow(/no content/)
    await expect(
      new LiveInputCursor().prepare(
        options([{ ...base, content: [{ type: 'reasoning', text: 'hidden' }] }]),
      ),
    ).rejects.toThrow(/unsupported/)
  })

  it('rejects a shortened live prefix, no new content, and an assistant in the pending suffix', async () => {
    const cursor = new LiveInputCursor()
    const first = [message('u1', 'user', 'first'), message('u2', 'user', 'second')]
    await cursor.prepare(options(first))
    cursor.commit(first, { model: 'default', content: [{ type: 'text', text: 'answer' }] })
    await expect(cursor.prepare(options(first.slice(0, 1)))).rejects.toThrow(/history is shorter/)
    const mirrored = message('a1', 'assistant', 'answer', {
      kind: 'model',
      provider: 'claude-code',
      model: 'default',
    })
    await expect(cursor.prepare(options([...first, mirrored]))).rejects.toThrow(
      /requires new user content/,
    )
    await expect(new LiveInputCursor().prepare(options([mirrored]))).rejects.toThrow(
      /requires new user content/,
    )
    await expect(
      cursor.prepare(
        options([
          ...first,
          mirrored,
          message('a2', 'assistant', 'unexpected', {
            kind: 'model',
            provider: 'claude-code',
            model: 'default',
          }),
        ]),
      ),
    ).rejects.toThrow(/only user messages/)
  })
})
