import { describe, expect, it, vi } from 'vitest'
import {
  MAX_DOCTOR_OUTPUT_BYTES,
  type DoctorCommandResult,
  type DoctorDependencies,
  type DoctorPackageFacts,
  type DoctorSdkProbeResult,
  runDoctor,
  runDoctorCommand,
  satisfiesVersionRange,
} from '../src/doctor.js'

const facts: DoctorPackageFacts = {
  pluginVersion: '0.1.0',
  sdkVersion: '0.3.241',
  sdkClaudeCodeVersion: '2.1.241',
  peers: {
    '@deepseek-ai/cordis': { version: '4.0.1', range: '^4.0.1' },
    '@deepseek-ai/dsh-attachment': {
      version: '0.2.0-rc.2',
      range: '>=0.2.0-rc.2 <0.3.0',
    },
    '@deepseek-ai/dsh-llm': {
      version: '0.2.0-rc.2',
      range: '>=0.2.0-rc.2 <0.3.0',
    },
    '@deepseek-ai/dsh-subprocess': {
      version: '0.2.0-rc.2',
      range: '>=0.2.0-rc.2 <0.3.0',
    },
  },
}

function command(stdout: string, extra: Partial<DoctorCommandResult> = {}): DoctorCommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderrBytes: 0,
    timedOut: false,
    truncated: false,
    durationMs: 3,
    ...extra,
  }
}

function probe(extra: Partial<DoctorSdkProbeResult> = {}): DoctorSdkProbeResult {
  return {
    startup: true,
    mcpConnected: true,
    dshOnlyTools: true,
    claudeCodeVersion: '2.1.241',
    live: 'pass',
    cleanup: true,
    durationMs: 20,
    ...extra,
  }
}

function healthyDependencies(override: Partial<DoctorDependencies> = {}): DoctorDependencies {
  const runCommand = vi.fn((_executable: string, args: readonly string[]) =>
    Promise.resolve(
      args[0] === '--version'
        ? command('2.1.241 (Claude Code)\n')
        : command(
            JSON.stringify({ loggedIn: true, authMethod: 'oauth', apiProvider: 'firstParty' }),
          ),
    ),
  )
  return {
    resolveExecutable: vi.fn(() => Promise.resolve('/opt/claude')),
    runCommand,
    probeSdk: vi.fn(() => Promise.resolve(probe())),
    packageFacts: () => facts,
    now: () => new Date('2026-08-23T12:00:00.000Z'),
    nodeVersion: '24.8.0',
    ...override,
  }
}

function statuses(report: Awaited<ReturnType<typeof runDoctor>>) {
  return Object.fromEntries(report.checks.map((entry) => [entry.id, entry.status]))
}

describe('dsh-claude-plugin doctor', () => {
  it('reports a complete healthy host route with no raw payload fields', async () => {
    const dependencies = healthyDependencies()
    const report = await runDoctor({}, dependencies)
    expect(report.overall).toBe('pass')
    expect(report.generatedAt).toBe('2026-08-23T12:00:00.000Z')
    expect(statuses(report)).toEqual({
      'runtime.node': 'pass',
      'package.sdk': 'pass',
      'package.dsh-peers': 'pass',
      'executable.resolve': 'pass',
      'executable.version': 'pass',
      'auth.metadata': 'pass',
      'spawn.lifecycle': 'pass',
      'sdk.startup': 'pass',
      'mcp.handshake': 'pass',
      'generation.live': 'pass',
      'process.cleanup': 'pass',
    })
    expect(report.versions).toMatchObject({
      plugin: '0.1.0',
      sdk: '0.3.241',
      sdkClaudeCode: '2.1.241',
      runtimeClaudeCode: '2.1.241',
    })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toMatch(/prompt|argument|result content|environment/i)
    expect(dependencies.probeSdk).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: '/opt/claude', live: true, model: 'sonnet' }),
    )
  })

  it('treats logged-out metadata as conclusive and skips a paid live call', async () => {
    const sdkProbe = vi.fn(() => Promise.resolve(probe({ live: 'skip' })))
    const dependencies = healthyDependencies({
      runCommand: vi.fn((_executable, args) =>
        Promise.resolve(
          args[0] === '--version'
            ? command('2.1.241 (Claude Code)')
            : command(
                JSON.stringify({
                  loggedIn: false,
                  authMethod: 'none',
                  apiProvider: 'firstParty',
                }),
                { exitCode: 1 },
              ),
        ),
      ),
      probeSdk: sdkProbe,
    })
    const report = await runDoctor({}, dependencies)
    expect(report.overall).toBe('fail')
    expect(statuses(report)['auth.metadata']).toBe('fail')
    expect(statuses(report)['generation.live']).toBe('skip')
    expect(sdkProbe).toHaveBeenCalledWith(expect.objectContaining({ live: false }))
  })

  it('detects stale logged-in metadata only when live authentication fails', async () => {
    const report = await runDoctor(
      { live: 'always' },
      healthyDependencies({
        probeSdk: vi.fn(() =>
          Promise.resolve(
            probe({
              live: 'fail',
              liveFailure: 'authentication',
              resultSubtype: 'error_during_execution',
            }),
          ),
        ),
      }),
    )
    const generation = report.checks.find((entry) => entry.id === 'generation.live')
    expect(generation).toMatchObject({ status: 'fail' })
    expect(generation?.summary).toMatch(/auth metadata says logged in/i)
  })

  it('fails closed for missing, crashing, slow, and incompatible prerequisites', async () => {
    const missingProbe = vi.fn()
    const missing = await runDoctor(
      {},
      healthyDependencies({
        resolveExecutable: vi.fn(() => Promise.resolve(undefined)),
        probeSdk: missingProbe,
      }),
    )
    expect(missing.overall).toBe('fail')
    expect(statuses(missing)['executable.resolve']).toBe('fail')
    expect(statuses(missing)['sdk.startup']).toBe('skip')
    expect(missingProbe).not.toHaveBeenCalled()

    const slow = await runDoctor(
      {},
      healthyDependencies({
        runCommand: vi.fn(() =>
          Promise.resolve(command('', { exitCode: null, signal: 'SIGKILL', timedOut: true })),
        ),
      }),
    )
    expect(statuses(slow)['executable.version']).toBe('fail')
    expect(statuses(slow)['spawn.lifecycle']).toBe('fail')

    const brokenFacts: DoctorPackageFacts = {
      ...facts,
      sdkVersion: '0.3.240',
      peers: {
        ...facts.peers,
        '@deepseek-ai/dsh-llm': {
          version: '0.1.0',
          range: '>=0.2.0-rc.2 <0.3.0',
        },
      },
    }
    const incompatible = await runDoctor(
      {},
      healthyDependencies({ packageFacts: () => brokenFacts, nodeVersion: '23.9.0' }),
    )
    expect(statuses(incompatible)['runtime.node']).toBe('fail')
    expect(statuses(incompatible)['package.sdk']).toBe('fail')
    expect(statuses(incompatible)['package.dsh-peers']).toBe('fail')
  })

  it('warns on host/SDK version skew and supports a bundled fallback', async () => {
    const skew = await runDoctor(
      {},
      healthyDependencies({
        runCommand: vi.fn((_executable, args) =>
          Promise.resolve(
            args[0] === '--version'
              ? command('2.1.181 (Claude Code)')
              : command(
                  JSON.stringify({
                    loggedIn: true,
                    authMethod: 'oauth',
                    apiProvider: 'firstParty',
                  }),
                ),
          ),
        ),
      }),
    )
    expect(skew.overall).toBe('warn')
    expect(statuses(skew)['executable.version']).toBe('warn')

    const sdkProbe = vi.fn(() => Promise.resolve(probe()))
    const fallback = await runDoctor(
      { executablePolicy: 'host-then-bundled', live: 'always' },
      healthyDependencies({
        resolveExecutable: vi.fn(() => Promise.resolve(undefined)),
        probeSdk: sdkProbe,
      }),
    )
    expect(statuses(fallback)['executable.resolve']).toBe('warn')
    expect(statuses(fallback)['auth.metadata']).toBe('skip')
    expect(sdkProbe).toHaveBeenCalledWith(
      expect.not.objectContaining({ executablePath: expect.anything() }),
    )
  })

  it('reports a deterministic bundled-only keyless diagnostic', async () => {
    const resolveExecutable = vi.fn()
    const runCommand = vi.fn()
    const sdkProbe = vi.fn(() => Promise.resolve(probe({ live: 'skip' })))
    const report = await runDoctor(
      { executablePolicy: 'bundled-only', live: 'never' },
      healthyDependencies({ resolveExecutable, runCommand, probeSdk: sdkProbe }),
    )
    expect(report.overall).toBe('warn')
    expect(statuses(report)).toMatchObject({
      'executable.resolve': 'pass',
      'executable.version': 'pass',
      'auth.metadata': 'skip',
      'spawn.lifecycle': 'skip',
      'sdk.startup': 'pass',
      'mcp.handshake': 'pass',
      'generation.live': 'skip',
      'process.cleanup': 'pass',
    })
    expect(resolveExecutable).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
    expect(sdkProbe).toHaveBeenCalledWith(expect.objectContaining({ live: false, model: 'sonnet' }))
  })

  it('fails closed for invalid auth JSON, SDK exceptions, and forced cleanup', async () => {
    const invalidAuth = await runDoctor(
      {},
      healthyDependencies({
        runCommand: vi.fn((_executable, args) =>
          Promise.resolve(
            args[0] === '--version'
              ? command('2.1.241 (Claude Code)')
              : command('{"loggedIn":"yes"}'),
          ),
        ),
      }),
    )
    expect(statuses(invalidAuth)['auth.metadata']).toBe('fail')
    expect(statuses(invalidAuth)['generation.live']).toBe('skip')

    const sdkException = await runDoctor(
      { live: 'always' },
      healthyDependencies({ probeSdk: vi.fn(() => Promise.reject(new Error('secret payload'))) }),
    )
    expect(statuses(sdkException)).toMatchObject({
      'sdk.startup': 'fail',
      'mcp.handshake': 'skip',
      'generation.live': 'skip',
      'process.cleanup': 'fail',
    })
    expect(JSON.stringify(sdkException)).not.toContain('secret payload')

    const forcedCleanup = await runDoctor(
      { live: 'always' },
      healthyDependencies({ probeSdk: vi.fn(() => Promise.resolve(probe({ cleanup: false }))) }),
    )
    expect(statuses(forcedCleanup)['process.cleanup']).toBe('fail')
  })

  it('distinguishes a successful request with the wrong reply from transport failure', async () => {
    const report = await runDoctor(
      { live: 'always' },
      healthyDependencies({
        probeSdk: vi.fn(() =>
          Promise.resolve(
            probe({
              live: 'fail',
              liveFailure: 'reply-mismatch',
              resultSubtype: 'success',
            }),
          ),
        ),
      }),
    )
    const generation = report.checks.find((entry) => entry.id === 'generation.live')
    expect(generation).toMatchObject({
      status: 'fail',
      details: { failure: 'reply-mismatch', resultSubtype: 'success' },
    })
  })

  it('validates configuration and semver including prerelease lower bounds', async () => {
    expect(satisfiesVersionRange('0.2.0-rc.2', '>=0.2.0-rc.2 <0.3.0')).toBe(true)
    expect(satisfiesVersionRange('0.2.0-rc.1', '>=0.2.0-rc.2 <0.3.0')).toBe(false)
    expect(satisfiesVersionRange('4.9.0', '^4.0.1')).toBe(true)
    expect(satisfiesVersionRange('5.0.0', '^4.0.1')).toBe(false)
    expect(satisfiesVersionRange('not-semver', '>=1.0.0')).toBe(false)
    expect(satisfiesVersionRange('1.2.3', '1.2.3')).toBe(true)
    expect(satisfiesVersionRange('1.2.3', '=1.2.3')).toBe(true)
    expect(satisfiesVersionRange('1.2.3', '<=1.2.3')).toBe(true)
    expect(satisfiesVersionRange('1.2.4', '>1.2.3')).toBe(true)
    expect(satisfiesVersionRange('1.2.2', '<1.2.3')).toBe(true)
    expect(satisfiesVersionRange('1.2.3-alpha', '<1.2.3')).toBe(true)
    expect(satisfiesVersionRange('1.2.3', '>1.2.3-alpha')).toBe(true)
    expect(satisfiesVersionRange('1.2.3-alpha', '>1.2.3-alpha.1')).toBe(false)
    expect(satisfiesVersionRange('1.2.3-alpha.1', '>1.2.3-alpha')).toBe(true)
    expect(satisfiesVersionRange('1.2.3-2', '>1.2.3-1')).toBe(true)
    expect(satisfiesVersionRange('1.2.3-1', '<1.2.3-alpha')).toBe(true)
    expect(satisfiesVersionRange('1.2.3-alpha', '>1.2.3-1')).toBe(true)
    expect(satisfiesVersionRange('1.2.3-beta', '>1.2.3-alpha')).toBe(true)
    expect(satisfiesVersionRange('0.3.4', '^0.3.0')).toBe(true)
    expect(satisfiesVersionRange('0.4.0', '^0.3.0')).toBe(false)
    expect(satisfiesVersionRange('0.0.3', '^0.0.3')).toBe(true)
    expect(satisfiesVersionRange('0.0.4', '^0.0.3')).toBe(false)
    expect(satisfiesVersionRange('1.2.3', '')).toBe(false)
    expect(satisfiesVersionRange('1.2.3', 'bad')).toBe(false)
    await expect(runDoctor({ timeoutMs: 999 }, healthyDependencies())).rejects.toThrow(/timeoutMs/)
    await expect(runDoctor({ timeoutMs: 1_000.5 }, healthyDependencies())).rejects.toThrow(
      /timeoutMs/,
    )
    await expect(runDoctor({ timeoutMs: 120_001 }, healthyDependencies())).rejects.toThrow(
      /timeoutMs/,
    )
    await expect(runDoctor({ claudeCommand: '../claude' }, healthyDependencies())).rejects.toThrow(
      /claudeCommand/,
    )
    await expect(runDoctor({ claudeCommand: '' }, healthyDependencies())).rejects.toThrow(
      /claudeCommand/,
    )
    await expect(runDoctor({ claudeCommand: ' claude' }, healthyDependencies())).rejects.toThrow(
      /claudeCommand/,
    )
    await expect(
      runDoctor({ claudeCommand: 'cl\u0000aude' }, healthyDependencies()),
    ).rejects.toThrow(/claudeCommand/)
    await expect(runDoctor({ claudeCommand: '..\\claude' }, healthyDependencies())).rejects.toThrow(
      /claudeCommand/,
    )
    await expect(
      runDoctor({ executablePolicy: 'invalid' as never }, healthyDependencies()),
    ).rejects.toThrow(/executablePolicy/)
    await expect(runDoctor({ live: 'invalid' as never }, healthyDependencies())).rejects.toThrow(
      /live mode/,
    )
    await expect(runDoctor({ model: 'bad model' }, healthyDependencies())).rejects.toThrow(/model/)
    await expect(runDoctor({ cwd: 'relative' }, healthyDependencies())).rejects.toThrow(/cwd/)
    await expect(runDoctor({ cwd: '/tmp/bad\u0000cwd' }, healthyDependencies())).rejects.toThrow(
      /cwd/,
    )
  })

  it('covers bounded metadata shapes and degraded SDK results', async () => {
    for (const invalid of [
      'null',
      '[]',
      '{"loggedIn":"yes","authMethod":"oauth","apiProvider":"firstParty"}',
      '{"loggedIn":true,"authMethod":1,"apiProvider":"firstParty"}',
      '{"loggedIn":true,"authMethod":"oauth","apiProvider":1}',
      JSON.stringify({ loggedIn: true, authMethod: 'x'.repeat(65), apiProvider: 'firstParty' }),
      JSON.stringify({ loggedIn: true, authMethod: 'oauth', apiProvider: 'x'.repeat(65) }),
    ]) {
      const report = await runDoctor(
        {},
        healthyDependencies({
          runCommand: vi.fn((_executable, args) =>
            Promise.resolve(
              args[0] === '--version' ? command('2.1.241 (Claude Code)') : command(invalid),
            ),
          ),
        }),
      )
      expect(statuses(report)['auth.metadata']).toBe('fail')
    }

    const truncated = await runDoctor(
      {},
      healthyDependencies({
        runCommand: vi.fn((_executable, args) =>
          Promise.resolve(
            args[0] === '--version'
              ? command('2.1.241 (Claude Code)')
              : command(
                  JSON.stringify({
                    loggedIn: true,
                    authMethod: 'oauth',
                    apiProvider: 'firstParty',
                  }),
                  { truncated: true },
                ),
          ),
        ),
      }),
    )
    expect(statuses(truncated)['auth.metadata']).toBe('fail')

    const degradedDependencies = healthyDependencies({
      packageFacts: () => ({
        ...facts,
        peers: {
          ...facts.peers,
          '@deepseek-ai/dsh-llm': {
            range: '>=0.2.0-rc.2 <0.3.0',
            error: 'missing',
          },
        },
      }),
      probeSdk: vi.fn(() =>
        Promise.resolve({
          startup: false,
          mcpConnected: false,
          dshOnlyTools: false,
          live: 'fail',
          cleanup: true,
          durationMs: 1,
        } satisfies DoctorSdkProbeResult),
      ),
    })
    Reflect.deleteProperty(degradedDependencies, 'now')
    const degraded = await runDoctor({ live: 'always' }, degradedDependencies)
    expect(statuses(degraded)).toMatchObject({
      'package.dsh-peers': 'fail',
      'sdk.startup': 'fail',
      'mcp.handshake': 'fail',
      'generation.live': 'fail',
      'process.cleanup': 'pass',
    })
    expect(degraded.versions.runtimeClaudeCode).toBe('2.1.241')
  })
})

describe('bounded doctor subprocess runner', () => {
  it('captures bounded stdout without retaining stderr text', async () => {
    const result = await runDoctorCommand(
      process.execPath,
      [
        '-e',
        `process.stdout.write('x'.repeat(${MAX_DOCTOR_OUTPUT_BYTES + 10})); process.stderr.write('secret')`,
      ],
      { cwd: process.cwd(), timeoutMs: 5_000 },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toHaveLength(MAX_DOCTOR_OUTPUT_BYTES)
    expect(result.truncated).toBe(true)
    expect(result.stderrBytes).toBe(6)
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('kills a slow command at the configured deadline', async () => {
    const result = await runDoctorCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: process.cwd(),
      timeoutMs: 50,
    })
    expect(result.timedOut).toBe(true)
    expect(result.signal).not.toBeNull()
  })
})
