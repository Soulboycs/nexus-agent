import React, { useEffect, useRef, useState } from 'react'
import { StreamPacer } from '../utils/streamPacer'
import { MarkdownRenderer } from './MarkdownRenderer'

interface StreamingTextProps {
  content: string
  isStreaming?: boolean
  className?: string
  onComplete?: () => void
  /**
   * 直显模式(计划 §8.2 打字机分级):非聚焦 pane 跳过插值与 rAF 循环,
   * content 变化直接进入渲染(合帧后 ~30/s 提交),消除多 pane 下的 rAF setState 风暴。
   */
  instant?: boolean
}

/** S2 心跳阈值：超过该时长未收到新 chunk 且仍在流式中 → 显示 [Receiving...] */
const HEARTBEAT_STALL_MS = 5000
const HEARTBEAT_POLL_MS = 500

export const StreamingText: React.FC<StreamingTextProps> = ({
  content,
  isStreaming = false,
  className = '',
  onComplete,
  instant = false
}) => {
  const pacerRef = useRef<StreamPacer>(new StreamPacer())
  const [displayedText, setDisplayedText] = useState<string>(() => {
    if (!isStreaming || instant) return content || ''
    pacerRef.current.setTarget(content || '')
    return pacerRef.current.getDisplayed()
  })
  const [isStalled, setIsStalled] = useState(false)

  const rafIdRef = useRef<number | null>(null)
  const lastTimeRef = useRef<number>(performance.now())
  // 组件实例是否真正经历过流式阶段：历史消息（从未流式）不播放收尾动画
  const hasStreamedRef = useRef(false)

  useEffect(() => {
    if (instant) {
      // 直显路径:取消任何已存在的循环,内容即状态
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      setDisplayedText(content || '')
      return
    }
    const pacer = pacerRef.current
    pacer.setTarget(content || '')

    const startLoop = (sealWhenDone: boolean) => {
      lastTimeRef.current = performance.now()
      const loop = (currentTime: number) => {
        const dt = currentTime - lastTimeRef.current
        lastTimeRef.current = currentTime
        setDisplayedText(pacer.step(dt, sealWhenDone))
        if (pacer.isDone()) {
          rafIdRef.current = null
          if (sealWhenDone) onComplete?.()
          return
        }
        rafIdRef.current = requestAnimationFrame(loop)
      }
      rafIdRef.current = requestAnimationFrame(loop)
    }

    if (isStreaming) {
      hasStreamedRef.current = true
      if (!rafIdRef.current) startLoop(false)
    } else {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }

      if (!hasStreamedRef.current || pacer.isDone()) {
        // 历史消息或已无积压：直接呈现终态
        pacer.flush()
        setDisplayedText(pacer.getDisplayed())
        return
      }

      // 完成态平滑收尾（isFinished 路径）：~10 帧内排空剩余缓冲后彻底定稿。
      // 该路径由此真正接线 — 修复 2026-09-17 审计发现的"死代码 + 测试测不到生产行为"。
      startLoop(true)
    }

    // R1 修复（2026-09-18 代理A审计）：组件卸载或依赖变化时必须取消 rAF 循环，
    // 否则父级在 finalize 时换装 MarkdownRenderer 卸载本组件后，循环残留继续
    // 对已卸载组件 setState（每回合必触发的泄漏路径）。
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [content, isStreaming, instant, onComplete])

  // S2 心跳：流式中断流/工具长执行超过阈值时提示 [Receiving...]，新数据到达即熄灭
  useEffect(() => {
    const lastUpdateRef = { time: performance.now() }
    setIsStalled(false)
    if (!isStreaming || instant) return

    const id = setInterval(() => {
      setIsStalled(performance.now() - lastUpdateRef.time > HEARTBEAT_STALL_MS)
    }, HEARTBEAT_POLL_MS)
    return () => clearInterval(id)
  }, [content, isStreaming])

  // 处理后台休眠切回前台事件（Visibility change）
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const pacer = pacerRef.current
        if (pacer && isStreaming) {
          // 切回前台立即追上当前帧
          setDisplayedText(pacer.step(500, false))
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [isStreaming])

  return (
    <div className={`relative ${className}`}>
      <MarkdownRenderer content={displayedText} isStreaming={isStreaming} />
      {isStreaming && (
        <span className="inline-flex items-center ml-1 align-baseline">
          <span
            className="inline-block w-1.5 h-3.5 bg-blue-400 translate-y-0.5 animate-pulse rounded-sm opacity-90 shadow-sm"
            style={{ willChange: 'opacity' }}
          />
          {isStalled && (
            <span className="ml-2 text-[11px] font-mono text-amber-400/80 animate-pulse align-middle">
              [Receiving...]
            </span>
          )}
        </span>
      )}
    </div>
  )
}

