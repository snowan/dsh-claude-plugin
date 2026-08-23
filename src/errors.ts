import { LlmError } from '@deepseek-ai/dsh-llm'

export const CLAUDE_ERROR_CODES = {
  invalidConfig: 'CLAUDE_INVALID_CONFIG',
  invalidModel: 'CLAUDE_INVALID_MODEL',
  invalidProvider: 'CLAUDE_INVALID_PROVIDER',
  transportNotImplemented: 'CLAUDE_TRANSPORT_NOT_IMPLEMENTED',
} as const

export type ClaudeErrorCode = (typeof CLAUDE_ERROR_CODES)[keyof typeof CLAUDE_ERROR_CODES]

/** A stable DSH-facing failure emitted by this adapter. */
export class ClaudePluginError extends LlmError {
  constructor(code: ClaudeErrorCode, message: string, cause?: unknown) {
    super(`dsh-claude-plugin: ${message}`, code, cause === undefined ? undefined : { cause })
    this.name = 'ClaudePluginError'
  }
}

export function invalidConfig(message: string, cause?: unknown): ClaudePluginError {
  return new ClaudePluginError(CLAUDE_ERROR_CODES.invalidConfig, message, cause)
}

export function transportNotImplemented(model: string): ClaudePluginError {
  return new ClaudePluginError(
    CLAUDE_ERROR_CODES.transportNotImplemented,
    `Claude transport is not implemented yet for model ${JSON.stringify(model)}; ` +
      'install a release containing the managed SDK transport milestone',
  )
}
