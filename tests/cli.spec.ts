import { describe, expect, it, vi } from 'vitest'
import { pathToFileURL } from 'node:url'
import { isCliEntrypoint, runCli, type DoctorCliDependencies } from '../src/cli.js'
import type {
  DoctorCommandResult,
  DoctorDependencies,
  DoctorPackageFacts,
  DoctorSdkProbeResult,
} from '../src/doctor.js'

const packageFacts: DoctorPackageFacts = {
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

function command(stdout: string, exitCode = 0): DoctorCommandResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderrBytes: 0,
    timedOut: false,
    truncated: false,
    durationMs: 1,
  }
}

function sdkProbe(live: DoctorSdkProbeResult['live'] = 'pass'): DoctorSdkProbeResult {
  return {
    startup: true,
    mcpConnected: true,
    dshOnlyTools: true,
    claudeCodeVersion: '2.1.241',
    live,
    cleanup: true,
    durationMs: 5,
  }
}

function doctor(loggedIn = true): DoctorDependencies {
  return {
    resolveExecutable: () => Promise.resolve('/opt/claude'),
    runCommand: (_executable, args) =>
      Promise.resolve(
        args[0] === '--version'
          ? command('2.1.241 (Claude Code)')
          : command(
              JSON.stringify({
                loggedIn,
                authMethod: loggedIn ? 'oauth' : 'none',
                apiProvider: 'firstParty',
              }),
              loggedIn ? 0 : 1,
            ),
      ),
    probeSdk: ({ live }) => Promise.resolve(sdkProbe(live ? 'pass' : 'skip')),
    packageFacts: () => packageFacts,
    now: () => new Date('2026-08-23T12:00:00.000Z'),
    nodeVersion: '24.0.0',
  }
}

function harness(
  doctorDependencies: DoctorDependencies = doctor(),
  files: Readonly<Record<string, string>> = {},
) {
  const stdout: string[] = []
  const stderr: string[] = []
  const dependencies: DoctorCliDependencies = {
    doctor: doctorDependencies,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      readFile: (path) =>
        path in files
          ? Promise.resolve(files[path]!)
          : Promise.reject(new Error('missing fixture')),
    },
  }
  return { dependencies, stderr, stdout }
}

const baseline = `
- id: agent-default-model
  name: selector
  config: { provider: deepseek, model: default }
`

const installed = `
- id: agent-default-model
  name: selector
  config: { provider: claude-code, model: default }
- id: llm-claude-code
  name: dsh-claude-plugin
`

describe('doctor CLI', () => {
  it('recognizes a package-manager symlink as the executable entrypoint', () => {
    const resolve = (path: string) =>
      path === '/profile/node_modules/.bin/dsh-claude-plugin' ? '/store/package/lib/cli.js' : path
    expect(
      isCliEntrypoint(
        pathToFileURL('/store/package/lib/cli.js').href,
        '/profile/node_modules/.bin/dsh-claude-plugin',
        resolve,
      ),
    ).toBe(true)
    expect(
      isCliEntrypoint(pathToFileURL('/store/package/lib/cli.js').href, undefined, resolve),
    ).toBe(false)
  })

  it('prints stable JSON and returns zero for a healthy doctor report', async () => {
    const fixture = harness()
    await expect(
      runCli(['doctor', '--json', '--live', '--policy', 'host-only'], fixture.dependencies),
    ).resolves.toBe(0)
    const report = JSON.parse(fixture.stdout.join('')) as { overall: string; schemaVersion: number }
    expect(report).toMatchObject({ overall: 'pass', schemaVersion: 1 })
    expect(fixture.stderr).toEqual([])
  })

  it('renders text with all optional doctor arguments and subcommand help', async () => {
    const fixture = harness()
    await expect(
      runCli(
        [
          'doctor',
          '--command',
          '/opt/claude',
          '--policy',
          'host-only',
          '--model',
          'opus',
          '--timeout-ms',
          '5000',
          '--no-live',
        ],
        fixture.dependencies,
      ),
    ).resolves.toBe(0)
    expect(fixture.stdout.join('')).toMatch(/doctor: WARN/)

    const doctorHelp = harness()
    await expect(runCli(['doctor', '--help'], doctorHelp.dependencies)).resolves.toBe(0)
    expect(doctorHelp.stdout.join('')).toContain('Doctor options')

    const profileHelp = harness()
    await expect(runCli(['verify-profile', '-h'], profileHelp.dependencies)).resolves.toBe(0)
    expect(profileHelp.stdout.join('')).toContain('verify-profile')
  })

  it('returns one with a concrete login action when auth is absent', async () => {
    const fixture = harness(doctor(false))
    await expect(runCli(['doctor'], fixture.dependencies)).resolves.toBe(1)
    expect(fixture.stdout.join('')).toMatch(/run `claude auth login`/)
  })

  it('verifies before/install/removal profile dumps through CLI files', async () => {
    const fixture = harness(doctor(), {
      '/before.yml': baseline,
      '/installed.yml': installed,
      '/removed.yml': baseline,
    })
    await expect(
      runCli(
        [
          'verify-profile',
          '--before',
          '/before.yml',
          '--installed',
          '/installed.yml',
          '--removed',
          '/removed.yml',
          '--json',
        ],
        fixture.dependencies,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(fixture.stdout.join(''))).toMatchObject({ pass: true, removedRows: 1 })
  })

  it('returns one when a profile transition changes a protected row', async () => {
    const fixture = harness(doctor(), {
      '/before.yml': baseline,
      '/installed.yml': `${installed}- id: unexpected\n  name: bypass\n`,
    })
    await expect(
      runCli(
        ['verify-profile', '--before', '/before.yml', '--installed', '/installed.yml'],
        fixture.dependencies,
      ),
    ).resolves.toBe(1)
    expect(fixture.stdout.join('')).toMatch(/PROFILE_ROW_ADDED/)
    expect(fixture.stderr).toEqual([])
  })

  it('renders a passing profile without a removal dump', async () => {
    const fixture = harness(doctor(), {
      '/before.yml': baseline,
      '/installed.yml': installed,
    })
    await expect(
      runCli(
        ['verify-profile', '--before', '/before.yml', '--installed', '/installed.yml'],
        fixture.dependencies,
      ),
    ).resolves.toBe(0)
    const output = fixture.stdout.join('')
    expect(output).toContain('profile verification: PASS')
    expect(output).not.toContain('removed=')
    expect(output).toContain('Allowed changed rows')
  })

  it('returns usage errors without throwing or leaking file contents', async () => {
    const fixture = harness()
    await expect(runCli(['doctor', '--live', '--no-live'], fixture.dependencies)).resolves.toBe(2)
    expect(fixture.stderr.join('')).toMatch(/mutually exclusive/)
    const unknown = harness()
    await expect(runCli(['unknown'], unknown.dependencies)).resolves.toBe(2)
    expect(unknown.stderr.join('')).toMatch(/unknown command/)
    const missing = harness()
    await expect(
      runCli(['verify-profile', '--before', '/before.yml'], missing.dependencies),
    ).resolves.toBe(2)
    expect(missing.stderr.join('')).not.toContain(baseline)

    const badPolicy = harness()
    await expect(
      runCli(['doctor', '--policy', 'native-tools'], badPolicy.dependencies),
    ).resolves.toBe(2)
    expect(badPolicy.stderr.join('')).toMatch(/--policy must be one of/)

    const badTimeout = harness()
    await expect(runCli(['doctor', '--timeout-ms', '5s'], badTimeout.dependencies)).resolves.toBe(2)
    expect(badTimeout.stderr.join('')).toMatch(/must be an integer/)

    const opaque = harness()
    const opaqueDependencies: DoctorCliDependencies = {
      ...opaque.dependencies,
      io: { ...opaque.dependencies.io, readFile: () => Promise.reject('opaque failure') },
    }
    await expect(
      runCli(
        ['verify-profile', '--before', '/before.yml', '--installed', '/installed.yml'],
        opaqueDependencies,
      ),
    ).resolves.toBe(2)
    expect(opaque.stderr.join('')).toMatch(/unknown error/)
  })

  it('prints help/version without executing probes', async () => {
    const resolveExecutable = vi.fn()
    const fixture = harness({ ...doctor(), resolveExecutable })
    await expect(runCli(['--help'], fixture.dependencies)).resolves.toBe(0)
    expect(fixture.stdout.join('')).toContain('verify-profile')
    expect(resolveExecutable).not.toHaveBeenCalled()

    const empty = harness()
    await expect(runCli([], empty.dependencies)).resolves.toBe(0)
    const shortHelp = harness()
    await expect(runCli(['-h'], shortHelp.dependencies)).resolves.toBe(0)
    const version = harness()
    await expect(runCli(['-V'], version.dependencies)).resolves.toBe(0)
    expect(version.stdout.join('')).toBe('0.1.0\n')
  })

  it('fails closed when entrypoint realpath resolution fails', () => {
    expect(
      isCliEntrypoint(
        pathToFileURL('/store/package/lib/cli.js').href,
        '/profile/node_modules/.bin/dsh-claude-plugin',
        () => {
          throw new Error('missing')
        },
      ),
    ).toBe(false)
  })
})
