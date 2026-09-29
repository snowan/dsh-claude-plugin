import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalEnvironment,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import * as claudePlugin from '../src/index.js'
import type { ClaudeQueryFactory } from '../src/index.js'

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

  override terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    return Promise.reject(new Error('not exercised by scaffold'))
  }
}

class FakeAttachmentRuntime extends AttachmentStore {
  override readonly imageLimits = {
    maxImageBytes: 8 * 1_024 * 1_024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 20 * 1_024 * 1_024,
    maxImagePixels: 64_000_000,
    maxImageDimension: 8_000,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
  }

  override validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.resolve()
  }

  override saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.reject(new Error('not exercised by plugin registration'))
  }

  override readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return Promise.reject(new Error('not exercised by plugin registration'))
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FakeSubprocessRuntime)
  await ctx.plugin(FakeAttachmentRuntime)
  return ctx
}

describe('DSH plugin registration', () => {
  it('declares all required services', () => {
    expect(claudePlugin.name).toBe('dsh-claude-plugin')
    expect(claudePlugin.inject).toEqual(['llm', 'subprocess', 'attachments'])
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
    const adapter = new claudePlugin.ClaudeCodeAdapter(
      claudePlugin.resolveConfig(),
      new claudePlugin.BridgeManager(ctx.subprocess, claudePlugin.resolveConfig()),
    )
    expect(adapter.providerInfo('other')).toEqual({ id: 'other', name: 'other' })

    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('normalizes a synchronous SDK transport failure to one terminal finish', async () => {
    const ctx = await setup()
    const queryFactory: ClaudeQueryFactory = () => {
      throw new Error('fixture transport failed')
    }
    const resolved = claudePlugin.resolveConfig()
    const bridges = new claudePlugin.BridgeManager(ctx.subprocess, resolved, queryFactory)
    ctx.llm.registerAdapter(['claude-code'], new claudePlugin.ClaudeCodeAdapter(resolved, bridges))
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'claude-code',
      model: 'default',
      messages: [
        {
          id: 'fixture-message' as never,
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          source: { kind: 'user' },
        },
      ],
    })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: expect.objectContaining({
            code: 'CLAUDE_TRANSPORT_ERROR',
            message: 'dsh-claude-plugin: unexpected Claude transport failure',
          }),
        },
      },
    ])
  })
})
