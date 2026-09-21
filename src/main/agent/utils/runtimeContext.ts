/**
 * Runtime environment probe (P3 dynamic descriptions).
 *
 * Providers run in both the Electron main process and the Bun sidecar server;
 * only the former has a Word canvas. Instead of importing electron-bound code
 * from providers, the main process registers a probe at startup. Default is
 * false (server / headless), and a throwing probe fails closed.
 */
type BooleanProbe = () => boolean

let docsEditorReadyProbe: BooleanProbe = () => false

export function setDocsEditorReadyProbe(probe: BooleanProbe): void {
  docsEditorReadyProbe = probe
}

export function isDocsEditorReady(): boolean {
  try {
    return Boolean(docsEditorReadyProbe())
  } catch {
    return false
  }
}
