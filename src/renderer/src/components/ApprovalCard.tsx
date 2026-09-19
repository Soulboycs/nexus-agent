import React, { useState } from 'react'
import { ShieldAlert, Check, X, Terminal, Pencil, FileJson } from 'lucide-react'
import { ApprovalRequest } from '@shared/types'

interface ApprovalCardProps {
  request: ApprovalRequest
  onRespond: (approved: boolean, reason?: string, updatedInput?: Record<string, unknown>) => void
}

export const ApprovalCard: React.FC<ApprovalCardProps> = ({ request, onRespond }) => {
  const [rejectReason, setRejectReason] = useState('')
  const [showRejectInput, setShowRejectInput] = useState(false)
  const [showArgsEditor, setShowArgsEditor] = useState(false)
  const [argsText, setArgsText] = useState(() => JSON.stringify(request.arguments ?? {}, null, 2))
  const [argsError, setArgsError] = useState<string | null>(null)

  const isCommand = request.toolName === 'run_command'
  const commandStr = isCommand ? String(request.arguments.command || '') : ''

  /**
   * Approve, optionally with user-edited args (1:1 Claude Code updatedInput).
   * Only send updatedInput when the parsed JSON actually differs from the
   * original arguments — untouched edits must not flag userModified.
   */
  const buildUpdatedInput = (): Record<string, unknown> | undefined | null => {
    if (!showArgsEditor) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(argsText)
    } catch (e: any) {
      setArgsError(`Invalid JSON: ${e.message}`)
      return null
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setArgsError('Parameters must be a JSON object (e.g. {"filePath": "a.ts"})')
      return null
    }
    setArgsError(null)
    const parsedObj = parsed as Record<string, unknown>
    const changed = JSON.stringify(parsedObj) !== JSON.stringify(request.arguments ?? {})
    return changed ? parsedObj : undefined
  }

  const handleApprove = () => {
    const updatedInput = buildUpdatedInput()
    if (updatedInput === null) return // invalid JSON — block approval
    onRespond(true, undefined, updatedInput)
  }

  return (
    <div className="bg-white border border-rose-200/90 rounded-xl p-4 shadow-md mb-4 text-neutral-900 animate-in fade-in slide-in-from-bottom-2">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-rose-50 text-rose-600 rounded-lg shrink-0 border border-rose-100">
          <ShieldAlert className="w-5 h-5" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-rose-600">
              Authorization Required
            </span>
            <span className="text-xs text-neutral-500">
              Tool: <code className="text-rose-700 bg-rose-50 border border-rose-200 px-1 py-0.5 rounded font-mono text-[11px]">{request.toolName}</code>
            </span>
          </div>

          <p className="text-sm text-neutral-800 mb-2 font-medium">
            {request.promptMessage}
          </p>

          {/* Details / Arguments (read-only view) */}
          {isCommand && !showArgsEditor ? (
            <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-2.5 mb-3 font-mono text-xs text-emerald-400 overflow-x-auto flex items-center gap-2 shadow-inner">
              <Terminal className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
              <span>{commandStr}</span>
            </div>
          ) : !showArgsEditor ? (
            <div className="bg-neutral-50 rounded-lg border border-neutral-200 p-2.5 mb-3 font-mono text-xs text-neutral-800 max-h-36 overflow-y-auto">
              <pre>{JSON.stringify(request.arguments, null, 2)}</pre>
            </div>
          ) : null}

          {/* Editable args (P2b updatedInput) */}
          {showArgsEditor && (
            <div className="mb-3">
              <div className="flex items-center gap-1.5 mb-1 text-[11px] font-medium text-neutral-500">
                <FileJson className="w-3.5 h-3.5" />
                <span>编辑工具参数（批准后将替换模型原始参数执行）</span>
              </div>
              <textarea
                value={argsText}
                onChange={(e) => {
                  setArgsText(e.target.value)
                  if (argsError) setArgsError(null)
                }}
                spellCheck={false}
                rows={Math.min(10, Math.max(3, argsText.split('\n').length))}
                className={`w-full bg-white rounded-lg border px-2.5 py-2 font-mono text-xs text-neutral-800 focus:outline-none focus:border-blue-500 resize-y ${
                  argsError ? 'border-rose-400' : 'border-neutral-300'
                }`}
              />
              {argsError && <div className="mt-1 text-[11px] text-rose-600">{argsError}</div>}
            </div>
          )}

          {/* Reject with reason input */}
          {showRejectInput && (
            <div className="mb-3">
              <input
                type="text"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Optional feedback: Why is this action rejected?"
                className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-1.5 text-xs text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-rose-500"
              />
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleApprove}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-medium transition-colors shadow-xs"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Approve & Continue</span>
            </button>

            <button
              type="button"
              onClick={() => setShowArgsEditor((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                showArgsEditor
                  ? 'bg-blue-50 text-blue-700 border-blue-300 hover:bg-blue-100'
                  : 'bg-neutral-100 hover:bg-neutral-200 text-neutral-700 border-neutral-200'
              }`}
              title="批准前修改工具参数（updatedInput）"
            >
              <Pencil className="w-3.5 h-3.5" />
              <span>{showArgsEditor ? 'Editing Parameters…' : 'Edit Parameters'}</span>
            </button>

            {showRejectInput ? (
              <button
                onClick={() => onRespond(false, rejectReason)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-medium transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                <span>Confirm Reject</span>
              </button>
            ) : (
              <button
                onClick={() => setShowRejectInput(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 rounded-lg text-xs font-medium transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                <span>Reject...</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
