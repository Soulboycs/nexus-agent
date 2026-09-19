import { useRef } from 'react'
import { clampNormalizedSizes } from './layout-model'

/**
 * 两阶段拖宽(计划 §4.4,终审修订版):
 * 拖动中只更新父组的本地 preview(flexGrow),pointerup 才写 store(resizeSplit,
 * clampNormalizedSizes 归一)。相邻对算法:Δratio 只分给相邻两格,双侧钳制。
 */
function applyResizePair(
  base: number[],
  index: number,
  deltaRatio: number,
  min = 0.1
): number[] {
  if (index < 0 || index + 1 >= base.length) return base
  const out = [...base]
  const pair = out[index] + out[index + 1]
  let a = out[index] + deltaRatio
  const lo = Math.min(min, pair / 2)
  a = Math.max(lo, Math.min(pair - lo, a))
  out[index] = a
  out[index + 1] = pair - a
  return out
}

export function ResizeHandle({
  direction,
  index,
  sizes,
  onPreview,
  onCommit
}: {
  direction: 'horizontal' | 'vertical'
  index: number
  sizes: number[]
  onPreview: (sizes: number[]) => void
  onCommit: (sizes: number[]) => void
}) {
  const drag = useRef<{ start: number; base: number[]; containerSize: number; latest: number[] } | null>(
    null
  )
  const horizontal = direction === 'horizontal'

  return (
    <div
      role="separator"
      aria-orientation={direction}
      data-testid="resize-handle"
      className={
        horizontal
          ? 'w-px shrink-0 cursor-col-resize bg-neutral-200 hover:bg-blue-400 transition-colors relative'
          : 'h-px shrink-0 cursor-row-resize bg-neutral-200 hover:bg-blue-400 transition-colors relative'
      }
      onPointerDown={(e) => {
        e.stopPropagation()
        e.preventDefault()
        const parent = e.currentTarget.parentElement
        const rect = parent?.getBoundingClientRect()
        drag.current = {
          start: horizontal ? e.clientX : e.clientY,
          base: sizes,
          containerSize: Math.max(1, horizontal ? (rect?.width ?? 1) : (rect?.height ?? 1)),
          latest: sizes
        }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const delta = ((horizontal ? e.clientX : e.clientY) - d.start) / d.containerSize
        d.latest = applyResizePair(d.base, index, delta)
        onPreview(d.latest)
      }}
      onPointerUp={(e) => {
        const d = drag.current
        drag.current = null
        if (!d) return
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {}
        onCommit(clampNormalizedSizes(d.latest))
      }}
    >
      {/* 加宽命中区(视觉 1px,命中 9px) */}
      <div
        className={
          horizontal
            ? 'absolute inset-y-0 -left-1 -right-1'
            : 'absolute inset-x-0 -top-1 -bottom-1'
        }
      />
    </div>
  )
}
