import React, { useRef, useEffect, useState } from 'react'
import { Plus, ArrowDown, ArrowUp, Square, Shield, Zap, Check, ChevronUp, ClipboardList } from 'lucide-react'
import { ModelSelector } from './ModelSelector'
import { AgentStatus, ModelProvider, PermissionMode } from '@shared/types'
import {
  extractMentionQuery,
  filterMentionCandidates,
  type MentionCandidate
} from '../utils/mentions'

interface FloatingInputDockProps {
  promptInput: string
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onSend: () => void
  onAbort?: () => void
  onScrollToBottom: () => void
  currentModelId: string
  currentProviderId?: string
  onModelChange: (modelId: string, providerId?: string) => void
  status: AgentStatus
  onOpenSettings?: () => void
  providers?: ModelProvider[]
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** @ 提及候选(§6.7):会话+文档;缺省无弹层 */
  mentionCandidates?: MentionCandidate[]
}

export const FloatingInputDock: React.FC<FloatingInputDockProps> = ({
  promptInput,
  onChange,
  onKeyDown,
  onSend,
  onAbort,
  onScrollToBottom,
  currentModelId,
  currentProviderId,
  onModelChange,
  status,
  onOpenSettings,
  providers,
  permissionMode = 'ask',
  onPermissionModeChange,
  mentionCandidates
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const permRef = useRef<HTMLDivElement>(null)
  const [isPermMenuOpen, setIsPermMenuOpen] = useState(false)

  const mention = mentionCandidates ? extractMentionQuery(promptInput) : null
  const mentionList = mention && mentionCandidates ? filterMentionCandidates(mentionCandidates, mention.query).slice(0, 6) : []
  const insertMention = (c: MentionCandidate) => {
    if (!mention) return
    const next = promptInput.slice(0, mention.start) + '@' + c.name + ' '
    // 复用受控 onChange 管道(父级读取 e.target.value)
    onChange({ target: { value: next } } as unknown as React.ChangeEvent<HTMLTextAreaElement>)
  }

  const isBypass = permissionMode === 'bypass'
  const isPlan = permissionMode === 'plan'
  const isBusy = status === 'thinking' || status === 'tool_executing'
  const canSend = promptInput.trim().length > 0 && !isBusy

  // Close permission menu on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (permRef.current && !permRef.current.contains(e.target as Node)) {
        setIsPermMenuOpen(false)
      }
    }
    if (isPermMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isPermMenuOpen])

  // Auto-resize textarea height
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`
    }
  }, [promptInput])

  return (
    <div className="w-full max-w-3xl mx-auto px-6 pb-4 shrink-0 pointer-events-auto">
      <div className="relative rounded-2xl bg-white border border-neutral-200/90 shadow-[0_8px_30px_rgba(0,0,0,0.06)] p-3 flex flex-col gap-1.5 transition-all focus-within:border-neutral-300">
        {mention && mentionList.length > 0 && (
          <div data-testid="mention-popup" className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-neutral-200 bg-white shadow-lg py-1 z-40">
            {mentionList.map((c) => (
              <button
                key={c.type + c.id}
                type="button"
                data-testid={`mention-${c.type}`}
                onClick={() => insertMention(c)}
                className="w-full text-left px-3 py-1.5 hover:bg-neutral-100 text-xs flex items-center gap-2"
              >
                <span className="text-neutral-400">{c.type === 'session' ? '💬' : '📄'}</span>
                <span className="truncate text-neutral-700">{c.name}</span>
                <span className="ml-auto text-[10px] text-neutral-300">{c.type === 'session' ? '委派' : '上下文'}</span>
              </button>
            ))}
          </div>
        )}
        {/* Multi-line Textarea Input */}
        <textarea
          ref={textareaRef}
          value={promptInput}
          onChange={onChange}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Ask anything, @ to mention, / for actions"
          className="w-full bg-transparent px-1 py-0.5 text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none resize-none max-h-40 leading-relaxed font-sans"
        />

        {/* Bottom Actions Bar (Seamless with no horizontal divider line) */}
        <div className="flex items-center justify-between text-xs pt-0.5">
          {/* Left Action Buttons: + Attachment, Model Capsule & Permission Capsule */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="p-1 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 rounded-md transition-colors"
              title="Add attachment or action"
            >
              <Plus className="w-4 h-4" />
            </button>

            {/* Inlined Model Selector Capsule with Dropup */}
            <ModelSelector
              currentModelId={currentModelId}
              currentProviderId={currentProviderId}
              onModelChange={onModelChange}
              dropDirection="up"
              onOpenSettings={onOpenSettings}
              providers={providers}
            />

            {/* Permission Mode Selector Capsule with Dropup */}
            <div className="relative" ref={permRef}>
              <button
                type="button"
                onClick={() => setIsPermMenuOpen((v) => !v)}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors border shadow-xs ${
                  isBypass
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200/90 hover:bg-emerald-100'
                    : 'bg-neutral-50 text-neutral-600 border-neutral-200/90 hover:bg-neutral-100'
                }`}
                title={
                  isBypass
                    ? '当前为 Bypass 模式：免提示自动批准所有工具执行'
                    : isPlan
                      ? '当前为 Plan 模式：仅允许只读工具，写入与命令一律拒绝'
                      : '当前为 Ask 模式：读/编辑自动放行，命令等其余操作询问确认'
                }
              >
                {isBypass ? (
                  <Zap className="w-3 h-3 text-emerald-600 fill-emerald-500" />
                ) : isPlan ? (
                  <ClipboardList className="w-3 h-3 text-violet-600" />
                ) : (
                  <Shield className="w-3 h-3 text-neutral-500" />
                )}
                <span>{isBypass ? 'Bypass' : isPlan ? 'Plan' : 'Ask'}</span>
                <ChevronUp className={`w-2.5 h-2.5 transition-transform ${isPermMenuOpen ? 'rotate-180' : ''}`} />
              </button>

              {isPermMenuOpen && (
                <div className="absolute bottom-full left-0 mb-1.5 w-52 rounded-xl bg-white border border-neutral-200 shadow-xl py-1.5 z-50 text-xs animate-in fade-in zoom-in-95 duration-100">
                  <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                    权限执行模式
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      onPermissionModeChange?.('bypass')
                      setIsPermMenuOpen(false)
                    }}
                    className={`w-full px-3 py-1.5 flex items-start gap-2 text-left hover:bg-neutral-50 transition-colors ${
                      isBypass ? 'text-emerald-700 bg-emerald-50/50' : 'text-neutral-700'
                    }`}
                  >
                    <Zap className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-600 fill-emerald-500" />
                    <div className="flex-1">
                      <div className="font-medium flex items-center justify-between">
                        <span>Bypass 模式</span>
                        {isBypass && <Check className="w-3.5 h-3.5 text-emerald-600" />}
                      </div>
                      <div className="text-[11px] text-neutral-400 font-normal leading-tight mt-0.5">
                        免确认，所有工具全自动批准执行
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      onPermissionModeChange?.('ask')
                      setIsPermMenuOpen(false)
                    }}
                    className={`w-full px-3 py-1.5 flex items-start gap-2 text-left hover:bg-neutral-50 transition-colors ${
                      permissionMode === 'ask' ? 'text-blue-700 bg-blue-50/50' : 'text-neutral-700'
                    }`}
                  >
                    <Shield className="w-3.5 h-3.5 mt-0.5 shrink-0 text-neutral-500" />
                    <div className="flex-1">
                      <div className="font-medium flex items-center justify-between">
                        <span>Ask 询问模式</span>
                        {permissionMode === 'ask' && <Check className="w-3.5 h-3.5 text-blue-600" />}
                      </div>
                      <div className="text-[11px] text-neutral-400 font-normal leading-tight mt-0.5">
                        读取/编辑自动放行，命令等其余操作询问确认
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      onPermissionModeChange?.('plan')
                      setIsPermMenuOpen(false)
                    }}
                    className={`w-full px-3 py-1.5 flex items-start gap-2 text-left hover:bg-neutral-50 transition-colors ${
                      isPlan ? 'text-violet-700 bg-violet-50/50' : 'text-neutral-700'
                    }`}
                  >
                    <ClipboardList className="w-3.5 h-3.5 mt-0.5 shrink-0 text-violet-600" />
                    <div className="flex-1">
                      <div className="font-medium flex items-center justify-between">
                        <span>Plan 计划模式</span>
                        {isPlan && <Check className="w-3.5 h-3.5 text-violet-600" />}
                      </div>
                      <div className="text-[11px] text-neutral-400 font-normal leading-tight mt-0.5">
                        仅允许只读工具，写入与命令一律拒绝
                      </div>
                    </div>
                  </button>
                </div>
              )}
            </div>
          </div>


          {/* Right Action Buttons: Scroll to bottom & Send / Abort */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onScrollToBottom}
              className="p-1 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 rounded-md transition-colors"
              title="Scroll to bottom"
            >
              <ArrowDown className="w-3.5 h-3.5" />
            </button>

            {isBusy ? (
              <button
                type="button"
                onClick={onAbort}
                className="w-7 h-7 rounded-lg bg-rose-50 border border-rose-200/90 text-rose-600 hover:bg-rose-100 flex items-center justify-center transition-all shadow-xs"
                title="Stop generation"
              >
                <Square className="w-2.5 h-2.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={!canSend}
                className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                  canSend
                    ? 'bg-[#007aff] hover:bg-blue-600 text-white shadow-xs'
                    : 'bg-neutral-100 text-neutral-300 cursor-not-allowed'
                }`}
                title="Send message"
              >
                <ArrowUp className="w-3.5 h-3.5 stroke-[2.2]" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default FloatingInputDock
