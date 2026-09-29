import { cwd as processCwd } from 'node:process'
import {
  query as sdkQuery,
  type Options as ClaudeSdkOptions,
  type EffortLevel,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from './index.js'
import { AsyncQueue } from './async-queue.js'
import { type AttachmentReader, ClaudeContentEncoder } from './content.js'
import { ClaudeDiagnostics } from './diagnostics.js'
import { abortError, ClaudePluginError, protocolError, transportError } from './errors.js'
import {
  assertSdkUserInput,
  type ClaudeStartPlan,
  LiveInputCursor,
  type PrepareStepOptions,
} from './input.js'
import { ClaudeOutputTranslator } from './output.js'
import { ClaudeProcessFactory, resolveClaudeExecutable, sdkEnvironment } from './process.js'
import { createReplayEnvelope } from './replay.js'
import type { ClaudeGenerateOptions } from './request.js'
import { resolveClaudeEffort } from './models.js'
import { DSH_MCP_SERVER_NAME, DshToolServer } from './tool-server.js'
import { UsageTracker, type UsageSnapshot, type UsageTelemetryDelta } from './usage.js'

export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  setModel(model: string): Promise<void>
  applyFlagSettings(settings: { effortLevel?: EffortLevel | null }): Promise<void>
  interrupt(): Promise<unknown>
  close(): void
}

export interface ClaudeQueryRequest {
  readonly prompt: AsyncIterable<SDKUserMessage>
  readonly options: ClaudeSdkOptions
}

export type ClaudeQueryFactory = (request: ClaudeQueryRequest) => ClaudeQuery

export const defaultQueryFactory: ClaudeQueryFactory = (request) => sdkQuery(request) as Query

class AsyncMutex {
  #tail: Promise<void> = Promise.resolve()

  async acquire(): Promise<() => void> {
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const prior = this.#tail
    this.#tail = prior.then(() => current)
    await prior
    return release
  }
}

class SessionBridge {
  readonly #input = new AsyncQueue<SDKUserMessage>()
  readonly #output = new AsyncQueue<SDKMessage>()
  readonly #cursor: LiveInputCursor
  readonly #usage = new UsageTracker()
  readonly #mutex = new AsyncMutex()
  readonly #abortController = new AbortController()
  readonly #toolServer: DshToolServer
  #query: ClaudeQuery | undefined
  #pump: Promise<void> | undefined
  #system: string | undefined
  #model: string | undefined
  #effort: EffortLevel | undefined
  #closed = false
  #phase: 'idle' | 'generating' | 'awaiting-tools' | 'closed' = 'idle'
  #lastUsedAt = Date.now()

  constructor(
    readonly subprocess: SubprocessRuntime,
    readonly processFactory: ClaudeProcessFactory,
    readonly config: ResolvedConfig,
    readonly queryFactory: ClaudeQueryFactory,
    readonly onClosed: (bridge: SessionBridge) => void,
    attachments?: AttachmentReader,
  ) {
    const encoder = new ClaudeContentEncoder(attachments)
    this.#cursor = new LiveInputCursor(encoder)
    this.#toolServer = new DshToolServer(
      config.toolRoundTripTimeoutMs,
      (error) => this.#invalidate(error),
      encoder,
    )
  }

  get closed(): boolean {
    return this.#closed
  }

  get evictable(): boolean {
    return this.#phase === 'idle'
  }

  get lastUsedAt(): number {
    return this.#lastUsedAt
  }

  get usageSnapshot(): UsageSnapshot {
    return this.#usage.snapshot
  }

  get usageTelemetryDelta(): UsageTelemetryDelta {
    return this.#usage.telemetryDelta
  }

  async #start(
    model: string,
    system: string | undefined,
    start: ClaudeStartPlan,
    effort: EffortLevel | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const executable = await resolveClaudeExecutable(
      this.subprocess,
      this.config.claudeCommand,
      this.config.executablePolicy,
      signal,
    )
    const options: ClaudeSdkOptions = {
      abortController: this.#abortController,
      allowedTools: [`mcp__${DSH_MCP_SERVER_NAME}__*`],
      cwd: processCwd(),
      env: sdkEnvironment(this.config.passEnv),
      hooks: {},
      includePartialMessages: true,
      managedSettings: { disableAllHooks: true },
      mcpServers: { [DSH_MCP_SERVER_NAME]: this.#toolServer.config },
      model,
      ...(effort === undefined ? {} : { effort }),
      permissionMode: 'dontAsk',
      persistSession: true,
      plugins: [],
      settings: { disableAllHooks: true },
      settingSources: [],
      skills: [],
      spawnClaudeCodeProcess: this.processFactory.spawn,
      strictMcpConfig: true,
      systemPrompt: system ?? '',
      tools: [],
      ...(start.mode === 'exact'
        ? {
            resume: start.resume,
            resumeSessionAt: start.resumeSessionAt,
            forkSession: start.forkSession,
          }
        : {}),
      ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }),
    }
    this.#query = this.queryFactory({ prompt: this.#input, options })
    this.#model = model
    this.#effort = effort
    this.#system = system
    this.#pump = this.#pumpOutput(this.#query)
  }

  async #pumpOutput(query: ClaudeQuery): Promise<void> {
    try {
      for await (const message of query) this.#output.push(message)
      if (this.#closed) this.#output.close()
      else this.#invalidate(transportError('Claude SDK query ended unexpectedly'))
    } catch (error: unknown) {
      if (!this.#closed) {
        this.#invalidate(transportError('Claude SDK query failed unexpectedly', error))
      }
    }
  }

  #invalidate(error: unknown): void {
    if (this.#closed) return
    this.#closed = true
    this.#phase = 'closed'
    this.#output.fail(error)
    this.#input.fail(error)
    this.#abortController.abort(error)
    this.#query?.close()
    void this.#toolServer.close(
      error instanceof Error ? protocolError(error.message, error) : protocolError('bridge closed'),
    )
    this.onClosed(this)
  }

  async *stream(
    options: ClaudeGenerateOptions,
    model: string,
    control: PrepareStepOptions = {},
  ): AsyncIterable<StreamChunk> {
    const release = await this.#mutex.acquire()
    let committed = false
    const onAbort = () => this.#invalidate(abortError(options.signal?.reason))
    try {
      if (this.#closed) throw transportError('Claude session bridge is closed')
      if (options.signal?.aborted === true) throw abortError(options.signal.reason)
      const effort = resolveClaudeEffort(options.reasoningEffort)
      const plan = await this.#cursor.prepareStep(options, control)
      if (plan.kind === 'tool-results' && this.#phase !== 'awaiting-tools') {
        throw protocolError('DSH supplied tool results while Claude was not awaiting tools')
      }
      if (plan.kind === 'prompt' && this.#phase === 'awaiting-tools') {
        throw protocolError('DSH supplied a new prompt while Claude was awaiting tool results')
      }
      const toolGeneration = this.#toolServer.install(options.tools ?? [])
      if (this.#query === undefined) {
        if (plan.kind !== 'prompt' || plan.start === undefined) {
          throw protocolError('a new Claude query requires an explicit cold-start plan')
        }
        await this.#start(model, options.system, plan.start, effort, options.signal)
      } else {
        if (plan.kind === 'prompt' && plan.start !== undefined) {
          throw protocolError('a live Claude query received a second cold-start plan')
        }
        if (this.#system !== options.system) {
          throw protocolError('DSH system prompt changed inside a live Claude query')
        }
        if (this.#model !== model) {
          await this.#query.setModel(model)
          this.#model = model
        }
        if (this.#effort !== effort) {
          await this.#query.applyFlagSettings({ effortLevel: effort ?? null })
          this.#effort = effort
        }
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.#phase = 'generating'
      if (plan.kind === 'prompt') {
        for (const message of plan.messages) {
          assertSdkUserInput(message)
          this.#input.push(message)
        }
      } else {
        await this.#toolServer.resolve(plan.results, options.signal)
      }

      const translator = new ClaudeOutputTranslator(this.#usage)
      while (!translator.complete) {
        const next = await this.#output.next()
        if (next.done) throw protocolError('Claude SDK output ended before a result message')
        const translated = translator.accept(next.value)
        if (
          translator.complete &&
          translator.terminalReason?.kind === 'error' &&
          plan.kind === 'prompt' &&
          plan.start?.mode === 'exact' &&
          translator.outputBlocks.length === 0
        ) {
          throw transportError('Claude exact resume failed before observable output')
        }
        for (const chunk of translated) {
          if (chunk.type === 'finish' && chunk.reason.kind === 'tool-calls') {
            await this.#toolServer.assertBoundary(
              translator.toolCalls,
              toolGeneration,
              options.signal,
            )
          }
          if (
            chunk.type === 'finish' &&
            (chunk.reason.kind === 'stop' ||
              chunk.reason.kind === 'tool-calls' ||
              chunk.reason.kind === 'max-tokens')
          ) {
            const blocks = translator.outputBlocks
            const replayState = createReplayEnvelope({
              messages: options.messages,
              assistant: blocks,
              phase: chunk.reason.kind === 'tool-calls' ? 'awaiting-tools' : 'settled',
              sessionId: translator.sessionId,
              transcriptAt: translator.lastAssistantUuid,
              model,
              system: options.system,
              cwd: processCwd(),
              usage: this.#usage.snapshot,
            })
            this.#cursor.commit(options.messages, { model: options.model, content: blocks })
            this.#phase = chunk.reason.kind === 'tool-calls' ? 'awaiting-tools' : 'idle'
            this.#lastUsedAt = Date.now()
            committed = true
            yield replayState === undefined ? chunk : { ...chunk, replayState }
          } else {
            yield chunk
          }
        }
      }
      if (translator.terminalReason?.kind === 'error') {
        committed = true
        this.#invalidate(transportError('Claude turn ended with a terminal provider error'))
        return
      }
      if (!committed) throw protocolError('Claude completed without a committable terminal result')
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      if (!committed && !this.#closed) {
        this.#invalidate(
          protocolError('Claude generation ended before its DSH prefix was committed'),
        )
      }
      release()
    }
  }

  async dispose(): Promise<void> {
    this.#invalidate(transportError('Claude session bridge was disposed'))
    try {
      await this.#pump
    } catch {
      // The output queue already carries the transport failure to the active request.
    }
    await this.#toolServer.close()
  }
}

function retryableBeforeObservation(error: unknown): boolean {
  return !(error instanceof ClaudePluginError) || error.code === 'CLAUDE_TRANSPORT_ERROR'
}

function bridgeKey(options: ClaudeGenerateOptions): string | undefined {
  if (options.sessionId === undefined) return undefined
  return `${String(options.sessionId)}\u0000${options.purpose ?? 'conversation'}`
}

/** Owns independent live SDK queries keyed by DSH session and request purpose. */
export class BridgeManager {
  readonly #bridges = new Map<string, SessionBridge>()
  readonly #evictionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly processFactory: ClaudeProcessFactory
  #evictionFailure: unknown
  #disposed = false

  constructor(
    readonly subprocess: SubprocessRuntime,
    readonly config: ResolvedConfig,
    readonly queryFactory: ClaudeQueryFactory = defaultQueryFactory,
    readonly attachments?: AttachmentReader,
    readonly diagnostics = new ClaudeDiagnostics(config.debug),
  ) {
    this.processFactory = new ClaudeProcessFactory(subprocess, config)
  }

  get activeBridgeCount(): number {
    return this.#bridges.size
  }

  #newBridge(key: string | undefined): SessionBridge {
    return new SessionBridge(
      this.subprocess,
      this.processFactory,
      this.config,
      this.queryFactory,
      (closed) => {
        if (key !== undefined && this.#bridges.get(key) === closed) {
          this.#bridges.delete(key)
          this.#cancelEviction(key)
        }
      },
      this.attachments,
    )
  }

  #cancelEviction(key: string): void {
    const timer = this.#evictionTimers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    this.#evictionTimers.delete(key)
  }

  async #evict(key: string, bridge: SessionBridge): Promise<void> {
    this.#evictionTimers.delete(key)
    if (this.#bridges.get(key) !== bridge || !bridge.evictable) return
    this.#bridges.delete(key)
    try {
      await bridge.dispose()
    } catch (error: unknown) {
      this.#evictionFailure ??= error
    }
  }

  #scheduleEviction(key: string, bridge: SessionBridge): void {
    this.#cancelEviction(key)
    if (!bridge.evictable || this.#bridges.get(key) !== bridge) return
    const delay = Math.max(0, bridge.lastUsedAt + this.config.sessionIdleMs - Date.now())
    const timer = setTimeout(() => void this.#evict(key, bridge), delay)
    timer.unref?.()
    this.#evictionTimers.set(key, timer)
  }

  async #remove(key: string | undefined, bridge: SessionBridge): Promise<void> {
    if (key !== undefined && this.#bridges.get(key) === bridge) {
      this.#bridges.delete(key)
      this.#cancelEviction(key)
    }
    await bridge.dispose()
  }

  async *stream(options: ClaudeGenerateOptions, model: string): AsyncIterable<StreamChunk> {
    if (this.#disposed) throw transportError('Claude bridge manager is disposed')
    if (this.#evictionFailure !== undefined) {
      throw transportError('Claude idle bridge cleanup failed', this.#evictionFailure)
    }
    const key = bridgeKey(options)
    const diagnostic = this.diagnostics.begin(options, model)
    let diagnosticFinished = false
    const ephemeral = key === undefined
    if (key !== undefined) this.#cancelEviction(key)
    let bridge = key === undefined ? undefined : this.#bridges.get(key)
    if (bridge === undefined || bridge.closed) {
      bridge = this.#newBridge(key)
      if (key !== undefined) this.#bridges.set(key, bridge)
    }
    let attempt = 0
    try {
      while (true) {
        let observed = false
        diagnostic.attempt(attempt + 1, attempt === 0 ? 'planned' : 'retry-degraded')
        try {
          for await (const chunk of bridge.stream(options, model, {
            forceDegraded: attempt > 0,
          })) {
            observed = true
            if (chunk.type === 'finish') {
              diagnostic.finish(chunk.reason.kind, bridge.usageSnapshot, bridge.usageTelemetryDelta)
              diagnosticFinished = true
            }
            yield chunk
          }
          break
        } catch (error: unknown) {
          await this.#remove(key, bridge)
          if (attempt > 0 || observed || !retryableBeforeObservation(error)) {
            diagnostic.fail(error)
            diagnosticFinished = true
            throw error
          }
          attempt += 1
          bridge = this.#newBridge(key)
          if (key !== undefined) this.#bridges.set(key, bridge)
        }
      }
    } finally {
      if (!diagnosticFinished) diagnostic.abandoned()
      if (ephemeral || bridge.closed) {
        await this.#remove(key, bridge)
      } else if (key !== undefined) {
        this.#scheduleEviction(key, bridge)
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    for (const timer of this.#evictionTimers.values()) clearTimeout(timer)
    this.#evictionTimers.clear()
    const bridges = [...this.#bridges.values()]
    this.#bridges.clear()
    await Promise.all(bridges.map((bridge) => bridge.dispose()))
    await this.processFactory.dispose()
  }
}
