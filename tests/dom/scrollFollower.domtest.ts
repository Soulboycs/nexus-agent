// @vitest-environment happy-dom
/**
 * ScrollFollower DOM 测试 — 2026-09-17 滚动竞态修复的回归保护
 *
 * 核心回归断言：非用户输入源产生的滚动事件（程序滚动 / 流式内容增长导致的
 * smooth 动画中途事件）绝不允许关闭吸底跟随；只有真实用户输入可以。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createScrollFollower, ScrollFollower } from '../../src/renderer/src/utils/scrollFollower'

const SCROLL_HEIGHT = 1000
const CLIENT_HEIGHT = 400

function makeScrollEl(): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollHeight', { get: () => SCROLL_HEIGHT, configurable: true })
  Object.defineProperty(el, 'clientHeight', { get: () => CLIENT_HEIGHT, configurable: true })
  document.body.appendChild(el)
  return el
}

/** 设置 scrollTop 并派发 scroll 事件（模拟浏览器滚动行为） */
function scrollTo(el: HTMLElement, top: number): void {
  el.scrollTop = top
  el.dispatchEvent(new Event('scroll'))
}

describe('ScrollFollower — 输入源检测式智能吸底', () => {
  let el: HTMLDivElement
  let follower: ScrollFollower

  afterEach(() => {
    follower.detach()
    el.remove()
  })

  it('REGRESSION: programmatic scroll events away from bottom never disable following', () => {
    el = makeScrollEl()
    follower = createScrollFollower(el)

    // 模拟旧缺陷场景：smooth 动画中途位置 / 内容增长后落点距底部 > 80px
    scrollTo(el, 100) // distance = 1000 - 100 - 400 = 500 > 80
    expect(follower.isFollowing()).toBe(true) // 旧实现在此误判为"用户上滚"并停摆
  })

  it('follow() snaps to the live bottom instantly via direct scrollTop assignment', () => {
    el = makeScrollEl()
    follower = createScrollFollower(el)

    el.scrollTop = 0
    follower.follow()
    expect(el.scrollTop).toBe(SCROLL_HEIGHT) // 直赋瞬时落底，无动画
  })

  it('wheel-up disables following; follow() becomes a no-op', () => {
    el = makeScrollEl()
    follower = createScrollFollower(el)

    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
    expect(follower.isFollowing()).toBe(false)

    el.scrollTop = 0
    follower.follow()
    expect(el.scrollTop).toBe(0) // 不跟随：绝不与用户抢夺滚动条
  })

  it('wheel-down alone does not disable following (only up-scroll is intent)', () => {
    el = makeScrollEl()
    follower = createScrollFollower(el)

    el.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }))
    expect(follower.isFollowing()).toBe(true)
  })

  it('scrolling back to bottom re-enables following', () => {
    el = makeScrollEl()
    follower = createScrollFollower(el)

    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
    expect(follower.isFollowing()).toBe(false)

    scrollTo(el, SCROLL_HEIGHT - CLIENT_HEIGHT) // distance = 0 < 80
    expect(follower.isFollowing()).toBe(true)
  })

  it('scrollbar drag away from bottom disables following (pointer events)', () => {
    el = makeScrollEl()
    follower = createScrollFollower(el)

    el.dispatchEvent(new Event('pointerdown'))
    scrollTo(el, 300) // 拖拽中离开底部
    expect(follower.isFollowing()).toBe(false)

    window.dispatchEvent(new Event('pointerup'))
    scrollTo(el, SCROLL_HEIGHT - CLIENT_HEIGHT)
    expect(follower.isFollowing()).toBe(true)
  })

  it('navigation keys (PageUp) disable following, but not when typed inside inputs', () => {
    el = makeScrollEl()
    follower = createScrollFollower(el)

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
    expect(follower.isFollowing()).toBe(false)

    // 输入框内的方向键是编辑操作，不构成滚动意图
    follower.forceFollow()
    const input = document.createElement('textarea')
    el.appendChild(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
    expect(follower.isFollowing()).toBe(true)
  })

  it('forceFollow re-enables and snaps immediately (new user message)', () => {
    el = makeScrollEl()
    follower = createScrollFollower(el)

    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
    expect(follower.isFollowing()).toBe(false)

    el.scrollTop = 0
    follower.forceFollow()
    expect(follower.isFollowing()).toBe(true)
    expect(el.scrollTop).toBe(SCROLL_HEIGHT)
  })

  it('detach() removes all listeners', () => {
    el = makeScrollEl()
    follower = createScrollFollower(el)
    follower.detach()

    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
    expect(follower.isFollowing()).toBe(true) // 监听已拆除，状态不再变化
  })

  it('F1a: scrolling back to within 0-80px of bottom re-enables following (hysteresis band)', () => {
    el = makeScrollEl()
    follower = createScrollFollower(el)

    // 用户上滚禁用跟随
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
    expect(follower.isFollowing()).toBe(false)

    // 用户回滚但停在距底 40px（迟滞带内，< 80 阈值）：应视为"回到底部"并恢复跟随。
    // 阈值缩水（如 80→8）会把此处误判为仍未到底 → 跟随无法恢复。
    scrollTo(el, SCROLL_HEIGHT - CLIENT_HEIGHT - 40)
    expect(follower.isFollowing()).toBe(true)

    el.scrollTop = 0
    follower.follow()
    expect(el.scrollTop).toBe(SCROLL_HEIGHT)
  })
})
