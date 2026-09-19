import React, { useState } from 'react'
import {
  Loader2,
  AlertCircle,
  Zap,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  FolderOpen,
  FileCode,
  FileText,
  FileEdit,
  Terminal,
  Search,
  Code2
} from 'lucide-react'
import { ToolCallPayload, ToolResultPayload } from '@shared/types'

export const DcBadge: React.FC<{ className?: string }> = ({ className = 'w-[15px] h-[15px]' }) => (
  <span
    className={`inline-flex items-center justify-center bg-[#18181b] text-white rounded-[4px] text-[8px] font-bold tracking-tight select-none shrink-0 ${className}`}
    style={{ lineHeight: 1 }}
    title="数据/会话/服务检查"
  >
    DC
  </span>
)

export function resolveActionTitle(name: string, args: any): string {
  // 1. Explicit model intention
  if (args?.toolAction && typeof args.toolAction === 'string' && args.toolAction.trim()) {
    return args.toolAction.replace(/^[▲⚡🐙\s]+/, '').trim()
  }
  if (args?.toolSummary && typeof args.toolSummary === 'string' && args.toolSummary.trim()) {
    return args.toolSummary.trim()
  }

  const rawPath = args?.filePath || args?.path || args?.AbsolutePath || ''
  const filename = rawPath ? String(rawPath).split(/[/\\]/).pop() : ''
  const nameLower = name.toLowerCase()

  if (name === 'view_file' || name === 'read_file') {
    return filename ? `查看文件 ${filename}` : '查看代码文件'
  }
  if (name === 'replace_file_content' || name === 'edit_file') {
    return filename ? `修改文件 ${filename}` : '修改代码实现'
  }
  if (name === 'write_to_file' || name === 'write_file') {
    return filename ? `写入文件 ${filename}` : '创建或更新文件'
  }
  if (name === 'run_command' || name === 'execute_command' || name === 'bash') {
    const cmd = args?.command || args?.CommandLine || ''
    if (cmd.includes('test')) return `运行测试: ${cmd}`
    if (cmd.includes('build')) return `编译构建: ${cmd}`
    return cmd ? `执行命令: ${cmd}` : '执行终端命令'
  }
  if (name === 'grep_search') {
    const query = args?.query || args?.Query || ''
    return query ? `检索代码: ${query}` : '搜索代码内容'
  }
  if (name === 'find_by_name' || name === 'glob_find' || nameLower.includes('glob')) {
    const pattern = args?.pattern || args?.Pattern || ''
    return pattern ? `检索工作区文件: ${pattern}` : '扫描工作区文件'
  }
  if (name === 'list_directory' || name === 'list_dir') {
    const dir = filename || args?.directory || args?.dir || args?.DirectoryPath || ''
    return dir ? `浏览目录 ${dir}` : '查看目录结构'
  }
  return `执行操作: ${name}`
}

function resolveCategoryIcon(name: string, args: any, status: 'running' | 'completed' | 'error') {
  if (status === 'running') {
    return <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin shrink-0" />
  }
  if (status === 'error') {
    return <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
  }

  const actionText = (args?.toolAction || '').trim()
  const rawPath = args?.filePath || args?.path || args?.AbsolutePath || ''
  const filename = rawPath ? String(rawPath).split(/[/\\]/).pop()?.toLowerCase() : ''
  const fullPathLower = String(rawPath).toLowerCase()
  const nameLower = name.toLowerCase()

  // 1. 显式绿色/翡翠闪电 (⚡)：最终修复落地、核心命令执行
  if (
    actionText.startsWith('⚡') ||
    actionText.includes('最终验证') ||
    actionText.includes('修复完成')
  ) {
    return <Zap className="w-3.5 h-3.5 text-emerald-500 fill-emerald-500 shrink-0" />
  }

  // 2. 显式三角形分支 (▲)：子任务分析排查
  if (actionText.startsWith('▲')) {
    return <span className="text-[10px] text-neutral-800 font-bold shrink-0 select-none">▲</span>
  }

  // 3. GitHub / 仓库检索 (🐙)
  if (
    actionText.startsWith('Github') ||
    actionText.startsWith('🐙') ||
    actionText.includes('Github') ||
    actionText.includes('Git') ||
    actionText.includes('PostgreSQL')
  ) {
    return (
      <svg className="w-3.5 h-3.5 text-neutral-800 shrink-0 fill-current select-none" viewBox="0 0 24 24">
        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
      </svg>
    )
  }

  // 4. 数据层 / 会话 / 缓存 / 认证 / 跨账号检查 -> DC 徽标
  // (只有真正排查数据、会话、Token、缓存穿透、数据库时才使用 DC 徽标！)
  const isDataOrSession =
    actionText.includes('数据') ||
    actionText.includes('会话') ||
    actionText.includes('登录') ||
    actionText.includes('缓存') ||
    actionText.includes('账户') ||
    actionText.includes('账号') ||
    actionText.includes('session') ||
    actionText.includes('auth') ||
    actionText.includes('token') ||
    actionText.includes('cache') ||
    actionText.includes('database') ||
    fullPathLower.includes('session') ||
    fullPathLower.includes('auth') ||
    fullPathLower.includes('cache') ||
    fullPathLower.includes('db.') ||
    fullPathLower.includes('database')
  if (isDataOrSession) {
    return <DcBadge />
  }

  // 5. 目录浏览 / 查看文件夹结构
  if (
    nameLower === 'list_directory' ||
    nameLower === 'list_dir' ||
    actionText.includes('目录') ||
    actionText.includes('文件夹')
  ) {
    return <FolderOpen className="w-3.5 h-3.5 text-amber-500/90 shrink-0" />
  }

  // 6. 工作区文件检索 / 查找文件路径 / Glob 匹配
  if (
    nameLower === 'find_by_name' ||
    nameLower === 'glob_find' ||
    nameLower.includes('glob') ||
    actionText.includes('检索工作区') ||
    actionText.includes('查找文件')
  ) {
    return <Search className="w-3.5 h-3.5 text-blue-500/90 shrink-0" />
  }

  // 7. 代码全局检索 (grep_search)
  if (nameLower === 'grep_search' || actionText.includes('搜索') || actionText.includes('检索代码')) {
    return <Search className="w-3.5 h-3.5 text-indigo-500/90 shrink-0" />
  }

  // 8. 代码修改 / 写入 / 编辑
  if (
    nameLower === 'replace_file_content' ||
    nameLower === 'edit_file' ||
    nameLower === 'write_to_file' ||
    nameLower === 'write_file' ||
    actionText.includes('修改') ||
    actionText.includes('编辑') ||
    actionText.includes('写入')
  ) {
    return <FileEdit className="w-3.5 h-3.5 text-emerald-600/90 shrink-0" />
  }

  // 9. 终端命令执行 (run_command)
  if (
    nameLower === 'run_command' ||
    nameLower === 'execute_command' ||
    nameLower === 'bash' ||
    actionText.includes('命令') ||
    actionText.includes('终端')
  ) {
    return <Terminal className="w-3.5 h-3.5 text-neutral-700 shrink-0" />
  }

  // 10. 文件查看 (view_file / read_file) 细分：根据文件扩展名展现精细图标
  if (nameLower === 'view_file' || nameLower === 'read_file' || actionText.includes('查看文件') || actionText.includes('读取文件')) {
    if (
      filename?.endsWith('.ts') ||
      filename?.endsWith('.tsx') ||
      filename?.endsWith('.js') ||
      filename?.endsWith('.jsx') ||
      filename?.endsWith('.py')
    ) {
      return <FileCode className="w-3.5 h-3.5 text-blue-600/90 shrink-0" />
    }
    if (
      filename?.endsWith('.json') ||
      filename?.endsWith('.yaml') ||
      filename?.endsWith('.yml') ||
      filename?.endsWith('.toml') ||
      filename?.includes('config')
    ) {
      return <Code2 className="w-3.5 h-3.5 text-purple-600/90 shrink-0" />
    }
    if (filename?.endsWith('.md') || filename?.endsWith('.txt')) {
      return <FileText className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
    }
    return <FileCode className="w-3.5 h-3.5 text-blue-500/90 shrink-0" />
  }

  // 兜底：Code2 代码图标
  return <Code2 className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
}

export interface ActionStepRowProps {
  toolCall: ToolCallPayload
  result?: ToolResultPayload
  status?: 'running' | 'completed' | 'error'
  className?: string
}

export const ActionStepRow: React.FC<ActionStepRowProps> = ({
  toolCall,
  result,
  status = 'completed',
  className = ''
}) => {
  const [isExpanded, setIsExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const title = resolveActionTitle(toolCall.name, toolCall.arguments)
  const icon = resolveCategoryIcon(toolCall.name, toolCall.arguments, status)

  const handleCopyResult = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const contentToCopy = result?.isError
      ? result?.error || ''
      : result?.output || JSON.stringify(toolCall.arguments, null, 2)
    try {
      await navigator.clipboard.writeText(contentToCopy)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy action result:', err)
    }
  }

  return (
    <div className={`my-0.5 group select-none ${className}`}>
      {/* Sleek single action line (1:1 with target screenshot) */}
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 py-0.5 px-1 rounded-md hover:bg-neutral-100/60 cursor-pointer transition-colors w-fit max-w-full"
        title="点击查看执行详情"
      >
        <div className="flex items-center justify-center w-4 h-4 shrink-0">
          {icon}
        </div>

        <span className="text-[13px] font-normal text-[#52525b] hover:text-[#27272a] tracking-tight truncate leading-normal transition-colors">
          {title}
        </span>

        {/* Minimalist expand indicator on hover or when expanded */}
        <div className="opacity-0 group-hover:opacity-100 transition-opacity ml-1 shrink-0 text-neutral-400">
          {isExpanded ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
        </div>
      </div>

      {/* Smooth Micro-Drawer Detail on demand */}
      {isExpanded && (
        <div className="mt-1.5 ml-6 p-3 rounded-xl border border-neutral-200/80 bg-[#f8f9fa] text-xs space-y-2 select-text transition-all duration-150 animate-in fade-in-0">
          <div className="flex items-center justify-between text-[11px] text-neutral-500 font-mono">
            <span>
              {toolCall.name} {result?.isError ? '• 失败' : '• 已完成'}
            </span>
            <button
              onClick={handleCopyResult}
              className="flex items-center gap-1 text-[11px] text-neutral-500 hover:text-neutral-800 hover:bg-white px-1.5 py-0.5 rounded border border-neutral-200 transition-colors"
            >
              {copied ? (
                <>
                  <Check className="w-3 h-3 text-emerald-500" />
                  <span className="text-emerald-500">已复制</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>复制结果</span>
                </>
              )}
            </button>
          </div>

          {/* Diff preview for modifications */}
          {(toolCall.name === 'replace_file_content' ||
            toolCall.name === 'edit_file' ||
            toolCall.name === 'write_to_file' ||
            toolCall.name === 'write_file') && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase font-semibold text-neutral-400">
                修改目标：{String((toolCall.arguments as any)?.filePath || (toolCall.arguments as any)?.path || (toolCall.arguments as any)?.TargetFile || '')}
              </div>
              {toolCall.name === 'replace_file_content' || toolCall.name === 'edit_file' ? (
                <div className="flex flex-col gap-1 font-mono text-[11px]">
                  <pre className="text-rose-600 bg-rose-50/80 border border-rose-200/80 p-2 rounded-lg overflow-x-auto whitespace-pre-wrap">
                    - {String((toolCall.arguments as any)?.targetContent || (toolCall.arguments as any)?.TargetContent || '')}
                  </pre>
                  <pre className="text-emerald-600 bg-emerald-50/80 border border-emerald-200/80 p-2 rounded-lg overflow-x-auto whitespace-pre-wrap">
                    + {String((toolCall.arguments as any)?.replacementContent || (toolCall.arguments as any)?.ReplacementContent || '')}
                  </pre>
                </div>
              ) : (
                <pre className="text-neutral-700 bg-white border border-neutral-200/80 p-2 rounded-lg overflow-x-auto whitespace-pre-wrap font-mono text-[11px]">
                  {String((toolCall.arguments as any)?.content || (toolCall.arguments as any)?.CodeContent || '')}
                </pre>
              )}
            </div>
          )}

          {/* Result or output */}
          {result && (
            <div>
              <div className="text-[10px] uppercase font-semibold text-neutral-400 mb-0.5">
                输出结果:
              </div>
              <pre
                className={`font-mono text-[11px] p-2 rounded-lg overflow-x-auto max-h-48 whitespace-pre-wrap ${
                  result.isError
                    ? 'text-rose-600 bg-rose-50 border border-rose-200'
                    : 'text-neutral-700 bg-white border border-neutral-200/80'
                }`}
              >
                {result.isError ? result.error : result.output || '(无返回内容)'}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
