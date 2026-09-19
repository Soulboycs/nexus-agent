import { basename } from 'path'

export interface RecentDocEntry {
  path: string
  name: string
  lastOpened: number
}

const recentFiles: RecentDocEntry[] = []

export function recordRecentFile(filePath: string): void {
  const norm = filePath.replace(/\\/g, '/').toLowerCase()
  const idx = recentFiles.findIndex((f) => f.path.replace(/\\/g, '/').toLowerCase() === norm)
  if (idx >= 0) recentFiles.splice(idx, 1)
  recentFiles.unshift({ path: filePath, name: basename(filePath), lastOpened: Date.now() })
  if (recentFiles.length > 20) recentFiles.pop()
}

export function getRecentFiles(): RecentDocEntry[] {
  return recentFiles
}

export function clearRecentFiles(): void {
  recentFiles.length = 0
}
