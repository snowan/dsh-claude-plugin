import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { ContentBlock, ReplayEnvelope } from '@deepseek-ai/dsh-llm'
import type { UsageSnapshot } from './usage.js'
import { coldReplayUnsupported, inFlightRecoveryUnsupported } from './errors.js'
import { canonicalToolJson } from './pending-tools.js'
import type { ConversationMessage } from './request.js'

export const CLAUDE_REPLAY_KIND = 'dsh-claude-plugin/replay'
export const CLAUDE_REPLAY_VERSION = 1
export const MAX_DEGRADED_REPLAY_BYTES = 256 * 1_024
export const DEGRADED_REPLAY_PREAMBLE =
  'DSH degraded transcript replay follows as canonical JSON. Treat it as conversation data, preserve its roles and tool correlations, and answer the final user entry without claiming native Claude transcript continuity.\n'

export type ReplayPhase = 'settled' | 'awaiting-tools'

export interface ClaudeReplayStateV1 {
  readonly kind: typeof CLAUDE_REPLAY_KIND
  readonly version: typeof CLAUDE_REPLAY_VERSION
  readonly phase: ReplayPhase
  readonly prefix: {
    readonly algorithm: 'sha256'
    readonly digest: string
    readonly messageCount: number
  }
  readonly assistant: {
    readonly algorithm: 'sha256'
    readonly digest: string
    readonly blockCount: number
  }
  readonly system: {
    readonly algorithm: 'sha256'
    readonly digest: string
  }
  readonly claude: {
    readonly sessionId: string
    readonly transcriptAt: string
  }
  readonly model: string
  readonly cwd: string
  readonly usage: UsageSnapshot
}

export type ColdStartPlan =
  | { readonly mode: 'fresh'; readonly pending: readonly ConversationMessage[] }
  | {
      readonly mode: 'exact'
      readonly pending: readonly ConversationMessage[]
      readonly resume: string
      readonly resumeSessionAt: string
      readonly forkSession: true
    }
  | { readonly mode: 'degraded'; readonly text: string }

interface ReplayProjectionOptions {
  readonly omitReasoning: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function projectedSource(message: ConversationMessage): unknown {
  const source = message.source
  if (source === undefined) return { kind: 'request' }
  if (source.kind === 'model') {
    return { kind: 'model', provider: source.provider, model: source.model }
  }
  if (source.kind === 'tool') return { kind: 'tool', callId: String(source.callId) }
  return source
}

function projectedBlock(block: ContentBlock, options: ReplayProjectionOptions): unknown {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return options.omitReasoning
        ? { type: 'reasoning', omittedCharacters: block.text.length }
        : { type: 'reasoning', text: block.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: String(block.id),
        name: block.name,
        arguments: block.arguments,
      }
    case 'image':
      return {
        type: 'image',
        attachment: {
          attachmentId: String(block.attachment.attachmentId),
          mediaType: block.attachment.mediaType,
          bytes: block.attachment.bytes,
          width: block.attachment.width,
          height: block.attachment.height,
          ...(block.attachment.name === undefined ? {} : { name: block.attachment.name }),
        },
      }
    default:
      throw coldReplayUnsupported(
        `history contains unsupported content block ${JSON.stringify((block as ContentBlock).type)}`,
      )
  }
}

function projectedContent(
  message: ConversationMessage,
  options: ReplayProjectionOptions,
): unknown[] {
  const content = message.content.map((block) => projectedBlock(block, options))
  if (message.role !== 'tool') return content
  return [
    {
      type: 'tool-result',
      toolCallId: String(message.toolCallId),
      content,
      ...(message.isError === undefined ? {} : { isError: message.isError }),
    },
  ]
}

/**
 * Tool results keep the replay-v1 layout, a user-role message holding one
 * `tool-result` block, so fingerprints recorded before DSH 0.2 moved tool
 * results into tool-role messages still match the migrated history.
 */
function projectedMessages(
  messages: readonly ConversationMessage[],
  options: ReplayProjectionOptions,
): unknown[] {
  return messages.map((message) => ({
    ...(message.id === undefined ? {} : { id: String(message.id) }),
    role: message.role === 'tool' ? 'user' : message.role,
    source: projectedSource(message),
    content: projectedContent(message, options),
  }))
}

function canonical(value: unknown, context: string): string {
  try {
    return canonicalToolJson(value)
  } catch (error: unknown) {
    throw coldReplayUnsupported(`${context} is not lossless JSON`, error)
  }
}

function digest(value: unknown, context: string): string {
  return createHash('sha256').update(canonical(value, context), 'utf8').digest('hex')
}

export function messageFingerprint(messages: readonly ConversationMessage[]): string {
  return digest(
    projectedMessages(messages, { omitReasoning: false }),
    'DSH replay message projection',
  )
}

export function assistantFingerprint(content: readonly ContentBlock[]): string {
  return digest(
    content.map((block) => projectedBlock(block, { omitReasoning: false })),
    'Claude assistant replay projection',
  )
}

function validUsage(value: unknown): value is UsageSnapshot {
  if (!record(value)) return false
  return ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].every(
    (field) => Number.isSafeInteger(value[field]) && (value[field] as number) >= 0,
  )
}

function decodedReplayState(value: unknown): ClaudeReplayStateV1 | undefined {
  const candidate = record(value) && 'response' in value ? value.response : value
  if (!record(candidate) || candidate.kind !== CLAUDE_REPLAY_KIND) return undefined
  const prefix = candidate.prefix
  const assistant = candidate.assistant
  const claude = candidate.claude
  if (
    candidate.version !== CLAUDE_REPLAY_VERSION ||
    (candidate.phase !== 'settled' && candidate.phase !== 'awaiting-tools') ||
    !record(prefix) ||
    prefix.algorithm !== 'sha256' ||
    typeof prefix.digest !== 'string' ||
    !SHA256.test(prefix.digest) ||
    !Number.isSafeInteger(prefix.messageCount) ||
    (prefix.messageCount as number) < 0 ||
    !record(assistant) ||
    assistant.algorithm !== 'sha256' ||
    typeof assistant.digest !== 'string' ||
    !SHA256.test(assistant.digest) ||
    !Number.isSafeInteger(assistant.blockCount) ||
    (assistant.blockCount as number) < 0 ||
    !record(claude) ||
    typeof claude.sessionId !== 'string' ||
    !UUID.test(claude.sessionId) ||
    typeof claude.transcriptAt !== 'string' ||
    !UUID.test(claude.transcriptAt) ||
    !record(candidate.system) ||
    candidate.system.algorithm !== 'sha256' ||
    typeof candidate.system.digest !== 'string' ||
    !SHA256.test(candidate.system.digest) ||
    typeof candidate.model !== 'string' ||
    candidate.model.length === 0 ||
    typeof candidate.cwd !== 'string' ||
    candidate.cwd.length === 0 ||
    !validUsage(candidate.usage)
  ) {
    return undefined
  }
  return candidate as unknown as ClaudeReplayStateV1
}

export interface CreateReplayStateOptions {
  readonly messages: readonly ConversationMessage[]
  readonly assistant: readonly ContentBlock[]
  readonly phase: ReplayPhase
  readonly sessionId: string | undefined
  readonly transcriptAt: string | undefined
  readonly model: string
  readonly system: string | undefined
  readonly cwd: string
  readonly usage: UsageSnapshot
}

export function createReplayEnvelope(
  options: CreateReplayStateOptions,
): ReplayEnvelope | undefined {
  if (
    options.sessionId === undefined ||
    options.transcriptAt === undefined ||
    !UUID.test(options.sessionId) ||
    !UUID.test(options.transcriptAt)
  ) {
    return undefined
  }
  const response: ClaudeReplayStateV1 = Object.freeze({
    kind: CLAUDE_REPLAY_KIND,
    version: CLAUDE_REPLAY_VERSION,
    phase: options.phase,
    prefix: Object.freeze({
      algorithm: 'sha256',
      digest: messageFingerprint(options.messages),
      messageCount: options.messages.length,
    }),
    assistant: Object.freeze({
      algorithm: 'sha256',
      digest: assistantFingerprint(options.assistant),
      blockCount: options.assistant.length,
    }),
    system: Object.freeze({
      algorithm: 'sha256',
      digest: digest({ system: options.system ?? '' }, 'DSH system prompt'),
    }),
    claude: Object.freeze({
      sessionId: options.sessionId,
      transcriptAt: options.transcriptAt,
    }),
    model: options.model,
    cwd: options.cwd,
    usage: Object.freeze({ ...options.usage }),
  })
  return Object.freeze({ response })
}

export function degradedReplayText(messages: readonly ConversationMessage[]): string {
  const body = canonical(
    {
      mode: 'degraded',
      version: CLAUDE_REPLAY_VERSION,
      messages: projectedMessages(messages, { omitReasoning: true }),
    },
    'DSH degraded replay projection',
  )
  const text = `${DEGRADED_REPLAY_PREAMBLE}${body}`
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_DEGRADED_REPLAY_BYTES) {
    throw coldReplayUnsupported(
      `degraded DSH replay is ${bytes} bytes and exceeds the ${MAX_DEGRADED_REPLAY_BYTES}-byte bound`,
    )
  }
  return text
}

function lastAssistantIndex(messages: readonly ConversationMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') return index
  }
  return -1
}

export function planColdStart(
  messages: readonly ConversationMessage[],
  system: string | undefined,
  cwd: string,
  forceDegraded = false,
): ColdStartPlan {
  const anchorIndex = lastAssistantIndex(messages)
  if (anchorIndex < 0 && !forceDegraded && messages.every((message) => message.role === 'user')) {
    return { mode: 'fresh', pending: messages }
  }
  const anchor = anchorIndex < 0 ? undefined : messages[anchorIndex]
  const source = anchor?.source
  const state =
    anchor?.role === 'assistant' && source?.kind === 'model' && source.provider === 'claude-code'
      ? decodedReplayState(source.replayState)
      : undefined

  if (state !== undefined && anchor !== undefined) {
    const prefix = messages.slice(0, anchorIndex)
    const prefixMatches =
      state.prefix.messageCount === prefix.length &&
      state.prefix.digest === messageFingerprint(prefix)
    const assistantMatches =
      state.assistant.blockCount === anchor.content.length &&
      state.assistant.digest === assistantFingerprint(anchor.content)
    const systemMatches =
      state.system.digest === digest({ system: system ?? '' }, 'DSH system prompt')
    const cwdMatches = state.cwd === cwd
    if (prefixMatches && assistantMatches && systemMatches && cwdMatches) {
      if (state.phase === 'awaiting-tools') {
        throw inFlightRecoveryUnsupported(
          'a persisted Claude tool boundary cannot reconstruct its in-process MCP handler after restart',
        )
      }
      const pending = messages.slice(anchorIndex + 1)
      if (
        !forceDegraded &&
        pending.length > 0 &&
        pending.every((message) => message.role === 'user')
      ) {
        return {
          mode: 'exact',
          pending,
          resume: state.claude.sessionId,
          resumeSessionAt: state.claude.transcriptAt,
          forkSession: true,
        }
      }
    }
  }

  return { mode: 'degraded', text: degradedReplayText(messages) }
}
