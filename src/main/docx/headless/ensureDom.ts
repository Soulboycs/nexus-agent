let installed = false

/**
 * The Word editing stack (Tiptap editor, restricted-HTML parser, op executor,
 * save plan) lives in the renderer tree and is pure apart from needing a DOM.
 * The headless engine runs it inside the Electron main process under jsdom —
 * a DOM needs to exist, not to be seen. Installed once, before any editor
 * module is imported (ProseMirror sniffs the environment at load).
 *
 * Recipe 1:1 with GenOffice packages/cli/src/dom.ts (proven in its CLI); the
 * jsdom import is a plain dependency here, so no createRequire resolution
 * dance is needed (GenOffice hunts for a bundled copy outside its root).
 */
export async function ensureDom(): Promise<void> {
  if (installed) return
  const { JSDOM, VirtualConsole } = (await import('jsdom')) as typeof import('jsdom')
  // a listener-less console swallows jsdom's "not implemented" notes (canvas
  // getContext from the editors' layout probes) that would otherwise hit stderr
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  })
  const w = dom.window as unknown as Record<string, unknown>
  const g = globalThis as unknown as Record<string, unknown>
  for (const key of ['window', 'document', 'navigator']) {
    Object.defineProperty(g, key, {
      value: key === 'window' ? w : w[key],
      configurable: true,
      writable: true,
    })
  }
  for (const key of Object.getOwnPropertyNames(w)) {
    if (key in g) continue
    try {
      g[key] = w[key]
    } catch {}
  }
  g.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const noMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })
  g.matchMedia ??= noMedia
  w.matchMedia ??= noMedia
  g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0)
  g.cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
  const range = (w.Range as { prototype: Record<string, unknown> }).prototype
  range.getClientRects ??= () => []
  range.getBoundingClientRect ??= () => ({
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
  })
  ;(w.document as unknown as Record<string, unknown>).getSelection ??= () => null
  installed = true
}
