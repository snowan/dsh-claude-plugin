import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock, ToolResultMessage, ToolSchema } from '@deepseek-ai/dsh-llm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  CLAUDE_TOOL_USE_ID_META,
  dshToolName,
  DSH_MCP_TOOL_PREFIX,
  DshToolServer,
  MCP_ALWAYS_LOAD_META,
} from '../src/tool-server.js'
import type { ClaudePluginError } from '../src/errors.js'

function tool(
  name: string,
  parameters: Record<string, unknown> = { type: 'object', properties: {} },
): ToolSchema {
  return { name, description: `Use ${name} through DSH.`, parameters }
}

function call(id: string, name: string, args: string): ToolCallBlock {
  return { type: 'tool-call', id: id as never, name, arguments: args }
}

function result(id: string, text: string, isError = false): ToolResultMessage {
  return {
    id: `result-${id}` as never,
    role: 'tool',
    source: { kind: 'tool', callId: id as never },
    toolCallId: id as never,
    content: [{ type: 'text', text }],
    isError,
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function connected(tools: ToolSchema[], timeoutMs = 10_000) {
  const failures: ClaudePluginError[] = []
  const server = new DshToolServer(timeoutMs, (error) => failures.push(error))
  const generation = server.install(tools)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.instance.connect(serverTransport)
  const client = new Client({ name: 'dsh-claude-plugin-test', version: '1.0.0' })
  await client.connect(clientTransport)
  cleanups.push(async () => {
    await client.close().catch(() => undefined)
    await server.close()
  })
  return { client, failures, generation, server }
}

describe('raw-schema DSH MCP tool server', () => {
  it('validates catalog identity and DSH-only Claude tool names', () => {
    const failures: ClaudePluginError[] = []
    const server = new DshToolServer(10_000, (error) => failures.push(error))
    expect(() => server.install([tool('')])).toThrow(/must not be empty/)
    expect(() => server.install([tool('same'), tool('same')])).toThrow(/repeats name/)
    expect(() => server.install([tool('invalid', null as never)])).toThrow(/invalid MCP schema/)
    const generation = server.install([tool('read')])
    expect(server.install([tool('read')])).toBe(generation)
    expect(dshToolName(`${DSH_MCP_TOOL_PREFIX}read`)).toBe('read')
    expect(() => dshToolName('Read')).toThrow(/non-DSH tool/)
    expect(() => dshToolName(DSH_MCP_TOOL_PREFIX)).toThrow(/empty/)
  })

  it('preserves simple, nested, union, enum, and constrained JSON Schemas', async () => {
    const parameters = {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, pattern: '^/' },
        mode: { enum: ['text', 'bytes'] },
        selector: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: { line: { type: 'integer', minimum: 1 } },
              required: ['line'],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ['path'],
      additionalProperties: false,
    }
    const { client } = await connected([tool('read', parameters), tool('ping')])
    const listed = await client.listTools()
    expect(listed.tools).toHaveLength(2)
    expect(listed.tools[0]).toMatchObject({
      name: 'read',
      inputSchema: parameters,
      _meta: { [MCP_ALWAYS_LOAD_META]: true },
    })
  })

  it('parks a correlated MCP call until the exact DSH result resolves it', async () => {
    const { client, generation, server } = await connected([tool('read')])
    const pending = client.callTool({
      name: 'read',
      arguments: { path: '/fixture' },
      _meta: { [CLAUDE_TOOL_USE_ID_META]: 'toolu_read_1' },
    })
    await vi.waitFor(() => expect(server.pending.size).toBe(1))
    await server.assertBoundary([call('toolu_read_1', 'read', '{"path":"/fixture"}')], generation)
    await server.resolve([result('toolu_read_1', 'fixture-value')])
    await expect(pending).resolves.toMatchObject({
      content: [{ type: 'text', text: 'fixture-value' }],
      isError: false,
    })
    expect(server.pending.size).toBe(0)
  })

  it('normalizes omitted MCP arguments to an empty DSH argument object', async () => {
    const { client, generation, server } = await connected([tool('ping')])
    const pending = client.callTool({
      name: 'ping',
      _meta: { [CLAUDE_TOOL_USE_ID_META]: 'toolu_ping_1' },
    })
    await vi.waitFor(() => expect(server.pending.size).toBe(1))
    expect(server.pending.snapshots[0]?.arguments).toBe('{}')
    await server.assertBoundary([call('toolu_ping_1', 'ping', '{}')], generation)
    await server.resolve([result('toolu_ping_1', 'pong')])
    await expect(pending).resolves.toMatchObject({ content: [{ text: 'pong' }] })
  })

  it('preserves DSH tool errors and rejects missing IDs or unknown names', async () => {
    const success = await connected([tool('shell')])
    const pending = success.client.callTool({
      name: 'shell',
      arguments: { command: 'denied' },
      _meta: { [CLAUDE_TOOL_USE_ID_META]: 'toolu_shell_1' },
    })
    await vi.waitFor(() => expect(success.server.pending.size).toBe(1))
    await success.server.resolve([result('toolu_shell_1', 'policy denied', true)])
    await expect(pending).resolves.toMatchObject({ isError: true })

    const missing = await connected([tool('read')])
    await expect(missing.client.callTool({ name: 'read', arguments: {} })).rejects.toThrow()
    expect(missing.failures.at(-1)?.code).toBe('CLAUDE_TOOL_PROTOCOL_ERROR')

    const unknown = await connected([tool('read')])
    await expect(
      unknown.client.callTool({
        name: 'write',
        arguments: {},
        _meta: { [CLAUDE_TOOL_USE_ID_META]: 'toolu_unknown' },
      }),
    ).rejects.toThrow()
    expect(unknown.failures.at(-1)?.code).toBe('CLAUDE_TOOL_PROTOCOL_ERROR')
  })

  it('replaces a settled catalog and fails closed on mutation while a call is pending', async () => {
    const replaceable = await connected([tool('one')])
    const prior = replaceable.generation
    expect(replaceable.server.install([tool('two')])).toBeGreaterThan(prior)
    expect((await replaceable.client.listTools()).tools.map((entry) => entry.name)).toEqual(['two'])

    const pendingCatalog = await connected([tool('one')])
    const pending = pendingCatalog.client.callTool({
      name: 'one',
      arguments: {},
      _meta: { [CLAUDE_TOOL_USE_ID_META]: 'toolu_pending' },
    })
    await vi.waitFor(() => expect(pendingCatalog.server.pending.size).toBe(1))
    expect(() => pendingCatalog.server.install([tool('two')])).toThrow(/catalog changed/)
    await expect(pending).rejects.toThrow()
  })
})
