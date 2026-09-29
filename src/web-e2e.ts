export const WEB_E2E_SCHEMA_VERSION = 1
export const EXPECTED_CLAUDE_PROVIDER = 'claude-code'
export const EXPECTED_CLAUDE_MODEL = 'default'
export const EXPECTED_CLAUDE_ALIASES = ['default', 'sonnet', 'opus', 'haiku'] as const
export const EXPECTED_CLAUDE_EFFORTS = ['low', 'medium', 'high'] as const

export type JsonRecord = Readonly<Record<string, unknown>>

export interface RpcFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>
}

export interface ClaudeCatalogEvidence {
  readonly provider: typeof EXPECTED_CLAUDE_PROVIDER
  readonly selectedModel: typeof EXPECTED_CLAUDE_MODEL
  readonly routable: true
  readonly aliases: readonly string[]
  readonly reasoningEfforts: readonly string[]
}

export interface HistoryEvidence {
  readonly eventCount: number
  readonly maxSeq: number
  readonly eventTypes: readonly string[]
  readonly assistantMessageCount: number
  readonly assistantTextCharacters: number
  readonly toolCalls: readonly string[]
  readonly toolResultCount: number
  readonly turnEndKinds: readonly string[]
}

export class DshRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly remoteMessage: string,
  ) {
    super(`${method} failed: ${code}`)
    this.name = 'DshRpcError'
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function requiredArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

/** The loopback origin DSH Web serves and the launch URL that authenticates a browser. */
export interface DshWebLaunch {
  readonly origin: string
  /** Carries DSH's one-time `token` query; keep it out of reports. */
  readonly launchUrl: string
}

/**
 * Accept only the loopback launch URL printed by the isolated `dsh web` child.
 * DSH 0.2 appends a `token` query that exchanges for its browser-session cookie.
 * @param output - the child's accumulated stdout and stderr.
 * @returns the origin and launch URL, or `undefined` before the ready line.
 */
export function parseDshWebLaunch(output: string): DshWebLaunch | undefined {
  const match = /dsh web: ([^\s]+)/u.exec(output)
  if (match?.[1] === undefined) return undefined
  const url = new URL(match[1])
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username !== '') {
    throw new Error('dsh web readiness URL must use unauthenticated HTTP on 127.0.0.1')
  }
  const tokens = url.searchParams.getAll('token')
  const onlyToken = [...url.searchParams.keys()].every((key) => key === 'token')
  if (
    url.password !== '' ||
    url.pathname !== '/' ||
    url.hash !== '' ||
    !onlyToken ||
    tokens.length > 1 ||
    tokens[0] === ''
  ) {
    throw new Error('dsh web readiness URL must be a loopback origin with at most one token')
  }
  if (url.port === '') throw new Error('dsh web readiness URL must include an assigned port')
  return { origin: url.origin, launchUrl: url.href }
}

/** Accept only the loopback URL printed by the isolated `dsh web` child. */
export function parseDshReadyUrl(output: string): string | undefined {
  return parseDshWebLaunch(output)?.origin
}

/**
 * Exchange the DSH Web launch token for its browser-session cookie. A launch
 * URL without a token, as printed by DSH releases that do not authenticate
 * browsers, returns the unchanged fetcher.
 * @param fetcher - the underlying fetch implementation.
 * @param launchUrl - the launch URL from {@link parseDshWebLaunch}.
 * @returns a fetcher that sends the session cookie with every request.
 */
export async function authenticateDshWeb(fetcher: RpcFetch, launchUrl: string): Promise<RpcFetch> {
  if (!new URL(launchUrl).searchParams.has('token')) return fetcher
  const response = await fetcher(launchUrl, { redirect: 'manual' })
  const cookies = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';', 1)[0]?.trim() ?? '')
    .filter((entry) => entry.length > 0)
  if (response.status !== 303 || cookies.length === 0) {
    throw new Error(`DSH Web authentication failed over HTTP ${String(response.status)}`)
  }
  const cookie = cookies.join('; ')
  return (input, init = {}) => {
    const headers = new Headers(init.headers)
    headers.set('cookie', cookie)
    return fetcher(input, { ...init, headers })
  }
}

/**
 * Call one public DSH Remote unary method and fail with its stable error code.
 * @param fetcher - an authenticated fetcher from {@link authenticateDshWeb}.
 * @param baseUrl - the loopback origin.
 * @param method - the `<namespace>/<method>` Remote endpoint.
 * @param args - the named Remote arguments, keyed by the Host method's parameter names.
 * @param rpcId - the Connection RPC identity.
 * @returns the successful Remote value.
 */
export async function dshRpc<T>(
  fetcher: RpcFetch,
  baseUrl: string,
  method: string,
  args: JsonRecord,
  rpcId: string = crypto.randomUUID(),
): Promise<T> {
  if (!/^[a-z][A-Za-z]*\/[a-z][A-Za-z]*$/u.test(method)) {
    throw new Error('DSH RPC method has an invalid shape')
  }
  const origin = parseDshReadyUrl(`dsh web: ${baseUrl}`)
  if (origin === undefined) throw new Error('DSH RPC origin is missing')
  const response = await fetcher(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  })
  if (!response.ok) throw new Error(`${method} failed over HTTP ${String(response.status)}`)
  const body = requiredRecord(await response.json(), `${method} response`)
  const result = requiredRecord(body.result, `${method} result`)
  if (result.ok === true) return result.value as T
  if (result.ok !== false) throw new Error(`${method} result has no boolean ok discriminator`)
  const error = requiredRecord(result.error, `${method} error`)
  throw new DshRpcError(
    method,
    requiredString(error.code, `${method} error code`),
    requiredString(error.message, `${method} error message`),
  )
}

/** Validate the exact model route the installed Web profile must expose in `session/modelCatalog`. */
export function inspectClaudeCatalog(value: unknown): ClaudeCatalogEvidence {
  const response = requiredRecord(value, 'session/modelCatalog value')
  const selected = requiredRecord(response.default, 'session/modelCatalog default')
  if (selected.provider !== EXPECTED_CLAUDE_PROVIDER || selected.model !== EXPECTED_CLAUDE_MODEL) {
    throw new Error('session/modelCatalog did not default to claude-code/default')
  }
  if (
    !requiredArray(response.routableProviders, 'routable providers').includes(
      EXPECTED_CLAUDE_PROVIDER,
    )
  ) {
    throw new Error('claude-code/default is not routable')
  }
  const groups = requiredArray(response.groups, 'session/modelCatalog groups').map((entry, index) =>
    requiredRecord(entry, `session/modelCatalog groups[${String(index)}]`),
  )
  const group = groups.find((entry) => entry.id === EXPECTED_CLAUDE_PROVIDER)
  if (group === undefined) {
    throw new Error('session/modelCatalog omitted the Claude Code provider group')
  }
  if (group.name !== 'Claude Code') throw new Error('Claude Code provider label changed')
  const models = requiredArray(group.models, 'Claude Code models').map((entry, index) =>
    requiredRecord(entry, `Claude Code models[${String(index)}]`),
  )
  const aliases = models.map((entry, index) =>
    requiredString(entry.id, `Claude Code models[${String(index)}].id`),
  )
  if (JSON.stringify(aliases) !== JSON.stringify(EXPECTED_CLAUDE_ALIASES)) {
    throw new Error('Claude Code model aliases changed')
  }
  const defaultModel = models[0]
  if (defaultModel === undefined) throw new Error('Claude Code default model is missing')
  const reasoning = requiredRecord(defaultModel.reasoning, 'Claude Code default reasoning')
  const efforts = requiredArray(reasoning.efforts, 'Claude Code default reasoning efforts').map(
    (entry, index) =>
      requiredString(
        requiredRecord(entry, `Claude reasoning efforts[${String(index)}]`).id,
        `Claude reasoning efforts[${String(index)}].id`,
      ),
  )
  if (JSON.stringify(efforts) !== JSON.stringify(EXPECTED_CLAUDE_EFFORTS)) {
    throw new Error('Claude Code reasoning efforts changed')
  }
  return Object.freeze({
    provider: EXPECTED_CLAUDE_PROVIDER,
    selectedModel: EXPECTED_CLAUDE_MODEL,
    routable: true,
    aliases: Object.freeze(aliases),
    reasoningEfforts: Object.freeze(efforts),
  })
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .flatMap((entry) => {
      if (!isRecord(entry) || entry.type !== 'text' || typeof entry.text !== 'string') return []
      return [entry.text]
    })
    .join('')
}

function messageContent(data: JsonRecord): unknown {
  if (isRecord(data.message)) return data.message.content
  return data.content
}

function historyEvents(value: unknown): JsonRecord[] {
  const page = requiredRecord(value, 'session/page value')
  return requiredArray(page.records, 'session/page records').map((entry, index) =>
    requiredRecord(requiredRecord(entry, `history record ${String(index)}`).event, 'history event'),
  )
}

/** Count marker-bearing assistant messages without reading tool payloads. */
export function historyAssistantMarkerCount(value: unknown, marker: string): number {
  return historyEvents(value).filter((event) => {
    if (event.type !== 'assistant/message') return false
    return contentText(
      messageContent(requiredRecord(event.data, 'assistant message data')),
    ).includes(marker)
  }).length
}

/** Read only marker text from assistant messages; tool payloads remain opaque. */
export function historyHasAssistantMarker(value: unknown, marker: string): boolean {
  return historyAssistantMarkerCount(value, marker) > 0
}

/** Read marker text only from the correlated tool-role result message content. */
export function historyHasToolResultMarker(value: unknown, marker: string): boolean {
  return historyEvents(value).some((event) => {
    if (event.type !== 'tool/result') return false
    const data = requiredRecord(event.data, 'tool result data')
    const message = requiredRecord(data.message, 'tool result message')
    return contentText(message.content).includes(marker)
  })
}

/** Produce bounded, payload-free history evidence for reports and assertions. */
export function summarizeHistory(value: unknown): HistoryEvidence {
  const events = historyEvents(value)
  const eventTypes = [...new Set(events.map((event) => requiredString(event.type, 'event type')))]
  const sequences = events.map((event) =>
    typeof event.seq === 'number' && Number.isInteger(event.seq) ? event.seq : -1,
  )
  const toolCalls = events.flatMap((event) => {
    if (event.type !== 'tool/call' || !isRecord(event.data)) return []
    return typeof event.data.name === 'string' ? [event.data.name] : []
  })
  const turnEndKinds = events.flatMap((event) => {
    if (event.type !== 'turn/end' || !isRecord(event.data) || !isRecord(event.data.reason)) {
      return []
    }
    return typeof event.data.reason.kind === 'string' ? [event.data.reason.kind] : []
  })
  const assistantTextCharacters = events.reduce((total, event) => {
    if (event.type !== 'assistant/message') return total
    const data = requiredRecord(event.data, 'assistant message data')
    return total + contentText(messageContent(data)).length
  }, 0)
  return Object.freeze({
    eventCount: events.length,
    maxSeq: sequences.length === 0 ? -1 : Math.max(...sequences),
    eventTypes: Object.freeze(eventTypes),
    assistantMessageCount: events.filter((event) => event.type === 'assistant/message').length,
    assistantTextCharacters,
    toolCalls: Object.freeze(toolCalls),
    toolResultCount: events.filter((event) => event.type === 'tool/result').length,
    turnEndKinds: Object.freeze(turnEndKinds),
  })
}

/** Extract a stable failure category without copying prompts, paths, or remote text. */
export function stableFailureCode(error: unknown): string {
  if (error instanceof DshRpcError) {
    return `RPC_${error.code.toUpperCase().replaceAll(/[-/]/gu, '_')}`
  }
  if (isRecord(error) && typeof error.code === 'string' && /^[A-Z0-9_-]{1,64}$/u.test(error.code)) {
    return error.code
  }
  return 'UNEXPECTED'
}
