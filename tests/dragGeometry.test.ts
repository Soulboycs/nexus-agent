/**
 * TDD Test Suite: P2-S9 落点判定纯函数(Snap 拖拽核心几何)
 * Contract: docs/CONTRACT-P2-S9-drag.md(D1–D6,计划 §5.2)
 */
import { describe, it, expect } from 'bun:test'
import {
  resolveSplitDropPosition,
  computeChipInsertion,
  type Rect
} from '../src/renderer/src/workspace/drag-geometry'

const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, width: w, height: h })

describe('resolveSplitDropPosition — D1 边缘/中央判定', () => {
  const pane = rect(0, 0, 1000, 800)

  it('D1a: 左边缘 15% 环内 → left', () => {
    expect(resolveSplitDropPosition(80, 400, pane)).toBe('left')
  })
  it('D1b: 右边缘 → right;上边缘 → top;下边缘 → bottom', () => {
    expect(resolveSplitDropPosition(960, 400, pane)).toBe('right')
    expect(resolveSplitDropPosition(500, 60, pane)).toBe('top')
    expect(resolveSplitDropPosition(500, 780, pane)).toBe('bottom')
  })
  it('D1c: 中央 40% 矩形(两轴同时在 40% 内)→ center', () => {
    // x∈[300,700), y∈[240,560)
    expect(resolveSplitDropPosition(500, 400, pane)).toBe('center')
    expect(resolveSplitDropPosition(310, 250, pane)).toBe('center')
  })
  it('D1d: 15%~30% 死区按最近边回落(右上角 between)', () => {
    // x=880 在右 15% 环(>=850)→ right
    expect(resolveSplitDropPosition(880, 100, pane)).toBe('right')
    // x=800(距右200 距上100)不在任何环也不在 center → 最近边 = top
    expect(resolveSplitDropPosition(800, 100, pane)).toBe('top')
  })
})

describe('computeChipInsertion — D2 tab 行内插入索引', () => {
  const chipRects = [rect(0, 0, 100, 30), rect(110, 0, 100, 30), rect(220, 0, 100, 30)]

  it('D2a: 拖物中心在目标 chip 中心左侧 → 插其前', () => {
    expect(computeChipInsertion(120, chipRects, 1)).toBe(1) // chip1 中心160,拖心120<160 → index1
    expect(computeChipInsertion(200, chipRects, 2)).toBe(2) // chip2 中心270 → 前插 index2
  })
  it('D2b: 拖物中心在目标 chip 中心右侧 → 插其后', () => {
    expect(computeChipInsertion(200, chipRects, 1)).toBe(2)
  })
  it('D2c: 未命中任何 chip(overIndex=-1)→ 追加到末尾', () => {
    expect(computeChipInsertion(9999, chipRects, -1)).toBe(3)
  })
})
