/**
 * Snap 拖拽落点几何(计划 §5.2,阶段二 S9):
 * 纯函数,零 React/DnD 依赖——可 bun 直测。
 *
 * 语义(与 paseo 一致):
 * - 落点"选择"用指针(pointerWithin),pane 内"位置判定"用被拖物中心点——
 *   纯指针会在 chip 尚未到边时误触发 split;
 * - 边缘 15% 环 → split(对半);中央 40% 矩形(两轴同时)→ 堆叠;
 * - 两者之间的死区按最近边回落;
 * - tab 行内插入:比较被拖 chip 中心 X 与目标 chip 中心 X。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type SplitDropPosition = 'left' | 'right' | 'top' | 'bottom' | 'center'

export const EDGE_RATIO = 0.15
export const CENTER_RATIO = 0.4

/** pane 内落点判定:px/py 为被拖物中心点坐标(指针已选定该 pane) */
export function resolveSplitDropPosition(
  px: number,
  py: number,
  pane: Rect
): SplitDropPosition {
  const { x, y, width, height } = pane
  const edgeW = width * EDGE_RATIO
  const edgeH = height * EDGE_RATIO
  const cx = x + width / 2
  const cy = y + height / 2
  const halfCW = (width * CENTER_RATIO) / 2
  const halfCH = (height * CENTER_RATIO) / 2

  // 中央矩形(两轴同时在内)
  const inCenterX = px >= cx - halfCW && px <= cx + halfCW
  const inCenterY = py >= cy - halfCH && py <= cy + halfCH
  if (inCenterX && inCenterY) return 'center'

  // 四个边缘环
  const inLeft = px <= x + edgeW
  const inRight = px >= x + width - edgeW
  const inTop = py <= y + edgeH
  const inBottom = py >= y + height - edgeH
  if (inLeft) return 'left'
  if (inRight) return 'right'
  if (inTop) return 'top'
  if (inBottom) return 'bottom'

  // 死区:按最近边回落
  const dLeft = px - x
  const dRight = x + width - px
  const dTop = py - y
  const dBottom = y + height - py
  const min = Math.min(dLeft, dRight, dTop, dBottom)
  if (min === dTop) return 'top'
  if (min === dBottom) return 'bottom'
  if (min === dLeft) return 'left'
  return 'right'
}

/** tab 行内插入索引:dragCx = 被拖 chip 中心 X;overIndex = 命中的 chip 下标 */
export function computeChipInsertion(
  dragCx: number,
  chipRects: Rect[],
  overIndex: number
): number {
  if (overIndex < 0 || overIndex >= chipRects.length) return chipRects.length
  const over = chipRects[overIndex]
  const overCx = over.x + over.width / 2
  return dragCx < overCx ? overIndex : overIndex + 1
}

// ── 标签栏分级自适应(§5.2,M5):宽度驱动形态,× 永远可见 ──

export type TabBarMode = 'comfortable' | 'narrow' | 'tiny'

/** 按窗格宽度(TabBar 实测宽)解析形态:
 *  comfortable ≥300:完整形态(标题+×+全部分割按钮)
 *  narrow 180–299:隐藏一键分割图标(保留在 … 菜单),标题截断,× 可见
 *  tiny <180:标题缩为图标,× 缩小仍可见 */
export function resolveTabBarMode(width: number): TabBarMode {
  if (width >= 300) return 'comfortable'
  if (width >= 180) return 'narrow'
  return 'tiny'
}
