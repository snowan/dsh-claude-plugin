import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import type { Logger } from '@deepseek-ai/cordis'
import { ClaudePluginError } from './errors.js'
import type { ClaudeGenerateOptions } from './request.js'
import type { UsageSnapshot, UsageTelemetryDelta } from './usage.js'

export const MAX_DIAGNOSTIC_BYTES = 4 * 1_024
export const DIAGNOSTIC_SCHEMA_VERSION = 1

export type DiagnosticLogger = Pick<Logger, 'debug'>

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function bounded(value: string, max = 256): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function requestCounts(options: ClaudeGenerateOptions) {
  let textCharacters = 0
  let imageCount = 0
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type === 'text') textCharacters += block.text.length
      else if (block.type === 'image') imageCount += 1
    }
  }
  return { textCharacters, imageCount }
}

/** One request-scoped, bounded logger that never accepts prompt or tool payload values. */
export class GenerationDiagnostics {
  readonly id = randomUUID()
  readonly #startedAt = Date.now()
  #finished = false

  constructor(
    readonly owner: ClaudeDiagnostics,
    options: ClaudeGenerateOptions,
    model: string,
  ) {
    const counts = requestCounts(options)
    owner.emit({
      event: 'generation.start',
      generationId: this.id,
      sessionHash:
        options.sessionId === undefined ? 'ephemeral' : digest(String(options.sessionId)),
      purpose: options.purpose ?? 'conversation',
      model: bounded(model),
      reasoningEffort:
        options.reasoningEffort === undefined
          ? 'provider-default'
          : bounded(String(options.reasoningEffort)),
      messageCount: options.messages.length,
      textCharacters: counts.textCharacters,
      imageCount: counts.imageCount,
      toolCount: options.tools?.length ?? 0,
      systemHash: digest(options.system ?? ''),
    })
  }

  attempt(number: number, mode: 'planned' | 'retry-degraded'): void {
    this.owner.emit({
      event: 'generation.attempt',
      generationId: this.id,
      attempt: number,
      mode,
    })
  }

  finish(outcome: string, usage: UsageSnapshot, delta: UsageTelemetryDelta): void {
    if (this.#finished) return
    this.#finished = true
    this.owner.emit({
      event: 'generation.finish',
      generationId: this.id,
      outcome: bounded(outcome, 64),
      durationMs: Math.max(0, Date.now() - this.#startedAt),
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        reasoningTokens: usage.reasoningTokens ?? 0,
        costUsd: usage.costUsd ?? 0,
        queryCostUsd: usage.queryCostUsd ?? 0,
        modelCount: usage.models?.length ?? 0,
      },
      delta,
    })
  }

  fail(error: unknown): void {
    if (this.#finished) return
    this.#finished = true
    this.owner.emit({
      event: 'generation.fail',
      generationId: this.id,
      durationMs: Math.max(0, Date.now() - this.#startedAt),
      code: error instanceof ClaudePluginError ? error.code : 'CLAUDE_UNEXPECTED_ERROR',
      errorType:
        error instanceof ClaudePluginError
          ? 'ClaudePluginError'
          : error instanceof Error
            ? 'Error'
            : typeof error,
    })
  }

  abandoned(): void {
    if (this.#finished) return
    this.#finished = true
    this.owner.emit({
      event: 'generation.abandoned',
      generationId: this.id,
      durationMs: Math.max(0, Date.now() - this.#startedAt),
    })
  }
}

/** Redacted debug diagnostics; disabled mode performs no serialization or logging. */
export class ClaudeDiagnostics {
  constructor(
    readonly enabled: boolean,
    readonly logger?: DiagnosticLogger,
  ) {}

  begin(options: ClaudeGenerateOptions, model: string): GenerationDiagnostics {
    return new GenerationDiagnostics(this, options, model)
  }

  emit(fields: Readonly<Record<string, unknown>>): void {
    if (!this.enabled || this.logger === undefined) return
    const line = JSON.stringify({
      component: 'dsh-claude-plugin',
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      ...fields,
    })
    if (Buffer.byteLength(line, 'utf8') > MAX_DIAGNOSTIC_BYTES) {
      this.logger.debug(
        '%s',
        JSON.stringify({
          component: 'dsh-claude-plugin',
          schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
          event: 'diagnostic.truncated',
        }),
      )
      return
    }
    this.logger.debug('%s', line)
  }
}
