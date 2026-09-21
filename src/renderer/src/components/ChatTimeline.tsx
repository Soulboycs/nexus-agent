import React, { useState, useRef, useEffect, useMemo, memo, useCallback } from 'react'
import {
  Brain,
  ChevronDown,
  ChevronRight,
  ThumbsUp,
  ThumbsDown,
  Copy,
  GitFork,
  Sparkles
} from 'lucide-react'
import { ChatMessage } from '@shared/types'
import { StreamingText } from './StreamingText'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ActionStepRow } from './ActionStepRow'
import { normalizeMessageBlocks } from '../utils/chatReducer'

interface ThinkingBlockProps {
  id: string
  content: string
  isActivelyThinking: boolean
  isExpanded: boolean
  onToggle: () => void
}

const ThinkingBlock: React.FC<ThinkingBlockProps> = ({
  content,
  isActivelyThinking,
  isExpanded,
  onToggle
}) => {
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0)
  const startTimeRef = useRef<number | null>(null)
  const durationRef = useRef<number>(0)

  useEffect(() => {
    if (isActivelyThinking) {
      if (!startTimeRef.current) {
        startTimeRef.current = Date.now()
      }
      const timer = setInterval(() => {
        if (startTimeRef.current) {
          const diff = Math.max(1, Math.floor((Date.now() - startTimeRef.current) / 1000))
          setElapsedSeconds(diff)
          durationRef.current = diff
        }
      }, 500)
      return () => clearInterval(timer)
    } else {
      startTimeRef.current = null
    }
  }, [isActivelyThinking])

  return (
    <div className="my-2 select-none">
      <div className="w-full bg-neutral-50/70 hover:bg-neutral-100/60 border border-neutral-200/70 rounded-xl transition-all overflow-hidden">
        {/* Header Capsule */}
        <div
          onClick={onToggle}
          className="flex items-center justify-between px-3.5 py-2 cursor-pointer select-none group"
        >
          <div className="flex items-center gap-2">
            {isActivelyThinking ? (
              <Sparkles className="w-3.5 h-3.5 text-blue-500 animate-spin-slow shrink-0" />
            ) : (
              <Brain className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
            )}

            {isActivelyThinking ? (
              <span className="text-xs font-medium thinking-shimmer-text flex items-center gap-1.5">
                <span>思考中</span>
                {elapsedSeconds > 0 && (
                  <span className="text-neutral-400 font-normal">
                    ({elapsedSeconds}秒)
                  </span>
                )}
                <span className="inline-flex tracking-tighter text-neutral-400">
                  <span className="animate-pulse">.</span>
                  <span className="animate-pulse delay-100">.</span>
                  <span className="animate-pulse delay-200">.</span>
                </span>
              </span>
            ) : (
              <span className="text-xs font-medium text-neutral-500 group-hover:text-neutral-700 transition-colors">
                {durationRef.current > 0
                  ? `已深度思考 (用时 ${durationRef.current} 秒)`
                  : '已深度思考'}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 text-neutral-400 group-hover:text-neutral-600 transition-colors">
            <span className="text-[11px] font-normal text-neutral-400">
              {isExpanded ? '收起' : '展开'}
            </span>
            <ChevronDown
              className={`w-3.5 h-3.5 transition-transform duration-200 ${
                isExpanded ? 'rotate-180' : ''
              }`}
            />
          </div>
        </div>

        {/* Expanded Thinking Trace Content */}
        {isExpanded && (
          <div className="px-3.5 pb-3 pt-2 text-xs text-neutral-500 leading-relaxed font-sans border-t border-neutral-200/50 select-text whitespace-pre-wrap animate-in fade-in duration-150">
            {content ? (
              <div className="border-l-2 border-neutral-200 pl-3 my-0.5 text-neutral-500 text-[12.5px] leading-relaxed select-text font-sans">
                {content}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-neutral-400 italic text-[12px] py-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                <span>正在组织思考逻辑...</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface ChatTimelineProps {
  messages: ChatMessage[]
  onForkMessage?: (messageId: string) => void
  /**
   * 流式直显(计划 §8.2 打字机分级):由 pane 传入 !active——
   * 非聚焦/隐藏 pane 的流式文本跳过打字机插值,直接渲染全文。
   */
  streamInstant?: boolean
}

const ChatTimelineImpl: React.FC<ChatTimelineProps> = ({ messages, onForkMessage, streamInstant = false }) => {
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({})

  const toggleThinking = useCallback((id: string) => {
    setExpandedThinking((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  return (
    <div className="w-full max-w-4xl mx-auto px-6 py-4 space-y-6">
      {messages.map((msg) => (
        <MessageRow
          key={msg.id}
          msg={msg}
          expandedThinking={expandedThinking}
          onToggleThinking={toggleThinking}
          onForkMessage={onForkMessage}
          streamInstant={streamInstant}
        />
      ))}
    </div>
  )
}

interface MessageRowProps {
  msg: ChatMessage
  expandedThinking: Record<string, boolean>
  onToggleThinking: (id: string) => void
  onForkMessage?: (messageId: string) => void
  streamInstant: boolean
}

/**
 * 单消息渲染行(§8.2 memo 边界 = message 级):
 * chatReducer 对非活跃消息原样返回引用,流式更新时只有活跃行重渲染;
 * normalizeMessageBlocks 下沉到行内 useMemo,不再每帧对每条消息执行。
 */
const MessageRow = memo(
  ({ msg, expandedThinking, onToggleThinking, onForkMessage, streamInstant }: MessageRowProps) => {
    const blocks = useMemo(() => normalizeMessageBlocks(msg), [msg])

    return (
      <div className="cv-auto space-y-4" data-msg-id={msg.id}>
        {/* User Request Card - 1:1 matching Antigravity light card */}
        {msg.role === 'user' && (
          <div className="group relative bg-white border border-neutral-200/80 rounded-2xl p-4 shadow-[0_1px_3px_rgba(0,0,0,0.02)] text-neutral-900 transition-all">
            <div className="text-sm font-normal text-neutral-800 leading-relaxed select-text">
              {msg.content}
            </div>
            {/* Hover actions */}
            <div className="absolute right-3 top-3 opacity-0 group-hover:opacity-100 flex items-center gap-1 text-neutral-400 select-none transition-opacity bg-white/95 backdrop-blur-xs px-1 py-0.5 rounded-lg border border-neutral-200/60 shadow-2xs">
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(msg.content)}
                className="p-1 hover:text-neutral-600 rounded hover:bg-neutral-100 transition-colors"
                title="复制内容"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onForkMessage?.(msg.id)}
                className="p-1 hover:text-neutral-600 rounded hover:bg-neutral-100 transition-colors"
                title="从此处创建分叉会话 (Fork)"
              >
                <GitFork className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Assistant Message - Sequential Interleaved Stream */}
        {msg.role === 'assistant' && (
          <div className="space-y-2">
            <div className="text-[11px] text-neutral-400 flex items-center gap-1 font-normal select-none mb-1">
              <span>Response</span>
              <ChevronRight className="w-3 h-3 text-neutral-400" />
            </div>

            {/* Empty placeholder pulse during initial connection before first token */}
            {msg.isStreaming && blocks.length === 0 && (
              <div className="flex items-center gap-2 py-2 text-neutral-400 text-xs">
                <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-ping" />
                <span>Agent 正在连接分析...</span>
              </div>
            )}

            {/* Interleaved Blocks: Ordered stream of text, tools, and thinking */}
            {blocks.map((block, idx) => {
              if (block.type === 'thinking') {
                const isActivelyThinking = !!msg.isStreaming && idx === blocks.length - 1
                const isThinkingExpanded =
                  expandedThinking[block.id] !== undefined
                    ? expandedThinking[block.id]
                    : isActivelyThinking

                return (
                  <ThinkingBlock
                    key={block.id}
                    id={block.id}
                    content={block.content}
                    isActivelyThinking={isActivelyThinking}
                    isExpanded={isThinkingExpanded}
                    onToggle={() => onToggleThinking(block.id)}
                  />
                )
              }

              if (block.type === 'tool') {
                return (
                  <ActionStepRow
                    key={block.id}
                    toolCall={block.toolCall}
                    result={block.result}
                    status={block.status}
                  />
                )
              }

              if (block.type === 'text') {
                const isLastBlock = idx === blocks.length - 1
                const isActivelyStreaming = isLastBlock && !!msg.isStreaming

                return (
                  <div
                    key={block.id}
                    className="text-[14px] text-neutral-800 leading-relaxed py-0.5"
                  >
                    {isActivelyStreaming ? (
                      <StreamingText
                        content={block.content || ''}
                        isStreaming={true}
                        instant={streamInstant}
                      />
                    ) : (
                      <MarkdownRenderer
                        content={block.content || ''}
                        isStreaming={false}
                      />
                    )}
                  </div>
                )
              }

              return null
            })}

            {/* Footer Feedback Actions */}
            {!msg.isStreaming && msg.content && (
              <div className="flex items-center justify-end gap-1 pt-2 text-neutral-400 select-none">
                <button
                  type="button"
                  className="p-1 hover:text-neutral-600 rounded hover:bg-neutral-100 transition-colors"
                  title="Good response"
                >
                  <ThumbsUp className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  className="p-1 hover:text-neutral-600 rounded hover:bg-neutral-100 transition-colors"
                  title="Bad response"
                >
                  <ThumbsDown className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(msg.content)}
                  className="p-1 hover:text-neutral-600 rounded hover:bg-neutral-100 transition-colors"
                  title="Copy message"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onForkMessage?.(msg.id)}
                  className="p-1 hover:text-neutral-600 rounded hover:bg-neutral-100 transition-colors"
                  title="从此处创建分叉会话 (Fork)"
                >
                  <GitFork className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }
)

export const ChatTimeline = memo(ChatTimelineImpl)


