import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const cache = mkdtempSync(join(tmpdir(), 'dsh-claude-pack-'))
let raw
try {
  raw = execFileSync(npmCommand, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cache },
  })
} finally {
  rmSync(cache, { recursive: true, force: true })
}
const reports = JSON.parse(raw)
if (!Array.isArray(reports) || reports.length !== 1 || !Array.isArray(reports[0]?.files)) {
  throw new Error('npm pack did not return one JSON file report')
}

const files = reports[0].files.map((file) => file.path).sort()
const required = [
  'AUTHORS.md',
  'LICENSE',
  'README.md',
  'cordis.patch.yml',
  'lib/index.d.ts',
  'lib/index.js',
  'package.json',
]
const missing = required.filter((file) => !files.includes(file))
if (missing.length > 0) throw new Error(`Packed artifact is missing: ${missing.join(', ')}`)

const exact = new Set(['AUTHORS.md', 'LICENSE', 'README.md', 'cordis.patch.yml', 'package.json'])
const unexpected = files.filter((file) => !exact.has(file) && !file.startsWith('lib/'))
if (unexpected.length > 0) {
  throw new Error(`Packed artifact contains unexpected files: ${unexpected.join(', ')}`)
}

console.log(`Checked npm package contents: ${files.length} intended file(s)`)
