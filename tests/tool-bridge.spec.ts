import { describe, expect, it, vi } from 'vitest'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { GenerateOptions, Message, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AsyncQueue } from '../src/async-queue.js'
import {
  BridgeManager,
  ClaudeCodeAdapter,
  type ClaudeQuery,
  type ClaudeQueryFactory,
  type ClaudeQueryRequest,
  resolveConfig,
} from '../src/index.js'
import { CLAUDE_TOOL_USE_ID_META } from '../src/tool-server.js'

const sdkSession = '11111111-1111-4111-8111-111111111111'

function sdk(value: unknown): SDKMessage {
  return value as SDKMessage
}

function envelope(event: unknown): SDKMessage {
  return sdk({
    type: 'stream_event',
    event,
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: sdkSession,
  })
}

function toolTurn(): SDKMessage[] {
  return [
    envelope({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'toolu_read_1',
        name: 'mcp__dsh__read',
        input: {},
      },
    }),
    envelope({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"path":"/fixture"}' },
    }),
    envelope({ type: 'content_block_stop', index: 0 }),
    sdk({
      type: 'assistant',
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        model: 'sonnet',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_read_1',
            name: 'mcp__dsh__read',
            input: { path: '/fixture' },
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: sdkSession,
    }),
  ]
}

function finalTurn(text: string): SDKMessage[] {
  return [
    envelope({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: null },
    }),
    envelope({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }),
    envelope({ type: 'content_block_stop', index: 0 }),
    sdk({
      type: 'assistant',
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        model: 'sonnet',
        content: [{ type: 'text', text, citations: null }],
      },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: sdkSession,
    }),
    sdk({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      modelUsage: {
        sonnet: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      uuid: crypto.randomUUID(),
      session_id: sdkSession,
    }),
  ]
}

class ToolQuery implements ClaudeQuery {
  readonly output = new AsyncQueue<SDKMessage>()
  readonly inputs: SDKUserMessage[] = []
  readonly toolResults: unknown[] = []
  closed = false
  client: Client | undefined

  constructor(readonly request: ClaudeQueryRequest) {
    void this.#run()
  }

  async #run(): Promise<void> {
    try {
      const config = this.request.options.mcpServers?.dsh
      if (config?.type !== 'sdk') throw new Error('fixture expected the DSH SDK MCP server')
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await config.instance.connect(serverTransport)
      this.client = new Client({ name: 'tool-bridge-fixture', version: '1.0.0' })
      await this.client.connect(clientTransport)
      for await (const input of this.request.prompt) {
        this.inputs.push(input)
        if (input.shouldQuery !== true) continue
        for (const message of toolTurn()) this.output.push(message)
        const toolResult = await this.client.callTool({
          name: 'read',
          arguments: { path: '/fixture' },
          _meta: { [CLAUDE_TOOL_USE_ID_META]: 'toolu_read_1' },
        })
        this.toolResults.push(toolResult)
        for (const message of finalTurn('fixture-value')) this.output.push(message)
      }
    } catch (error: unknown) {
      this.output.fail(error)
    }
  }

  setModel(): Promise<void> {
    return Promise.resolve()
  }

  applyFlagSettings(): Promise<void> {
    return Promise.resolve()
  }

  interrupt(): Promise<void> {
    return Promise.resolve()
  }

  close(): void {
    this.closed = true
    void this.client?.close()
    this.output.close()
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.output
  }
}

function user(): Message {
  return {
    id: 'u1' as never,
    role: 'user',
    content: [{ type: 'text', text: 'Read the fixture.' }],
    source: { kind: 'user' },
  }
}

function assistantTool(replayState?: unknown): Message {
  return {
    id: 'a1' as never,
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        id: 'toolu_read_1' as never,
        name: 'read',
        arguments: '{"path":"/fixture"}',
      },
    ],
    source: {
      kind: 'model',
      provider: 'claude-code',
      model: 'default',
      ...(replayState === undefined ? {} : { replayState }),
    },
  }
}

function toolResult(): Message {
  return {
    id: 'r1' as never,
    role: 'tool',
    toolCallId: 'toolu_read_1' as never,
    content: [{ type: 'text', text: 'fixture-value' }],
    isError: false,
    source: { kind: 'tool', callId: 'toolu_read_1' as never },
  }
}

const tools: ToolSchema[] = [
  {
    name: 'read',
    description: 'Read a known test fixture through DSH.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
]

const systemMessage: Message = {
  id: 'system' as never,
  role: 'system',
  content: [{ type: 'text', text: 'Use only DSH tools.' }],
  source: { kind: 'system-prompt' },
}

/** A DSH agent-loop request: the system prompt leads the derived history. */
function request(messages: Message[], signal?: AbortSignal): GenerateOptions {
  return {
    provider: 'claude-code',
    model: 'default',
    messages: [systemMessage, ...messages],
    tools,
    sessionId: 'tool-session' as never,
    ...(signal === undefined ? {} : { signal }),
  }
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

describe('DSH-owned MCP pause and resume', () => {
  it('executes one parked MCP call through DSH and resumes the same Claude query', async () => {
    const queries: ToolQuery[] = []
    const factory: ClaudeQueryFactory = (queryRequest) => {
      const query = new ToolQuery(queryRequest)
      queries.push(query)
      return query
    }
    const subprocess = {
      resolveExecutable: vi.fn(() => Promise.resolve('/usr/local/bin/claude')),
    } as unknown as SubprocessRuntime
    const config = resolveConfig()
    const manager = new BridgeManager(subprocess, config, factory)
    const adapter = new ClaudeCodeAdapter(config, manager)

    const first = await collect(adapter.stream(request([user()])))
    expect(first.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'tool-calls' },
      replayState: {
        response: { kind: 'dsh-claude-plugin/replay', phase: 'awaiting-tools' },
      },
    })
    expect(first.filter((chunk) => chunk.type === 'tool-call-delta')).not.toHaveLength(0)

    const second = await collect(adapter.stream(request([user(), assistantTool(), toolResult()])))
    expect(second.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: { response: { kind: 'dsh-claude-plugin/replay', phase: 'settled' } },
    })
    expect(
      second
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => chunk.text)
        .join(''),
    ).toBe('fixture-value')
    expect(queries).toHaveLength(1)
    expect(queries[0]?.inputs).toHaveLength(1)
    expect(queries[0]?.toolResults).toEqual([
      expect.objectContaining({ content: [{ type: 'text', text: 'fixture-value' }] }),
    ])
    expect(queries[0]?.request.options).toMatchObject({
      allowedTools: ['mcp__dsh__*'],
      tools: [],
      strictMcpConfig: true,
      settingSources: [],
      skills: [],
      plugins: [],
    })
    await manager.dispose()
    expect(queries[0]?.closed).toBe(true)
  })

  it('does not idle-evict a query while DSH owns its pending tool boundary', async () => {
    vi.useFakeTimers()
    try {
      const queries: ToolQuery[] = []
      const factory: ClaudeQueryFactory = (queryRequest) => {
        const query = new ToolQuery(queryRequest)
        queries.push(query)
        return query
      }
      const subprocess = {
        resolveExecutable: vi.fn(() => Promise.resolve('/usr/local/bin/claude')),
      } as unknown as SubprocessRuntime
      const config = resolveConfig({ sessionIdleMs: 100, toolRoundTripTimeoutMs: 1_000 })
      const manager = new BridgeManager(subprocess, config, factory)
      const adapter = new ClaudeCodeAdapter(config, manager)

      const first = await collect(adapter.stream(request([user()])))
      expect(first.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'tool-calls' },
      })
      await vi.advanceTimersByTimeAsync(101)
      expect(manager.activeBridgeCount).toBe(1)
      expect(queries[0]?.closed).toBe(false)

      const second = await collect(adapter.stream(request([user(), assistantTool(), toolResult()])))
      expect(second.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(queries).toHaveLength(1)
      await manager.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes a timed-out parked query and accepts a later clean session request', async () => {
    vi.useFakeTimers()
    try {
      const queries: ToolQuery[] = []
      const factory: ClaudeQueryFactory = (queryRequest) => {
        const query = new ToolQuery(queryRequest)
        queries.push(query)
        return query
      }
      const subprocess = {
        resolveExecutable: vi.fn(() => Promise.resolve('/usr/local/bin/claude')),
      } as unknown as SubprocessRuntime
      const config = resolveConfig({ sessionIdleMs: 1_000, toolRoundTripTimeoutMs: 100 })
      const manager = new BridgeManager(subprocess, config, factory)
      const adapter = new ClaudeCodeAdapter(config, manager)

      await collect(adapter.stream(request([user()])))
      expect(manager.activeBridgeCount).toBe(1)
      await vi.advanceTimersByTimeAsync(101)
      expect(manager.activeBridgeCount).toBe(0)
      expect(queries[0]?.closed).toBe(true)

      const recovered = await collect(adapter.stream(request([user()])))
      expect(recovered.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'tool-calls' },
      })
      expect(queries).toHaveLength(2)
      await manager.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels parked MCP handlers when the DSH continuation is aborted', async () => {
    const queries: ToolQuery[] = []
    const factory: ClaudeQueryFactory = (queryRequest) => {
      const query = new ToolQuery(queryRequest)
      queries.push(query)
      return query
    }
    const subprocess = {
      resolveExecutable: vi.fn(() => Promise.resolve('/usr/local/bin/claude')),
    } as unknown as SubprocessRuntime
    const config = resolveConfig()
    const manager = new BridgeManager(subprocess, config, factory)
    const adapter = new ClaudeCodeAdapter(config, manager)
    await collect(adapter.stream(request([user()])))
    const controller = new AbortController()
    controller.abort('cancelled')
    const chunks = await collect(
      adapter.stream(request([user(), assistantTool(), toolResult()], controller.signal)),
    )
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'aborted', failure: { code: 'CLAUDE_ABORTED' } },
    })
    expect(queries[0]?.closed).toBe(true)
    await manager.dispose()
  })

  it('fails explicitly instead of reconstructing a crashed in-flight MCP handler', async () => {
    const firstQueries: ToolQuery[] = []
    const firstFactory: ClaudeQueryFactory = (queryRequest) => {
      const query = new ToolQuery(queryRequest)
      firstQueries.push(query)
      return query
    }
    const subprocess = {
      resolveExecutable: vi.fn(() => Promise.resolve('/usr/local/bin/claude')),
    } as unknown as SubprocessRuntime
    const config = resolveConfig()
    const firstManager = new BridgeManager(subprocess, config, firstFactory)
    const firstAdapter = new ClaudeCodeAdapter(config, firstManager)
    const first = await collect(firstAdapter.stream(request([user()])))
    const finish = first.find((chunk) => chunk.type === 'finish')
    if (finish?.type !== 'finish') throw new Error('fixture expected a terminal tool boundary')
    expect(finish.replayState).toBeDefined()
    await firstManager.dispose()

    const coldFactory = vi.fn<ClaudeQueryFactory>((queryRequest) => new ToolQuery(queryRequest))
    const coldManager = new BridgeManager(subprocess, config, coldFactory)
    const coldAdapter = new ClaudeCodeAdapter(config, coldManager)
    const chunks = await collect(
      coldAdapter.stream(request([user(), assistantTool(finish.replayState), toolResult()])),
    )
    expect(chunks).toEqual([
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: expect.objectContaining({
            code: 'CLAUDE_IN_FLIGHT_RECOVERY_UNSUPPORTED',
          }),
        },
      },
    ])
    expect(coldFactory).not.toHaveBeenCalled()

    const recovered = await collect(coldAdapter.stream(request([user()])))
    expect(recovered.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'tool-calls' },
    })
    expect(coldFactory).toHaveBeenCalledOnce()
    await coldManager.dispose()
  })
})
