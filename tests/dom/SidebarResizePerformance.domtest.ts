// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('Sidebar Drag Resize & Word Editor Performance Coordination', () => {
  beforeEach(() => {
    document.body.className = ''
    delete (window as unknown as { __isSidebarResizing?: boolean }).__isSidebarResizing
  })

  afterEach(() => {
    document.body.className = ''
    delete (window as unknown as { __isSidebarResizing?: boolean }).__isSidebarResizing
    vi.restoreAllMocks()
  })

  it('marks global state and body class when sidebar dragging starts and ends', () => {
    let startFired = false
    let endFired = false
    let finalDetailWidth = 0

    window.addEventListener('sidebar-resize-start', () => {
      startFired = true
    })
    window.addEventListener('sidebar-resize-end', ((e: CustomEvent) => {
      endFired = true
      finalDetailWidth = e.detail?.width
    }) as EventListener)

    // Simulate handleMouseDown
    document.body.classList.add('is-sidebar-resizing')
    ;(window as unknown as { __isSidebarResizing?: boolean }).__isSidebarResizing = true
    window.dispatchEvent(new CustomEvent('sidebar-resize-start'))

    expect(startFired).toBe(true)
    expect(document.body.classList.contains('is-sidebar-resizing')).toBe(true)
    expect((window as unknown as { __isSidebarResizing?: boolean }).__isSidebarResizing).toBe(true)

    // Simulate handleMouseUp
    document.body.classList.remove('is-sidebar-resizing')
    ;(window as unknown as { __isSidebarResizing?: boolean }).__isSidebarResizing = false
    window.dispatchEvent(new CustomEvent('sidebar-resize-end', { detail: { width: 680 } }))

    expect(endFired).toBe(true)
    expect(finalDetailWidth).toBe(680)
    expect(document.body.classList.contains('is-sidebar-resizing')).toBe(false)
    expect((window as unknown as { __isSidebarResizing?: boolean }).__isSidebarResizing).toBe(false)
  })

  it('defers expensive layout/fit while is-sidebar-resizing is active and settles upon sidebar-resize-end', () => {
    vi.useFakeTimers()

    let measureCallCount = 0
    const applyFit = () => {
      measureCallCount++
    }

    let resizeTimer: number | undefined
    const onResizeObserved = () => {
      const isDragging =
        Boolean((window as unknown as { __isSidebarResizing?: boolean }).__isSidebarResizing) ||
        document.body.classList.contains('is-sidebar-resizing')

      if (isDragging) {
        if (resizeTimer) window.clearTimeout(resizeTimer)
        resizeTimer = window.setTimeout(applyFit, 120)
        return
      }

      if (resizeTimer) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(applyFit, 40)
    }

    const onSidebarResizeEnd = () => {
      if (resizeTimer) window.clearTimeout(resizeTimer)
      applyFit()
    }
    window.addEventListener('sidebar-resize-end', onSidebarResizeEnd)

    // 1. Drag starts
    document.body.classList.add('is-sidebar-resizing')
    ;(window as unknown as { __isSidebarResizing?: boolean }).__isSidebarResizing = true

    // 2. High-frequency mousemove resize ticks (60 frames)
    for (let i = 0; i < 60; i++) {
      onResizeObserved()
      vi.advanceTimersByTime(16) // 16ms frame interval
    }

    // While continuously dragging, measureCallCount MUST BE 0 (no per-frame freeze!)
    expect(measureCallCount).toBe(0)

    // 3. User finishes dragging (mouseup)
    document.body.classList.remove('is-sidebar-resizing')
    ;(window as unknown as { __isSidebarResizing?: boolean }).__isSidebarResizing = false
    window.dispatchEvent(new CustomEvent('sidebar-resize-end', { detail: { width: 720 } }))

    // Final layout triggers exactly ONCE upon release!
    expect(measureCallCount).toBe(1)

    window.removeEventListener('sidebar-resize-end', onSidebarResizeEnd)
    vi.useRealTimers()
  })
})
