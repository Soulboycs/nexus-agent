/**
 * 渲染性能探针(计划 §8.3,dev 附加):
 * - installFrameProbe:rAF 循环采样 dt,输出 frames/max/p99 —— 8 路流式 + 拖拽的
 *   "不掉帧"验收口径(max<50ms 且 p99<34ms);Playwright 经 window.__frameProbe 读取。
 * - bumpRenderCount/getRenderCount:SplitRenderer 的 React.Profiler onRender 计数,
 *   断言"单 pane 流式时其余 pane 零渲染"(window.__renderCounts)。
 */

export interface FrameStats {
  frames: number
  /** 最大帧间隔 ms */
  max: number
  /** 99 分位帧间隔 ms */
  p99: number
}

export interface FrameProbe {
  stats(): FrameStats
}

let rafId: number | null = null

export function installFrameProbe(): FrameProbe {
  uninstallFrameProbe()
  const dts: number[] = []
  let last = performance.now()
  const loop = (now: number) => {
    dts.push(now - last)
    last = now
    rafId = requestAnimationFrame(loop)
  }
  rafId = requestAnimationFrame(loop)
  const probe: FrameProbe = {
    stats() {
      const sorted = [...dts].sort((a, b) => a - b)
      const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)
      return {
        frames: sorted.length,
        max: sorted.length ? Math.round(sorted[sorted.length - 1] * 100) / 100 : 0,
        p99: sorted.length ? Math.round(sorted[Math.max(0, idx)] * 100) / 100 : 0
      }
    }
  }
  ;(window as unknown as Record<string, unknown>).__frameProbe = probe
  return probe
}

export function uninstallFrameProbe(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  delete (window as unknown as Record<string, unknown>).__frameProbe
}

export function bumpRenderCount(id: string): void {
  const counts = getRenderCountsStore()
  counts[id] = (counts[id] ?? 0) + 1
}

export function getRenderCount(id: string): number {
  return getRenderCountsStore()[id] ?? 0
}

function getRenderCountsStore(): Record<string, number> {
  const w = window as unknown as Record<string, Record<string, number> | undefined>
  if (!w.__renderCounts) w.__renderCounts = {}
  return w.__renderCounts
}
