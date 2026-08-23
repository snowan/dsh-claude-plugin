import { describe, expect, it } from 'vitest'
import {
  Config,
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_EXECUTABLE_POLICY,
  DEFAULT_MODEL,
  DEFAULT_SESSION_IDLE_MS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  DEFAULT_TOOL_ROUND_TRIP_TIMEOUT_MS,
  MAX_TIMER_DELAY_MS,
  resolveConfig,
} from '../src/index.js'

describe('configuration', () => {
  it('exposes schema defaults and resolves an immutable config', () => {
    expect(Config({})).toEqual({
      claudeCommand: DEFAULT_CLAUDE_COMMAND,
      executablePolicy: DEFAULT_EXECUTABLE_POLICY,
      defaultModel: DEFAULT_MODEL,
      sessionIdleMs: DEFAULT_SESSION_IDLE_MS,
      toolRoundTripTimeoutMs: DEFAULT_TOOL_ROUND_TRIP_TIMEOUT_MS,
      shutdownGraceMs: DEFAULT_SHUTDOWN_GRACE_MS,
      passEnv: [],
      debug: false,
    })

    const resolved = resolveConfig({
      claudeCommand: '/opt/claude',
      executablePolicy: 'host-then-bundled',
      defaultModel: 'claude-opus-4-1',
      sessionIdleMs: 1,
      toolRoundTripTimeoutMs: 2,
      shutdownGraceMs: 3,
      passEnv: ['HTTPS_PROXY', 'NO_PROXY'],
      debug: true,
    })
    expect(resolved).toEqual({
      claudeCommand: '/opt/claude',
      executablePolicy: 'host-then-bundled',
      defaultModel: 'claude-opus-4-1',
      sessionIdleMs: 1,
      toolRoundTripTimeoutMs: 2,
      shutdownGraceMs: 3,
      passEnv: ['HTTPS_PROXY', 'NO_PROXY'],
      debug: true,
    })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.passEnv)).toBe(true)
    expect(resolveConfig()).toMatchObject({ defaultModel: DEFAULT_MODEL })
  })

  it.each([
    [{ claudeCommand: '   ' }, /claudeCommand/],
    [{ claudeCommand: 'claude\u0000bad' }, /NUL bytes/],
    [{ claudeCommand: './claude' }, /absolute path or a bare executable/],
    [{ claudeCommand: '.\\claude' }, /absolute path or a bare executable/],
    [{ defaultModel: ' sonnet' }, /defaultModel/],
    [{ defaultModel: 'default' }, /concrete Claude model/],
    [{ sessionIdleMs: 0 }, /schema validation/],
    [{ toolRoundTripTimeoutMs: MAX_TIMER_DELAY_MS + 1 }, /schema validation/],
    [{ shutdownGraceMs: Number.POSITIVE_INFINITY }, /schema validation/],
    [{ executablePolicy: 'ambient' }, /schema validation/],
    [{ passEnv: ['ANTHROPIC_API_KEY'] }, /security-sensitive/],
    [{ passEnv: ['auth_token'] }, /security-sensitive/],
    [{ passEnv: ['DSH_HOME'] }, /security-sensitive/],
    [{ passEnv: ['NOT-PORTABLE'] }, /portable environment-variable/],
    [{ passEnv: ['NO_PROXY', 'no_proxy'] }, /duplicate name/],
    [{ passEnv: Array.from({ length: 65 }, (_, index) => `SAFE_${index}`) }, /at most 64/],
  ] as Array<[Record<string, unknown>, RegExp]>)('rejects invalid config %#', (config, message) => {
    expect(() => resolveConfig(config as never)).toThrow(message)
    try {
      resolveConfig(config as never)
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'CLAUDE_INVALID_CONFIG' })
    }
  })

  it('normalizes a non-Error schema throw without exposing config values', () => {
    const throwing = new Proxy(
      {},
      {
        get() {
          throw 'non-error schema failure'
        },
      },
    )
    expect(() => resolveConfig(throwing)).toThrow('unknown validation error')
  })
})
