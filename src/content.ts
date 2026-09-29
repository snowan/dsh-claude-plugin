import { Buffer } from 'node:buffer'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type AttachmentStore from '@deepseek-ai/dsh-attachment'
import {
  longEdgeDimensions,
  requestImageDimensions,
  type ImageAttachmentRef,
  type ImageMediaType,
  type ImageRequestTarget,
} from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { toolProtocolError, unsupportedInput } from './errors.js'
import { canonicalToolJson } from './json.js'
import type { ConversationMessage } from './request.js'

export const CLAUDE_MAX_IMAGES_PER_REQUEST = 20
export const CLAUDE_MAX_IMAGE_DIMENSION = 8_000
export const CLAUDE_MAX_BASE64_IMAGE_BYTES = 10 * 1_024 * 1_024
export const CLAUDE_MAX_ENCODED_IMAGE_BYTES = Math.floor(CLAUDE_MAX_BASE64_IMAGE_BYTES / 4) * 3
export const CLAUDE_MAX_IMAGE_PIXELS = CLAUDE_MAX_IMAGE_DIMENSION ** 2
export const MAX_MCP_INLINE_BYTES = 1 * 1_024 * 1_024

export type AttachmentReader = Pick<AttachmentStore, 'imageLimits' | 'readImageRequest'>

type SdkUserContent = Exclude<SDKUserMessage['message']['content'], string>
type SdkUserContentBlock = SdkUserContent[number]

interface EncodedImage {
  readonly sdk: SdkUserContentBlock
  readonly mcp: Extract<CallToolResult['content'][number], { type: 'image' }>
  readonly attachmentId: string
  readonly bytes: number
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function contentType(block: unknown): string {
  return record(block) && typeof block.type === 'string' ? block.type : 'unknown'
}

function imageRefs(blocks: readonly ContentBlock[]): ImageAttachmentRef[] {
  const images: ImageAttachmentRef[] = []
  for (const block of blocks) {
    if (block.type === 'image') images.push(block.attachment)
  }
  return images
}

function messageLabel(message: ConversationMessage): string {
  return message.id === undefined
    ? 'request user input'
    : `message ${JSON.stringify(String(message.id))}`
}

/** Fit one image inside Claude's pixel and per-edge bounds without enlarging it. */
export function claudeImageTarget(
  ref: ImageAttachmentRef,
  maxPixels: number,
  maxBytes: number,
): ImageRequestTarget {
  const fitted = requestImageDimensions(ref.width, ref.height, maxPixels)
  const { width, height } = longEdgeDimensions(
    fitted.width,
    fitted.height,
    CLAUDE_MAX_IMAGE_DIMENSION,
  )
  return { width, height, maxBytes }
}

function extensionResource(block: Readonly<Record<string, unknown>>): unknown {
  if (block.type === 'resource') {
    return { type: 'resource', resource: block.resource }
  }
  if (block.type === 'resource-link' || block.type === 'resource_link') {
    const { type: _type, ...fields } = block
    return { type: 'resource_link', ...fields }
  }
  return undefined
}

function boundedExtension(block: unknown): void {
  let encoded: string
  try {
    encoded = canonicalToolJson(block)
  } catch (error: unknown) {
    throw toolProtocolError('DSH rich tool-result content must be lossless JSON', error)
  }
  if (utf8Bytes(encoded) > MAX_MCP_INLINE_BYTES) {
    throw toolProtocolError(
      `DSH rich tool-result content exceeds the ${MAX_MCP_INLINE_BYTES}-byte inline bound`,
    )
  }
}

/** Resolves durable DSH image references only at the provider request boundary. */
export class ClaudeContentEncoder {
  constructor(readonly attachments?: AttachmentReader) {}

  #requireAttachments(): AttachmentReader {
    if (this.attachments === undefined) {
      throw unsupportedInput('DSH image content requires the @deepseek-ai/dsh-attachment service')
    }
    return this.attachments
  }

  #assertBatch(refs: readonly ImageAttachmentRef[], context: string): void {
    if (refs.length === 0) return
    const attachments = this.#requireAttachments()
    const maxImages = Math.min(
      CLAUDE_MAX_IMAGES_PER_REQUEST,
      attachments.imageLimits.maxImagesPerMessage,
    )
    if (refs.length > maxImages) {
      throw unsupportedInput(
        `${context} contains ${refs.length} images; Claude accepts at most ${maxImages}`,
      )
    }
    const declaredBytes = refs.reduce((total, ref) => total + ref.bytes, 0)
    if (declaredBytes > attachments.imageLimits.maxMessageImageBytes) {
      throw unsupportedInput(
        `${context} declares ${declaredBytes} image bytes, exceeding the DSH message image bound`,
      )
    }
  }

  assertMessages(messages: readonly ConversationMessage[], context = 'Claude request'): void {
    this.#assertBatch(
      messages.flatMap((message) => imageRefs(message.content)),
      context,
    )
  }

  assertToolResults(results: readonly ToolResultMessage[]): void {
    this.#assertBatch(
      results.flatMap((result) => imageRefs(result.content)),
      'DSH tool-result batch',
    )
  }

  async #image(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<EncodedImage> {
    const attachments = this.#requireAttachments()
    if (!attachments.imageLimits.mediaTypes.includes(ref.mediaType)) {
      throw unsupportedInput(
        `DSH attachment media type ${JSON.stringify(ref.mediaType)} is unavailable`,
      )
    }
    const request = await attachments.readImageRequest(
      ref,
      claudeImageTarget(
        ref,
        Math.min(CLAUDE_MAX_IMAGE_PIXELS, attachments.imageLimits.maxImagePixels),
        Math.min(CLAUDE_MAX_ENCODED_IMAGE_BYTES, attachments.imageLimits.maxImageBytes),
      ),
      signal,
    )
    if (
      String(request.attachment.attachmentId) !== String(ref.attachmentId) ||
      !attachments.imageLimits.mediaTypes.includes(request.mediaType)
    ) {
      throw unsupportedInput('DSH attachment request identity or media type is inconsistent')
    }
    if (request.width > CLAUDE_MAX_IMAGE_DIMENSION || request.height > CLAUDE_MAX_IMAGE_DIMENSION) {
      throw unsupportedInput(
        `DSH attachment ${JSON.stringify(String(ref.attachmentId))} exceeds Claude's ${CLAUDE_MAX_IMAGE_DIMENSION}-pixel dimension bound after request encoding`,
      )
    }
    if (
      request.bytes !== request.data.byteLength ||
      request.bytes > CLAUDE_MAX_ENCODED_IMAGE_BYTES
    ) {
      throw unsupportedInput('DSH attachment request bytes exceed Claude image limits')
    }
    const data = Buffer.from(request.data).toString('base64')
    if (utf8Bytes(data) > CLAUDE_MAX_BASE64_IMAGE_BYTES) {
      throw unsupportedInput('DSH attachment base64 payload exceeds Claude image limits')
    }
    const mediaType = request.mediaType as ImageMediaType
    return {
      sdk: {
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data },
      },
      mcp: { type: 'image', mimeType: mediaType, data },
      attachmentId: String(ref.attachmentId),
      bytes: request.bytes,
    }
  }

  async userMessage(message: ConversationMessage, signal?: AbortSignal): Promise<SDKUserMessage> {
    if (message.role !== 'user') {
      throw unsupportedInput('only user messages can enter the live Claude prompt stream')
    }
    const label = messageLabel(message)
    this.#assertBatch(imageRefs(message.content), label)
    const content: SdkUserContentBlock[] = []
    for (const block of message.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text })
      else if (block.type === 'image')
        content.push((await this.#image(block.attachment, signal)).sdk)
      else {
        throw unsupportedInput(
          `${label} contains unsupported ${JSON.stringify(contentType(block))} content`,
        )
      }
    }
    if (content.length === 0) {
      throw unsupportedInput(`${label} has no content`)
    }
    return {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    }
  }

  /** Coalesce one admitted DSH step into the SDK's single querying user frame. */
  async userMessages(
    messages: readonly ConversationMessage[],
    signal?: AbortSignal,
  ): Promise<SDKUserMessage> {
    const content: SdkUserContentBlock[] = []
    for (const message of messages) {
      const encoded = await this.userMessage(message, signal)
      const blocks = encoded.message.content
      if (typeof blocks === 'string') content.push({ type: 'text', text: blocks })
      else content.push(...blocks)
    }
    if (content.length === 0) throw unsupportedInput('Claude request has no user content')
    return {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      shouldQuery: true,
    }
  }

  async degradedMessage(
    messages: readonly ConversationMessage[],
    transcript: string,
    signal?: AbortSignal,
  ): Promise<SDKUserMessage> {
    const refs = messages.flatMap((message) => imageRefs(message.content))
    this.#assertBatch(refs, 'degraded DSH replay')
    const images = await Promise.all(refs.map((ref) => this.#image(ref, signal)))
    const content: SdkUserContentBlock[] = [{ type: 'text', text: transcript }]
    for (const [index, image] of images.entries()) {
      content.push({
        type: 'text',
        text: `\nDSH replay image ${index + 1} (${image.attachmentId}, ${image.bytes} bytes) follows.`,
      })
      content.push(image.sdk)
    }
    return {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      shouldQuery: true,
    }
  }

  async toolResult(result: ToolResultMessage, signal?: AbortSignal): Promise<CallToolResult> {
    this.#assertBatch(imageRefs(result.content), 'DSH tool result')
    const content: CallToolResult['content'] = []
    let structuredContent: Record<string, unknown> | undefined
    let extensionError = false
    for (const rawBlock of result.content as readonly unknown[]) {
      if (!record(rawBlock)) {
        throw toolProtocolError('DSH tool result contains a non-object content block')
      }
      if (rawBlock.type === 'text' && typeof rawBlock.text === 'string') {
        content.push({ type: 'text', text: rawBlock.text })
      } else if (rawBlock.type === 'image' && record(rawBlock.attachment)) {
        content.push(
          (await this.#image(rawBlock.attachment as unknown as ImageAttachmentRef, signal)).mcp,
        )
      } else if (rawBlock.type === 'structured') {
        if (structuredContent !== undefined) {
          throw toolProtocolError('DSH tool result repeats structured content')
        }
        const value = rawBlock.value ?? rawBlock.data
        if (!record(value)) {
          throw toolProtocolError('DSH structured tool-result content must be a JSON object')
        }
        boundedExtension(value)
        structuredContent = { ...value }
      } else if (rawBlock.type === 'error' && typeof rawBlock.message === 'string') {
        boundedExtension(rawBlock)
        content.push({ type: 'text', text: rawBlock.message })
        extensionError = true
      } else {
        const resource = extensionResource(rawBlock)
        if (resource === undefined) {
          throw toolProtocolError(
            `DSH tool result content type ${JSON.stringify(contentType(rawBlock))} is unsupported`,
          )
        }
        boundedExtension(resource)
        content.push(resource as CallToolResult['content'][number])
      }
    }
    if (content.length === 0 && structuredContent !== undefined) {
      content.push({ type: 'text', text: '(structured tool result attached)' })
    }
    const parsed = CallToolResultSchema.safeParse({
      content,
      ...(structuredContent === undefined ? {} : { structuredContent }),
      ...(result.isError === undefined && !extensionError
        ? {}
        : { isError: result.isError === true || extensionError }),
    })
    if (!parsed.success) {
      throw toolProtocolError('DSH rich tool result is not valid MCP content')
    }
    return parsed.data
  }
}
