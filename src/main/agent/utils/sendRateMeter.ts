/**
 * 主进程 send 速率计(计划 §8.3):
 * 口径 = webContents.send 次数(非事件条数)。滚动 1s 窗口,峰值供 perf:get-stats 读取。
 */
export class SendRateMeter {
  private readonly stamps: number[] = []
  private peak = 0

  /** 记录一次 send;now 为任意单调毫秒时基(performance.now / Date.now 均可) */
  record(now: number): void {
    this.stamps.push(now)
    this.prune(now)
  }

  /** 当前时基下的 1s 窗口计数,并更新历史峰值 */
  peakRate(now: number): number {
    this.prune(now)
    const current = this.stamps.length
    if (current > this.peak) this.peak = current
    return this.peak
  }

  reset(): void {
    this.stamps.length = 0
    this.peak = 0
  }

  private prune(now: number): void {
    const cutoff = now - 1000
    while (this.stamps.length > 0 && this.stamps[0] <= cutoff) this.stamps.shift()
  }
}
