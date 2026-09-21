// @vitest-environment happy-dom
/**
 * P1-S8b 渲染性能探针 DOM 测试(K5–K6,计划 §8.3):
 * - K5 __frameProbe:rAF dt 采样,输出 max/p99(验收口径 max<50ms p99<34ms)
 * - K6 __renderCounts:Profiler 计数器随渲染递增,可断言"跨 pane 零渲染"
 */
import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import {
  installFrameProbe,
  uninstallFrameProbe,
  bumpRenderCount,
  getRenderCount
} from '../../src/renderer/src/utils/perfProbe'

describe('perfProbe — K5 帧探针', () => {
  beforeEach(() => {
    uninstallFrameProbe()
  })

  it('K5: 采样若干帧后输出统计(计数>0,max>=p99>=0)', async () => {
    const probe = installFrameProbe()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120))
    })
    const stats = probe.stats()
    expect(stats.frames).toBeGreaterThan(0)
    expect(stats.max).toBeGreaterThanOrEqual(stats.p99)
    expect(stats.p99).toBeGreaterThanOrEqual(0)
    uninstallFrameProbe()
    const after = probe.stats()
    expect(after.frames).toBe(stats.frames) // 卸载后不再采样
  })
})

describe('perfProbe — K6 渲染计数', () => {
  beforeEach(() => {
    uninstallFrameProbe()
  })

  it('K6: bumpRenderCount 按 id 累积,可读回(跨 pane 零渲染断言的基础)', () => {
    bumpRenderCount('paneA')
    bumpRenderCount('paneA')
    bumpRenderCount('paneB')
    expect(getRenderCount('paneA')).toBe(2)
    expect(getRenderCount('paneB')).toBe(1)
    expect(getRenderCount('paneC')).toBe(0)
  })

  it('K6b: installFrameProbe 挂载 window.__frameProbe / __renderCounts 全局(Playwright 附加点)', () => {
    const probe = installFrameProbe()
    expect((window as any).__frameProbe).toBe(probe)
    expect((window as any).__renderCounts).toBeTypeOf('object')
    uninstallFrameProbe()
    expect((window as any).__frameProbe).toBeUndefined()
  })
})
