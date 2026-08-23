import { describe, expect, it } from 'vitest'
import {
  BUILTIN_MODEL_ALIASES,
  modelCatalog,
  PROVIDER_ID,
  resolvedModelInfo,
  resolveClaudeModel,
  validateModelId,
} from '../src/index.js'

describe('Claude model aliases', () => {
  it('advertises the stable aliases in preferred order', () => {
    const models = modelCatalog('opus')
    expect(models.map((model) => model.id)).toEqual(BUILTIN_MODEL_ALIASES)
    expect(models[0]).toMatchObject({
      provider: PROVIDER_ID,
      id: 'default',
      name: 'Claude Opus (default)',
      inputModalities: ['text'],
    })
    expect(Object.isFrozen(models)).toBe(true)
    expect(modelCatalog('claude-opus-4-1')[0]?.name).toBe('claude-opus-4-1 (default)')
  })

  it('maps only the default alias and preserves explicit Claude model names', () => {
    expect(resolveClaudeModel('default', 'sonnet')).toBe('sonnet')
    expect(() => resolveClaudeModel('default', 'default')).toThrow('concrete Claude model')
    expect(resolveClaudeModel('opus', 'sonnet')).toBe('opus')
    expect(resolveClaudeModel('claude-sonnet-4-5-20250929', 'haiku')).toBe(
      'claude-sonnet-4-5-20250929',
    )
  })

  it('keeps the requested DSH id while describing the resolved default', () => {
    expect(resolvedModelInfo(PROVIDER_ID, 'default', 'haiku')).toMatchObject({
      provider: PROVIDER_ID,
      id: 'default',
      name: 'Claude Haiku (default)',
      description: 'Claude Code alias resolving to haiku',
    })
    expect(resolvedModelInfo(PROVIDER_ID, 'sonnet', 'haiku')).toMatchObject({
      id: 'sonnet',
      name: 'Claude Sonnet',
      description: 'Claude Code model sonnet',
    })
  })

  it.each(['', ' sonnet', 'sonnet ', 'line\nbreak', 'x'.repeat(257)])(
    'rejects invalid model id %j',
    (model) => {
      expect(() => validateModelId(model)).toThrow()
    },
  )

  it('rejects a mismatched provider', () => {
    expect(() => resolvedModelInfo('other', 'sonnet', 'sonnet')).toThrow(
      expect.objectContaining({ code: 'CLAUDE_INVALID_PROVIDER' }),
    )
  })
})
