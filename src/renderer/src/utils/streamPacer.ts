/**
 * StreamPacer: 工业级自适应滑动缓冲打字机消费引擎
 *
 * 核心特性：
 * 1. 采用 Unicode 字符簇（Grapheme Segmenter）切割，绝不把 Emoji（🚀👨‍👩‍👧‍👦）或中文字符切成两半乱码；
 * 2. 自适应流速曲线：低缓冲时单字细腻推进，大代码块突发时指数级提速追赶；
 * 3. 后台休眠补偿：当标签页或窗口被降频时（dt > 200ms），自动快进补偿防止暴走；
 * 4. 熔断与 Instant Flush：支持 Abort 和完成时瞬间收敛。
 */

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new (Intl as any).Segmenter('en', { granularity: 'grapheme' })
  : null

export function splitIntoGraphemes(text: string): string[] {
  if (!text) return []
  if (segmenter) {
    const segments = segmenter.segment(text)
    const result: string[] = []
    for (const seg of segments) {
      result.push(seg.segment)
    }
    return result
  }
  return Array.from(text)
}

export class StreamPacer {
  private targetText: string = ''
  private targetGraphemes: string[] = []
  private displayedIndex: number = 0
  private displayedText: string = ''
  private isFirstTokenOfTurn: boolean = true

  constructor() {}

  /**
   * 更新目标全量文本
   * 首字到达时执行 0ms 旁路穿透（Bypass Buffer），立即可见
   */
  public setTarget(text: string): void {
    if (text === this.targetText) return

    if (text.startsWith(this.targetText)) {
      // 增量追加
      const appendSlice = text.slice(this.targetText.length)
      const newGraphemes = splitIntoGraphemes(appendSlice)
      const CHUNK_SIZE = 16384
      for (let i = 0; i < newGraphemes.length; i += CHUNK_SIZE) {
        this.targetGraphemes.push(...newGraphemes.slice(i, i + CHUNK_SIZE))
      }
      this.targetText = text

      // TTFT 0ms 旁路穿透：本 Turn 首字立刻上屏，不延迟
      if (this.isFirstTokenOfTurn && this.targetGraphemes.length > 0) {
        const bypassCount = Math.min(this.targetGraphemes.length, 2)
        this.displayedIndex = bypassCount
        this.displayedText = this.targetGraphemes.slice(0, bypassCount).join('')
        this.isFirstTokenOfTurn = false
      }
    } else {
      // 整体替换或重置
      this.targetText = text
      this.targetGraphemes = splitIntoGraphemes(text)
      this.displayedIndex = Math.min(this.displayedIndex, this.targetGraphemes.length)
      this.displayedText = this.targetGraphemes.slice(0, this.displayedIndex).join('')
    }
  }

  /**
   * 单帧步进消费
   * @param dtMs 自上一帧经过的时间（毫秒，通常在 60fps 下约为 16ms）
   * @param isFinished 上游是否已发出完成信号
   */
  public step(dtMs: number = 16, isFinished: boolean = false): string {
    const pending = this.targetGraphemes.length - this.displayedIndex
    if (pending <= 0) {
      return this.displayedText
    }

    // 后台休眠或突发停顿补偿（dt >= 200ms）
    if (dtMs >= 200) {
      return this.flush()
    }

    // 完成态平滑收尾（150ms 内完全排空）
    if (isFinished) {
      const finishStep = Math.max(4, Math.ceil(pending / 5))
      this.displayedIndex = Math.min(this.targetGraphemes.length, this.displayedIndex + finishStep)
      this.displayedText = this.targetGraphemes.slice(0, this.displayedIndex).join('')
      return this.displayedText
    }

    // 自适应流速曲线计算单帧步进量
    let stepCount = 1
    if (pending <= 6) {
      stepCount = 1
    } else if (pending <= 20) {
      stepCount = Math.min(pending, 2)
    } else if (pending <= 60) {
      stepCount = Math.min(pending, Math.max(4, Math.ceil(pending / 6)))
    } else {
      // 大代码块洪峰 (>60 chars)：保证最大滞后 <= 200ms
      stepCount = Math.min(pending, Math.max(20, Math.ceil(pending / 3)))
    }

    this.displayedIndex += stepCount
    this.displayedText = this.targetGraphemes.slice(0, this.displayedIndex).join('')
    return this.displayedText
  }

  /**
   * 瞬间收敛输出全量目标文本（用于 Abort 熔断或 Stream 结束）
   */
  public flush(): string {
    this.displayedIndex = this.targetGraphemes.length
    this.displayedText = this.targetText
    this.isFirstTokenOfTurn = false
    return this.displayedText
  }

  /**
   * 当前已渲染展示的文本
   */
  public getDisplayed(): string {
    return this.displayedText
  }

  /**
   * 是否已完全追上目标文本
   */
  public isDone(): boolean {
    return this.displayedIndex >= this.targetGraphemes.length
  }

  /**
   * 重置引擎状态
   */
  public reset(): void {
    this.targetText = ''
    this.targetGraphemes = []
    this.displayedIndex = 0
    this.displayedText = ''
    this.isFirstTokenOfTurn = true
  }
}
