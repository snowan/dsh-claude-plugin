import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyProfileTransition } from '../lib/profile-verifier.js'

const EXPECTED_DSH_VERSION = '0.2.0-rc.2'
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1_024 * 1_024
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const keep = process.argv.includes('--keep')

const fixture = mkdtempSync(join(tmpdir(), 'dsh-claude-profile-e2e-'))
const cliFixture = join(fixture, 'dsh-cli')
const profileHome = join(fixture, 'dsh-home')
const agentsHome = join(fixture, 'agents-home')
const packDirectory = join(fixture, 'package')
const environment = {
  ...process.env,
  CI: '1',
  DSH_AGENTS_HOME: agentsHome,
  DSH_HOME: profileHome,
  NO_COLOR: '1',
}
mkdirSync(packDirectory, { recursive: true })

function execute(command, args, cwd = repository) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: environment,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

try {
  let dshBin
  if (process.env.DSH_PROFILE_TEST_BIN === undefined) {
    mkdirSync(cliFixture, { recursive: true })
    writeFileSync(
      join(cliFixture, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dsh-claude-profile-e2e-fixture',
          private: true,
          packageManager: 'pnpm@10.34.5',
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    )
    const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    execute(
      pnpmCommand,
      [
        'add',
        '--ignore-scripts',
        '--reporter=append-only',
        `@deepseek-ai/dsh@${EXPECTED_DSH_VERSION}`,
      ],
      cliFixture,
    )
    dshBin = join(
      cliFixture,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
    )
  } else {
    dshBin = resolve(process.env.DSH_PROFILE_TEST_BIN)
  }
  if (!existsSync(dshBin)) throw new Error(`DSH binary not found at ${dshBin}`)
  const dshVersion = execute(dshBin, ['--version']).trim()
  if (dshVersion !== EXPECTED_DSH_VERSION) {
    throw new Error(`profile E2E requires DSH ${EXPECTED_DSH_VERSION}, found ${dshVersion}`)
  }
  const dsh = (args) => execute(dshBin, args)

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const packRaw = execute(npmCommand, [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    packDirectory,
  ])
  const packReport = JSON.parse(packRaw)
  const filename = Array.isArray(packReport) ? packReport[0]?.filename : undefined
  if (typeof filename !== 'string') throw new Error('npm pack returned no tarball filename')
  const tarball = join(packDirectory, filename)

  const before = dsh(['--profile', 'web', '--dump-config'])
  dsh(['plugin', '--profile', 'web', 'add', tarball, '--ignore-scripts'])
  const installed = dsh(['--profile', 'web', '--dump-config'])

  // DSH 0.2 resolves DSH packages only inside its launcher, so the installed
  // bin runs verify-profile, which imports none, and the checkout runs doctor.
  const beforePath = join(fixture, 'before.yml')
  const installedPath = join(fixture, 'installed.yml')
  writeFileSync(beforePath, before, 'utf8')
  writeFileSync(installedPath, installed, 'utf8')
  const installedVerification = JSON.parse(
    dsh([
      'plugin',
      '--profile',
      'web',
      'exec',
      'dsh-claude-plugin',
      'verify-profile',
      '--before',
      beforePath,
      '--installed',
      installedPath,
      '--json',
    ]),
  )
  if (installedVerification.pass !== true) {
    throw new Error('the installed verify-profile command rejected the install transition')
  }

  const doctorRaw = execute(process.execPath, [
    join(repository, 'lib', 'cli.js'),
    'doctor',
    '--policy',
    'bundled-only',
    '--no-live',
    '--json',
  ])
  const doctor = JSON.parse(doctorRaw)
  const doctorChecks = new Map(
    Array.isArray(doctor.checks) ? doctor.checks.map((entry) => [entry.id, entry.status]) : [],
  )
  for (const id of ['sdk.startup', 'mcp.handshake', 'process.cleanup']) {
    if (doctorChecks.get(id) !== 'pass') {
      throw new Error(`checkout doctor check ${id} did not pass`)
    }
  }

  dsh(['plugin', '--profile', 'web', 'remove', 'dsh-claude-plugin'])
  const removed = dsh(['--profile', 'web', '--dump-config'])
  const verification = verifyProfileTransition(before, installed, removed)
  if (!verification.pass) {
    throw new Error(
      `profile transition failed: ${verification.issues.map((entry) => entry.code).join(', ')}`,
    )
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        dsh: dshVersion,
        profile: 'web',
        plugin: 'packed tarball',
        rows: {
          before: verification.beforeRows,
          installed: verification.installedRows,
          removed: verification.removedRows,
        },
        doctor: {
          startup: doctorChecks.get('sdk.startup'),
          mcp: doctorChecks.get('mcp.handshake'),
          cleanup: doctorChecks.get('process.cleanup'),
        },
        removalRestoredBaseline: true,
      },
      undefined,
      2,
    )}\n`,
  )
} finally {
  if (keep) {
    process.stderr.write(`Profile E2E fixture retained at ${fixture}\n`)
  } else {
    rmSync(fixture, { recursive: true, force: true })
  }
}
