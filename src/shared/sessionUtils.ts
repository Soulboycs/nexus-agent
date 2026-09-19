import { ChatMessage } from './types'

export function extractSessionTitle(messages?: ChatMessage[], fallbackTitle = 'New Conversation'): string {
  if (!messages || messages.length === 0) return fallbackTitle

  // Find first user message
  const firstUserMsg = messages.find((m) => m.role === 'user' && m.content && m.content.trim().length > 0)
  if (!firstUserMsg) return fallbackTitle

  // Extract clean text, stripping metadata/context XML blocks like <context>...</context>
  let text = firstUserMsg.content.trim()
  text = text.replace(/<(?:context|system|instructions|environment|prompt_context)[\s\S]*?<\/(?:context|system|instructions|environment|prompt_context)>/gi, '')
  text = text.replace(/<[^>]+>/g, '').trim()
  const firstLine = text.split('\n')[0].trim()

  if (!firstLine) return fallbackTitle
  if (firstLine.length <= 30) return firstLine
  return firstLine.slice(0, 27) + '...'
}
