import {
  offloadedImageText,
  projectOffloadedImages,
  type AssistantMessage,
  type GenerateOptions,
  type RequestMessage,
  type RequestUserInput,
  type SystemMessage,
  type ToolResultMessage,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { unsupportedInput } from './errors.js'

/** DSH conversation entries the Claude bridge can represent: user input, Claude output, and tool results. */
export type ConversationMessage =
  UserMessage | RequestUserInput | AssistantMessage | ToolResultMessage

/** One DSH request with its system prompt separated from the conversation Claude replays. */
export interface ClaudeGenerateOptions extends Omit<GenerateOptions, 'messages'> {
  readonly messages: readonly ConversationMessage[]
}

function systemText(message: SystemMessage): string {
  return message.content
    .map((block) => {
      if (block.type !== 'text') {
        throw unsupportedInput(
          `the DSH system prompt contains unsupported ${JSON.stringify(block.type)} content`,
        )
      }
      return block.text
    })
    .join('\n\n')
}

function conversationMessage(message: RequestMessage): ConversationMessage {
  switch (message.role) {
    case 'user':
    case 'assistant':
    case 'tool':
      return message
    case 'system':
      throw unsupportedInput('Claude Code reads only a leading DSH system prompt message')
    case 'developer':
      throw unsupportedInput('Claude Code does not accept DSH developer tool-update messages')
    default:
      throw unsupportedInput(
        `DSH message role ${JSON.stringify((message as { role: unknown }).role)} is unsupported`,
      )
  }
}

/**
 * Separate a DSH request's leading system message from its conversation and
 * replace offloaded images with the DSH placeholder text. A request carries
 * its system prompt either in `options.system` or in one leading system
 * message; supplying both is rejected.
 * @param options - the request exactly as the DSH runtime dispatched it.
 * @returns the same request with `system` resolved and only conversation messages left.
 */
export function claudeGenerateOptions(options: GenerateOptions): ClaudeGenerateOptions {
  let messages: readonly RequestMessage[] = options.messages
  let system = options.system
  const leading = messages[0]
  if (leading?.role === 'system') {
    if (system !== undefined) {
      throw unsupportedInput('a DSH request supplied both a system option and a system message')
    }
    system = systemText(leading)
    messages = messages.slice(1)
  }
  const conversation = projectOffloadedImages(messages, (ref) => offloadedImageText(ref)).map(
    conversationMessage,
  )
  const { system: _system, messages: _messages, ...rest } = options
  return { ...rest, ...(system === undefined ? {} : { system }), messages: conversation }
}
