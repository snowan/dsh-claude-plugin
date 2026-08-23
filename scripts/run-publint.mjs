import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cache = mkdtempSync(join(tmpdir(), 'dsh-claude-publint-'))
const executable = join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'publint.cmd' : 'publint',
)

try {
  execFileSync(executable, [], {
    env: { ...process.env, npm_config_cache: cache },
    stdio: 'inherit',
  })
} finally {
  rmSync(cache, { recursive: true, force: true })
}
