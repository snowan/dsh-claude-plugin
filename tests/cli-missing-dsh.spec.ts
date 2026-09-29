import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli.js'

function moduleNotFound(specifier: string): NodeJS.ErrnoException {
  const error = new Error(
    `Cannot find package '${specifier}' imported from /profile/node_modules/dsh-claude-plugin/lib/errors.js`,
  ) as NodeJS.ErrnoException
  error.code = 'ERR_MODULE_NOT_FOUND'
  return error
}

describe('CLI without resolvable DSH packages', () => {
  it('explains that doctor needs a checkout while verify-profile stays available', async () => {
    const stderr = vi.fn()
    const stdout = vi.fn()
    const importDoctor = () => Promise.reject(moduleNotFound('@deepseek-ai/dsh-llm'))
    expect(await runCli(['doctor', '--no-live'], { importDoctor, io: { stderr, stdout } })).toBe(2)
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(
      /doctor cannot load the DeepSeek Harness packages.*run doctor from a plugin checkout/,
    )
    expect(
      await runCli(['verify-profile', '--help'], { importDoctor, io: { stderr, stdout } }),
    ).toBe(0)
  })

  it('reports other missing modules unchanged', async () => {
    const stderr = vi.fn()
    const importDoctor = () => Promise.reject(moduleNotFound('yaml'))
    expect(await runCli(['doctor'], { importDoctor, io: { stderr, stdout: vi.fn() } })).toBe(2)
    expect(String(stderr.mock.calls[0]?.[0])).toContain("Cannot find package 'yaml'")
  })
})
