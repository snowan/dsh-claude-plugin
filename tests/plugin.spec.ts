import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import * as claudePlugin from '../src/index.js'

class FakeSubprocessRuntime extends SubprocessRuntime {
  override resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(command)
  }

  override spawn(_spec: SubprocessSpawnSpec): SubprocessHandle {
    throw new Error('not exercised by scaffold')
  }

  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('not exercised by scaffold'))
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FakeSubprocessRuntime)
  return ctx
}

describe('DSH plugin registration', () => {
  it('declares both required services', () => {
    expect(claudePlugin.name).toBe('dsh-claude-plugin')
    expect(claudePlugin.inject).toEqual(['llm', 'subprocess'])
  })

  it('registers and disposes the Claude provider with its model catalog', async () => {
    const ctx = await setup()
    const fiber = await ctx.plugin(claudePlugin, { defaultModel: 'opus' })

    expect(ctx.llm.listProviders()).toEqual([{ id: 'claude-code', name: 'Claude Code' }])
    await expect(ctx.llm.listModels('claude-code')).resolves.toMatchObject([
      { id: 'default', name: 'Claude Opus (default)' },
      { id: 'sonnet' },
      { id: 'opus' },
      { id: 'haiku' },
    ])
    const adapter = new claudePlugin.ClaudeCodeAdapter(claudePlugin.resolveConfig())
    expect(adapter.providerInfo('other')).toEqual({ id: 'other', name: 'other' })

    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('returns one deliberate terminal failure instead of hanging or spawning', async () => {
    const ctx = await setup()
    await ctx.plugin(claudePlugin, {})
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'claude-code',
      model: 'default',
      messages: [],
    })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: expect.objectContaining({
            code: 'CLAUDE_TRANSPORT_NOT_IMPLEMENTED',
            message: expect.stringContaining('managed SDK transport milestone'),
          }),
        },
      },
    ])
  })
})
