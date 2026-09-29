import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import type {
  ImageAttachmentRef,
  ImageMediaType,
  ImageRequestTarget,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { ToolResultMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import {
  CLAUDE_MAX_ENCODED_IMAGE_BYTES,
  CLAUDE_MAX_IMAGE_DIMENSION,
  ClaudeContentEncoder,
  claudeImageTarget,
  type AttachmentReader,
} from '../src/content.js'

const mediaFixtures: Readonly<Record<ImageMediaType, Uint8Array>> = {
  'image/png': Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
  'image/jpeg': Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
  'image/webp': Uint8Array.from([0x52, 0x49, 0x46, 0x46]),
  'image/gif': Uint8Array.from([0x47, 0x49, 0x46, 0x38]),
}

function ref(mediaType: ImageMediaType, suffix: string = mediaType): ImageAttachmentRef {
  const data = mediaFixtures[mediaType]
  return {
    attachmentId: `sha256:${suffix}` as never,
    mediaType,
    bytes: data.byteLength,
    width: 1,
    height: 1,
  }
}

class FixtureAttachments implements AttachmentReader {
  readonly imageLimits = {
    maxImageBytes: 16 * 1_024 * 1_024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 32 * 1_024 * 1_024,
    maxImagePixels: 64_000_000,
    maxImageDimension: 8_000,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
  }
  readonly readImageRequest = vi.fn(
    async (
      attachment: ImageAttachmentRef,
      _target: ImageRequestTarget,
    ): Promise<RequestImageAttachment> => {
      const data = mediaFixtures[attachment.mediaType]
      return {
        variantId: `variant:${String(attachment.attachmentId)}` as never,
        attachment,
        data,
        mediaType: attachment.mediaType,
        bytes: data.byteLength,
        width: 1,
        height: 1,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: attachment.mediaType === 'image/png',
      }
    },
  )
}

function user(content: UserMessage['content']): UserMessage {
  return { id: 'user-image' as never, role: 'user', source: { kind: 'user' }, content }
}

function toolResult(content: unknown[], isError?: boolean): ToolResultMessage {
  return {
    id: 'tool-result' as never,
    role: 'tool',
    source: { kind: 'tool', callId: 'toolu_fixture' as never },
    toolCallId: 'toolu_fixture' as never,
    content,
    ...(isError === undefined ? {} : { isError }),
  } as ToolResultMessage
}

describe('Claude rich-content encoding', () => {
  it.each(Object.keys(mediaFixtures) as ImageMediaType[])(
    'preserves a %s attachment as an SDK base64 image',
    async (mediaType) => {
      const attachments = new FixtureAttachments()
      const encoded = await new ClaudeContentEncoder(attachments).userMessage(
        user([
          { type: 'text', text: 'inspect this' },
          { type: 'image', attachment: ref(mediaType) },
        ]),
      )
      if (typeof encoded.message.content === 'string') throw new Error('expected block content')
      expect(encoded.message.content).toEqual([
        { type: 'text', text: 'inspect this' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: Buffer.from(mediaFixtures[mediaType]).toString('base64'),
          },
        },
      ])
      expect(attachments.readImageRequest).toHaveBeenCalledWith(
        expect.objectContaining({ mediaType }),
        { width: 1, height: 1, maxBytes: CLAUDE_MAX_ENCODED_IMAGE_BYTES },
        undefined,
      )
    },
  )

  it('correlates degraded-history descriptors with retained image blocks', async () => {
    const encoded = await new ClaudeContentEncoder(new FixtureAttachments()).degradedMessage(
      [user([{ type: 'image', attachment: ref('image/png', 'replay') }])],
      'canonical transcript with sha256:replay',
    )
    if (typeof encoded.message.content === 'string') throw new Error('expected block content')
    expect(encoded.shouldQuery).toBe(true)
    expect(encoded.message.content).toHaveLength(3)
    expect(encoded.message.content[1]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('sha256:replay'),
    })
    expect(encoded.message.content[2]).toMatchObject({ type: 'image' })
  })

  it.each(Object.keys(mediaFixtures) as ImageMediaType[])(
    'preserves a %s attachment as an MCP tool-result image',
    async (mediaType) => {
      const encoded = await new ClaudeContentEncoder(new FixtureAttachments()).toolResult(
        toolResult([{ type: 'image', attachment: ref(mediaType) }]),
      )
      expect(encoded.content).toEqual([
        {
          type: 'image',
          mimeType: mediaType,
          data: Buffer.from(mediaFixtures[mediaType]).toString('base64'),
        },
      ])
    },
  )

  it('preserves MCP text, image, embedded resource, link, and structured content', async () => {
    const encoded = await new ClaudeContentEncoder(new FixtureAttachments()).toolResult(
      toolResult([
        { type: 'text', text: 'visible' },
        { type: 'image', attachment: ref('image/webp') },
        {
          type: 'resource',
          resource: { uri: 'file:///fixture.txt', mimeType: 'text/plain', text: 'resource body' },
        },
        {
          type: 'resource-link',
          uri: 'https://example.test/resource',
          name: 'fixture',
          description: 'linked resource',
        },
        { type: 'structured', value: { status: 'ok', count: 2 } },
      ]),
    )
    expect(encoded).toMatchObject({
      structuredContent: { status: 'ok', count: 2 },
      content: [
        { type: 'text', text: 'visible' },
        { type: 'image', mimeType: 'image/webp' },
        { type: 'resource', resource: { text: 'resource body' } },
        { type: 'resource_link', uri: 'https://example.test/resource', name: 'fixture' },
      ],
    })
  })

  it('maps explicit extension errors into model-visible MCP failures', async () => {
    await expect(
      new ClaudeContentEncoder().toolResult(
        toolResult([{ type: 'error', message: 'policy denied', code: 'DENIED' }]),
      ),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'policy denied' }],
      isError: true,
    })
  })

  it('supports data-shaped structured results and the MCP resource_link spelling', async () => {
    await expect(
      new ClaudeContentEncoder().toolResult(
        toolResult([
          { type: 'structured', data: { answer: 42 } },
          { type: 'resource_link', uri: 'https://example.test/direct', name: 'direct' },
        ]),
      ),
    ).resolves.toEqual({
      content: [
        {
          type: 'resource_link',
          uri: 'https://example.test/direct',
          name: 'direct',
        },
      ],
      structuredContent: { answer: 42 },
    })

    await expect(
      new ClaudeContentEncoder().toolResult(
        toolResult([{ type: 'structured', data: { only: true } }]),
      ),
    ).resolves.toEqual({
      content: [{ type: 'text', text: '(structured tool result attached)' }],
      structuredContent: { only: true },
    })
  })

  it('rejects duplicate, unknown, and oversized rich result extensions', async () => {
    const encoder = new ClaudeContentEncoder()
    await expect(
      encoder.toolResult(
        toolResult([
          { type: 'structured', value: { first: true } },
          { type: 'structured', value: { second: true } },
        ]),
      ),
    ).rejects.toThrow(/repeats structured/)
    await expect(encoder.toolResult(toolResult([{ type: 'future-block' }]))).rejects.toThrow(
      /future-block.*unsupported/,
    )
    await expect(
      encoder.toolResult(
        toolResult([{ type: 'resource', resource: { uri: 'x', text: 'x'.repeat(1_024 * 1_024) } }]),
      ),
    ).rejects.toThrow(/inline bound/)
  })

  it('fails closed for missing storage, unsupported MIME, excessive count, size, or dimension', async () => {
    await expect(
      new ClaudeContentEncoder().userMessage(
        user([{ type: 'image', attachment: ref('image/png') }]),
      ),
    ).rejects.toThrow(/attachment service/)

    const attachments = new FixtureAttachments()
    await expect(
      new ClaudeContentEncoder(attachments).userMessage(
        user([
          {
            type: 'image',
            attachment: { ...ref('image/png'), mediaType: 'image/svg+xml' as never },
          },
        ]),
      ),
    ).rejects.toThrow(/media type/)

    await expect(
      new ClaudeContentEncoder(attachments).userMessage(
        user(
          Array.from({ length: 21 }, (_, index) => ({
            type: 'image' as const,
            attachment: ref('image/png', String(index)),
          })),
        ),
      ),
    ).rejects.toThrow(/at most 20/)

    const elevenImages = Array.from({ length: 11 }, (_, index) => ({
      type: 'image' as const,
      attachment: ref('image/png', `batch-${index}`),
    }))
    expect(() =>
      new ClaudeContentEncoder(attachments).assertMessages([
        user(elevenImages),
        user(elevenImages),
      ]),
    ).toThrow(/at most 20/)
    expect(() =>
      new ClaudeContentEncoder(attachments).assertToolResults([
        toolResult(elevenImages),
        toolResult(elevenImages),
      ]),
    ).toThrow(/at most 20/)

    attachments.readImageRequest.mockResolvedValueOnce({
      variantId: 'variant:large' as never,
      attachment: ref('image/png'),
      data: Uint8Array.of(1),
      mediaType: 'image/png',
      bytes: CLAUDE_MAX_ENCODED_IMAGE_BYTES + 1,
      width: 1,
      height: 1,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: true,
    })
    await expect(
      new ClaudeContentEncoder(attachments).userMessage(
        user([{ type: 'image', attachment: ref('image/png') }]),
      ),
    ).rejects.toThrow(/bytes exceed/)

    attachments.readImageRequest.mockResolvedValueOnce({
      variantId: 'variant:wide' as never,
      attachment: ref('image/png'),
      data: Uint8Array.of(1),
      mediaType: 'image/png',
      bytes: 1,
      width: CLAUDE_MAX_IMAGE_DIMENSION + 1,
      height: 1,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: true,
    })
    await expect(
      new ClaudeContentEncoder(attachments).userMessage(
        user([{ type: 'image', attachment: ref('image/png') }]),
      ),
    ).rejects.toThrow(/dimension bound/)

    attachments.readImageRequest.mockResolvedValueOnce({
      variantId: 'variant:mismatch' as never,
      attachment: ref('image/png', 'different'),
      data: Uint8Array.of(1),
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: true,
    })
    await expect(
      new ClaudeContentEncoder(attachments).userMessage(
        user([{ type: 'image', attachment: ref('image/png') }]),
      ),
    ).rejects.toThrow(/identity or media type/)
  })

  it('fits request images inside the pixel budget and the Claude edge bound without enlarging', () => {
    const sized = (width: number, height: number): ImageAttachmentRef => ({
      ...ref('image/png'),
      width,
      height,
    })
    expect(claudeImageTarget(sized(640, 480), 64_000_000, 100)).toEqual({
      width: 640,
      height: 480,
      maxBytes: 100,
    })
    expect(claudeImageTarget(sized(4_000, 4_000), 4_000_000, 100)).toEqual({
      width: 2_000,
      height: 2_000,
      maxBytes: 100,
    })
    expect(claudeImageTarget(sized(16_000, 100), 64_000_000, 100)).toEqual({
      width: CLAUDE_MAX_IMAGE_DIMENSION,
      height: 50,
      maxBytes: 100,
    })
  })

  it('encodes request-only DSH user input that has no durable identity', async () => {
    const encoded = await new ClaudeContentEncoder().userMessage({
      role: 'user',
      content: [{ type: 'text', text: 'title this session' }],
    })
    expect(encoded.message.content).toEqual([{ type: 'text', text: 'title this session' }])
    await expect(
      new ClaudeContentEncoder().userMessage({ role: 'user', content: [] }),
    ).rejects.toThrow(/request user input has no content/)
  })
})
