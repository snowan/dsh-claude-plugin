import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import { BridgeManager, defaultQueryFactory } from './bridge.js'
import { claudeGenerateOptions } from './request.js'
import { ClaudeDiagnostics } from './diagnostics.js'
import {
  abortError,
  ClaudePluginError,
  invalidConfig,
  protocolError,
  transportError,
} from './errors.js'
import {
  modelCatalog,
  PROVIDER_ID,
  PROVIDER_NAME,
  resolvedModelInfo,
  resolveClaudeModel,
  validateModelId,
} from './models.js'

export * from './errors.js'
export * from './models.js'
export * from './bridge.js'
export * from './content.js'
export * from './diagnostics.js'
export * from './doctor.js'
export * from './input.js'
export * from './output.js'
export * from './process.js'
export * from './replay.js'
export * from './request.js'
export * from './pending-tools.js'
export * from './tool-server.js'
export * from './usage.js'
export * from './json.js'
export * from './profile-verifier.js'

export const name = 'dsh-claude-plugin'
export const inject = ['llm', 'subprocess', 'attachments']

export const DEFAULT_CLAUDE_COMMAND = 'claude'
export const DEFAULT_EXECUTABLE_POLICY = 'host-only'
export const DEFAULT_MODEL = 'sonnet'
export const DEFAULT_SESSION_IDLE_MS = 15 * 60 * 1_000
export const DEFAULT_TOOL_ROUND_TRIP_TIMEOUT_MS = 30 * 60 * 1_000
export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000
export const MAX_TIMER_DELAY_MS = 2_147_483_647

export const EXECUTABLE_POLICIES = ['host-only', 'host-then-bundled', 'bundled-only'] as const

export type ExecutablePolicy = (typeof EXECUTABLE_POLICIES)[number]

export interface Config {
  claudeCommand?: string
  executablePolicy?: ExecutablePolicy
  defaultModel?: string
  sessionIdleMs?: number
  toolRoundTripTimeoutMs?: number
  shutdownGraceMs?: number
  passEnv?: string[]
  debug?: boolean
}

export const Config: z<Config> = z.object({
  claudeCommand: z.string().min(1).default(DEFAULT_CLAUDE_COMMAND),
  executablePolicy: z.union([...EXECUTABLE_POLICIES]).default(DEFAULT_EXECUTABLE_POLICY),
  defaultModel: z.string().min(1).default(DEFAULT_MODEL),
  sessionIdleMs: z
    .number()
    .min(Number.MIN_VALUE)
    .max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_SESSION_IDLE_MS),
  toolRoundTripTimeoutMs: z
    .number()
    .min(Number.MIN_VALUE)
    .max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_TOOL_ROUND_TRIP_TIMEOUT_MS),
  shutdownGraceMs: z
    .number()
    .min(Number.MIN_VALUE)
    .max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_SHUTDOWN_GRACE_MS),
  passEnv: z.array(z.string()).default([]),
  debug: z.boolean().default(false),
})

export interface ResolvedConfig {
  readonly claudeCommand: string
  readonly executablePolicy: ExecutablePolicy
  readonly defaultModel: string
  readonly sessionIdleMs: number
  readonly toolRoundTripTimeoutMs: number
  readonly shutdownGraceMs: number
  readonly passEnv: readonly string[]
  readonly debug: boolean
}

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'unknown validation error'
}

function validateCommand(command: string): string {
  if (command !== command.trim() || command.includes('\u0000')) {
    throw invalidConfig('claudeCommand must contain no surrounding whitespace or NUL bytes')
  }
  if ((command.includes('/') || command.includes('\\')) && !isAbsolute(command)) {
    throw invalidConfig('claudeCommand must be an absolute path or a bare executable name')
  }
  return command
}

function validatePassEnv(entries: readonly string[]): readonly string[] {
  if (entries.length > 64) throw invalidConfig('passEnv may contain at most 64 names')
  const seen = new Set<string>()
  const checked = entries.map((entry, index) => {
    if (!ENVIRONMENT_NAME.test(entry)) {
      throw invalidConfig(`passEnv[${index}] must be a portable environment-variable name`)
    }
    const folded = entry.toUpperCase()
    if (folded.startsWith('DSH_') || SENSITIVE_ENV_PATTERN.test(entry)) {
      throw invalidConfig(`passEnv[${index}] is security-sensitive and cannot be forwarded`)
    }
    if (seen.has(folded)) {
      throw invalidConfig(`passEnv contains duplicate name ${JSON.stringify(entry)}`)
    }
    seen.add(folded)
    return entry
  })
  return Object.freeze(checked)
}

export function resolveConfig(input: Config = {}): ResolvedConfig {
  let parsed: Required<Config>
  try {
    parsed = Config(input) as Required<Config>
  } catch (error: unknown) {
    throw invalidConfig(`configuration schema validation failed: ${errorMessage(error)}`, error)
  }

  let defaultModel: string
  try {
    defaultModel = validateModelId(parsed.defaultModel, 'defaultModel')
    resolveClaudeModel('default', defaultModel)
  } catch (error: unknown) {
    throw invalidConfig(`defaultModel is invalid: ${errorMessage(error)}`, error)
  }
  const resolved: ResolvedConfig = {
    claudeCommand: validateCommand(parsed.claudeCommand),
    executablePolicy: parsed.executablePolicy,
    defaultModel,
    sessionIdleMs: parsed.sessionIdleMs,
    toolRoundTripTimeoutMs: parsed.toolRoundTripTimeoutMs,
    shutdownGraceMs: parsed.shutdownGraceMs,
    passEnv: validatePassEnv(parsed.passEnv),
    debug: parsed.debug,
  }
  return Object.freeze(resolved)
}

function normalizeTransportFailure(error: unknown, signal?: AbortSignal): ClaudePluginError {
  if (error instanceof ClaudePluginError) return error
  if (signal?.aborted === true) return abortError(error)
  return transportError('unexpected Claude transport failure', error)
}

/** Provider metadata and managed Claude Agent SDK stream entry point. */
export class ClaudeCodeAdapter extends LlmAdapter {
  constructor(
    readonly config: ResolvedConfig,
    readonly bridges: BridgeManager,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    if (provider !== PROVIDER_ID) return super.providerInfo(provider)
    return { id: PROVIDER_ID, name: PROVIDER_NAME }
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(modelCatalog(this.config.defaultModel))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(resolvedModelInfo(provider, model, this.config.defaultModel))
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const model = resolveClaudeModel(options.model, this.config.defaultModel)
    let finished = false
    try {
      for await (const chunk of this.bridges.stream(claudeGenerateOptions(options), model)) {
        if (chunk.type === 'finish') finished = true
        yield chunk
      }
      if (!finished) throw protocolError('Claude bridge completed without a terminal finish')
    } catch (error: unknown) {
      if (finished) return
      const normalized = normalizeTransportFailure(error, options.signal)
      yield {
        type: 'finish',
        reason:
          normalized.code === 'CLAUDE_ABORTED'
            ? { kind: 'aborted', failure: normalized.failure }
            : { kind: 'error', failure: normalized.failure },
      }
    }
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const bridges = new BridgeManager(
    ctx.subprocess,
    resolved,
    defaultQueryFactory,
    ctx.attachments,
    new ClaudeDiagnostics(resolved.debug, ctx.logger(name)),
  )
  ctx.effect(() => () => bridges.dispose(), 'dsh-claude-plugin: bridge teardown')
  ctx.llm.registerAdapter([PROVIDER_ID], new ClaudeCodeAdapter(resolved, bridges))
}
