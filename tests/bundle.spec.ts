import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = fileURLToPath(new URL('../', import.meta.url))

describe('installable DSH bundle', () => {
  it('publishes the expected entry points and bundle declaration', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest).toMatchObject({
      name: 'dsh-claude-plugin',
      type: 'module',
      main: './lib/index.js',
      types: './lib/index.d.ts',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    expect(manifest.files).toEqual([
      'lib/',
      'cordis.patch.yml',
      'AUTHORS.md',
      'README.md',
      'LICENSE',
    ])
  })

  it('adds only the adapter row and the default-model patch', async () => {
    const source = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(parse(source)).toEqual([
      {
        insert: [{ id: 'llm-claude-code', name: 'dsh-claude-plugin' }],
      },
      {
        id: 'agent-default-model',
        config: { provider: 'claude-code', model: 'default' },
      },
    ])
    expect(source).not.toMatch(/security|sandbox|tools|session|web/i)
    expect(root).toMatch(/dsh-claude-plugin[/\\]$/)
  })
})
