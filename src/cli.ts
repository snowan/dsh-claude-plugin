#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import type {
  DoctorDependencies,
  DoctorExecutablePolicy,
  DoctorLiveMode,
  DoctorReport,
} from './doctor.js'
import { verifyProfileTransition, type ProfileVerificationReport } from './profile-verifier.js'

const require = createRequire(import.meta.url)
const manifest = require('../package.json') as { version?: unknown }
const VERSION = typeof manifest.version === 'string' ? manifest.version : 'unknown'

const HELP = `dsh-claude-plugin ${VERSION}

Usage:
  dsh-claude-plugin doctor [options]
  dsh-claude-plugin verify-profile --before <dump> --installed <dump> [--removed <dump>] [--json]

Doctor options:
  --command <name-or-path>      Claude executable (default: claude)
  --policy <policy>            host-only, host-then-bundled, or bundled-only
  --model <model>              Claude model for the exact live probe (default: sonnet)
  --timeout-ms <milliseconds>  Per-probe timeout (default: 20000)
  --live                       Always run the authenticated generation probe
  --no-live                    Never run the authenticated generation probe
  --json                       Print stable machine-readable JSON

Profile verification compares boot-free DSH --dump-config files. Install may
only add llm-claude-code and select claude-code/default; optional removal must
restore the original semantic tree.
`

export interface DoctorCliIo {
  readonly stdout: (value: string) => void
  readonly stderr: (value: string) => void
  readonly readFile: (path: string) => Promise<string>
}

/** The doctor module, which imports the DSH packages it probes. */
export type DoctorModule = typeof import('./doctor.js')

export interface DoctorCliDependencies {
  readonly doctor?: DoctorDependencies
  /** Imports the doctor module; the default imports `./doctor.js`. */
  readonly importDoctor?: () => Promise<DoctorModule>
  readonly io?: Partial<DoctorCliIo>
}

function defaultIo(): DoctorCliIo {
  return {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    readFile: (path) => readFile(path, 'utf8'),
  }
}

function resolvedIo(overrides: Partial<DoctorCliIo> | undefined): DoctorCliIo {
  return { ...defaultIo(), ...overrides }
}

function renderDoctor(report: DoctorReport): string {
  const lines = [
    `dsh-claude-plugin doctor: ${report.overall.toUpperCase()}`,
    `plugin ${report.versions.plugin}; SDK ${report.versions.sdk}; Claude parity ${report.versions.sdkClaudeCode}`,
  ]
  for (const entry of report.checks) {
    lines.push(`${entry.status.toUpperCase().padEnd(4)} ${entry.id}: ${entry.summary}`)
  }
  if (report.checks.some((entry) => entry.id === 'auth.metadata' && entry.status === 'fail')) {
    lines.push('Action: run `claude auth login`, then repeat this doctor command.')
  }
  return `${lines.join('\n')}\n`
}

function renderProfile(report: ProfileVerificationReport): string {
  const lines = [
    `dsh-claude-plugin profile verification: ${report.pass ? 'PASS' : 'FAIL'}`,
    `rows: before=${report.beforeRows}, installed=${report.installedRows}${
      report.removedRows === undefined ? '' : `, removed=${report.removedRows}`
    }`,
  ]
  for (const entry of report.issues) lines.push(`FAIL ${entry.code}: ${entry.summary}`)
  if (report.pass) {
    lines.push(`Allowed changed rows: ${report.allowedChangedRowIds.join(', ')}`)
  }
  return `${lines.join('\n')}\n`
}

function doctorLive(values: Readonly<Record<string, unknown>>): DoctorLiveMode {
  if (values.live === true && values['no-live'] === true) {
    throw new Error('--live and --no-live are mutually exclusive')
  }
  if (values.live === true) return 'always'
  if (values['no-live'] === true) return 'never'
  return 'auto'
}

function doctorPolicy(
  value: unknown,
  policies: readonly DoctorExecutablePolicy[],
): DoctorExecutablePolicy | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !(policies as readonly string[]).includes(value)) {
    throw new Error(`--policy must be one of ${policies.join(', ')}`)
  }
  return value as DoctorExecutablePolicy
}

function missingDshPackage(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' &&
    /['"]@deepseek-ai\//.test(error.message)
  )
}

/**
 * Load the doctor, which imports DSH packages, only for the doctor command.
 * DSH 0.2 resolves those packages inside its launcher, so `dsh plugin exec`
 * cannot provide them; `verify-profile` needs none of them.
 */
async function loadDoctor(
  importDoctor: () => Promise<DoctorModule> = () => import('./doctor.js'),
): Promise<DoctorModule> {
  try {
    return await importDoctor()
  } catch (error: unknown) {
    if (!missingDshPackage(error)) throw error
    throw new Error(
      'doctor cannot load the DeepSeek Harness packages it probes; DSH 0.2 does not expose ' +
        'them to `dsh plugin exec`, so run doctor from a plugin checkout after `npm ci`',
      { cause: error },
    )
  }
}

function timeout(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error('--timeout-ms must be an integer')
  }
  return Number(value)
}

async function doctorCommand(
  args: readonly string[],
  dependencies: DoctorCliDependencies,
  io: DoctorCliIo,
): Promise<number> {
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      command: { type: 'string' },
      policy: { type: 'string' },
      model: { type: 'string' },
      'timeout-ms': { type: 'string' },
      live: { type: 'boolean' },
      'no-live': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (parsed.values.help === true) {
    io.stdout(HELP)
    return 0
  }
  const { DOCTOR_EXECUTABLE_POLICIES, runDoctor } = await loadDoctor(dependencies.importDoctor)
  const policy = doctorPolicy(parsed.values.policy, DOCTOR_EXECUTABLE_POLICIES)
  const timeoutMs = timeout(parsed.values['timeout-ms'])
  const report = await runDoctor(
    {
      ...(parsed.values.command === undefined ? {} : { claudeCommand: parsed.values.command }),
      ...(policy === undefined ? {} : { executablePolicy: policy }),
      live: doctorLive(parsed.values),
      ...(parsed.values.model === undefined ? {} : { model: parsed.values.model }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
    dependencies.doctor,
  )
  io.stdout(
    parsed.values.json === true
      ? `${JSON.stringify(report, undefined, 2)}\n`
      : renderDoctor(report),
  )
  return report.overall === 'fail' ? 1 : 0
}

async function profileCommand(args: readonly string[], io: DoctorCliIo): Promise<number> {
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      before: { type: 'string' },
      installed: { type: 'string' },
      removed: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (parsed.values.help === true) {
    io.stdout(HELP)
    return 0
  }
  if (parsed.values.before === undefined || parsed.values.installed === undefined) {
    throw new Error('verify-profile requires --before and --installed dump paths')
  }
  const [before, installed, removed] = await Promise.all([
    io.readFile(parsed.values.before),
    io.readFile(parsed.values.installed),
    parsed.values.removed === undefined
      ? Promise.resolve(undefined)
      : io.readFile(parsed.values.removed),
  ])
  const report = verifyProfileTransition(before, installed, removed)
  io.stdout(
    parsed.values.json === true
      ? `${JSON.stringify(report, undefined, 2)}\n`
      : renderProfile(report),
  )
  return report.pass ? 0 : 1
}

export async function runCli(
  argv: readonly string[],
  dependencies: DoctorCliDependencies = {},
): Promise<number> {
  const io = resolvedIo(dependencies.io)
  try {
    const [command, ...args] = argv
    if (command === undefined || command === '--help' || command === '-h') {
      io.stdout(HELP)
      return 0
    }
    if (command === '--version' || command === '-V') {
      io.stdout(`${VERSION}\n`)
      return 0
    }
    if (command === 'doctor') return await doctorCommand(args, dependencies, io)
    if (command === 'verify-profile') return await profileCommand(args, io)
    throw new Error(`unknown command ${JSON.stringify(command)}`)
  } catch (error: unknown) {
    io.stderr(`dsh-claude-plugin: ${error instanceof Error ? error.message : 'unknown error'}\n`)
    return 2
  }
}

/** Resolve pnpm/npm bin symlinks before deciding whether this module is the executable entrypoint. */
export function isCliEntrypoint(
  moduleUrl: string,
  argvPath: string | undefined,
  realpath: (path: string) => string = realpathSync,
): boolean {
  if (argvPath === undefined) return false
  try {
    return realpath(fileURLToPath(moduleUrl)) === realpath(argvPath)
  } catch {
    return false
  }
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2))
}
