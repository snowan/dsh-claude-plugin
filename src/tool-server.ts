import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type {
  ToolCallBlock,
  ToolResultMessage,
  ToolSchema as DshToolSchema,
} from '@deepseek-ai/dsh-llm'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema as McpToolSchema,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js'
import { ClaudeContentEncoder } from './content.js'
import { toolProtocolError, type ClaudePluginError } from './errors.js'
import { canonicalToolJson, PendingTools } from './pending-tools.js'

export const DSH_MCP_SERVER_NAME = 'dsh'
export const DSH_MCP_TOOL_PREFIX = `mcp__${DSH_MCP_SERVER_NAME}__`
export const CLAUDE_TOOL_USE_ID_META = 'claudecode/toolUseId'
export const MCP_ALWAYS_LOAD_META = 'anthropic/alwaysLoad'

interface Catalog {
  readonly generation: number
  readonly fingerprint: string
  readonly tools: readonly McpTool[]
  readonly names: ReadonlySet<string>
}

function catalogTool(tool: DshToolSchema): McpTool {
  if (tool.name.length === 0) throw toolProtocolError('DSH tool name must not be empty')
  const inputSchema = JSON.parse(canonicalToolJson(tool.parameters)) as unknown
  const candidate = {
    name: tool.name,
    description: tool.description,
    inputSchema,
    _meta: { [MCP_ALWAYS_LOAD_META]: true },
  }
  const parsed = McpToolSchema.safeParse(candidate)
  if (!parsed.success) {
    throw toolProtocolError(`DSH tool ${JSON.stringify(tool.name)} has an invalid MCP schema`)
  }
  return Object.freeze(parsed.data)
}

function prepareCatalog(tools: readonly DshToolSchema[], generation: number): Catalog {
  const names = new Set<string>()
  const mapped = tools.map((tool) => {
    if (names.has(tool.name)) {
      throw toolProtocolError(`DSH tool catalog repeats name ${JSON.stringify(tool.name)}`)
    }
    names.add(tool.name)
    return catalogTool(tool)
  })
  return Object.freeze({
    generation,
    fingerprint: canonicalToolJson(mapped),
    tools: Object.freeze(mapped),
    names,
  })
}

/** One raw-schema SDK MCP server whose handlers pause for DSH-owned execution. */
export class DshToolServer {
  readonly instance = new McpServer(
    { name: 'dsh-claude-plugin', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } } },
  )
  readonly config: McpSdkServerConfigWithInstance = Object.freeze({
    type: 'sdk',
    name: DSH_MCP_SERVER_NAME,
    instance: this.instance,
  })
  readonly pending: PendingTools
  #catalog: Catalog = prepareCatalog([], 0)
  #closed = false

  constructor(
    timeoutMs: number,
    onFailure: (error: ClaudePluginError) => void,
    encoder = new ClaudeContentEncoder(),
  ) {
    this.pending = new PendingTools(timeoutMs, onFailure, encoder)
    this.instance.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...this.#catalog.tools],
    }))
    this.instance.server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
      if (this.#closed) throw toolProtocolError('DSH MCP tool server is closed')
      const name = request.params.name
      if (!this.#catalog.names.has(name)) {
        throw this.pending.fail(
          toolProtocolError(`Claude requested unknown DSH tool ${JSON.stringify(name)}`),
        )
      }
      const rawId = request.params._meta?.[CLAUDE_TOOL_USE_ID_META]
      if (typeof rawId !== 'string') {
        throw this.pending.fail(
          toolProtocolError('Claude MCP request omitted its provider tool-use ID'),
        )
      }
      return this.pending.register({
        id: rawId,
        name,
        arguments: request.params.arguments ?? {},
        generation: this.#catalog.generation,
        signal: extra.signal,
      })
    })
  }

  get generation(): number {
    return this.#catalog.generation
  }

  install(tools: readonly DshToolSchema[]): number {
    if (this.#closed) throw toolProtocolError('DSH MCP tool server is closed')
    const next = prepareCatalog(tools, this.#catalog.generation + 1)
    if (next.fingerprint === this.#catalog.fingerprint) return this.#catalog.generation
    if (this.pending.size > 0) {
      throw this.pending.fail(
        toolProtocolError('DSH tool catalog changed while Claude tool calls were pending'),
      )
    }
    this.#catalog = next
    if (this.instance.isConnected()) this.instance.sendToolListChanged()
    return next.generation
  }

  assertBoundary(
    calls: readonly ToolCallBlock[],
    generation: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.pending.assertBoundary(calls, generation, signal)
  }

  resolve(results: readonly ToolResultMessage[], signal?: AbortSignal): Promise<void> {
    return this.pending.resolveBatch(results, signal)
  }

  async close(error = toolProtocolError('DSH MCP tool server was closed')): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.pending.dispose(error)
    if (this.instance.isConnected()) await this.instance.close()
  }
}

export function dshToolName(claudeName: string): string {
  if (!claudeName.startsWith(DSH_MCP_TOOL_PREFIX)) {
    throw toolProtocolError(
      `Claude emitted non-DSH tool ${JSON.stringify(claudeName)} while native tools were disabled`,
    )
  }
  const name = claudeName.slice(DSH_MCP_TOOL_PREFIX.length)
  if (name.length === 0) throw toolProtocolError('Claude emitted an empty DSH MCP tool name')
  return name
}
