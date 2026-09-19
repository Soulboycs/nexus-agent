/**
 * Word document state and layout persistence management.
 * Provides safe localStorage operations and cross-component sync events.
 */

export const STORAGE_KEYS = {
  LAST_OPENED_FILE: 'nexus_word_last_opened_file',
  RECENT_FILES: 'nexus_word_recent_files',
  DRAWER_OPEN: 'nexus_word_drawer_open',
  AUXILIARY_TAB: 'nexus_auxiliary_active_tab',
  ACTIVE_SESSION: 'nexus_active_session_id',
  SESSION_WORD_DOCS: 'nexus_session_word_docs',
  SIDEBAR_OPEN: 'nexus_sidebar_open',
} as const

const MAX_RECENT_FILES = 20

/** Get the last opened document path */
export function getLastOpenedWordFile(): string | null {
  try {
    const p = localStorage.getItem(STORAGE_KEYS.LAST_OPENED_FILE)
    return p && p.trim() ? p.trim() : null
  } catch {
    return null
  }
}

/** Set the last opened document path and notify listeners */
export function setLastOpenedWordFile(filePath: string): void {
  if (!filePath || !filePath.trim()) return
  const cleanPath = filePath.trim()
  try {
    localStorage.setItem(STORAGE_KEYS.LAST_OPENED_FILE, cleanPath)
    addRecentWordFile(cleanPath)
  } catch {}
}

/** Clear the last opened document record (e.g. on new blank file) */
export function clearLastOpenedWordFile(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.LAST_OPENED_FILE)
  } catch {}
}

/** Get list of recently opened files */
export function getRecentWordFiles(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.RECENT_FILES)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && !!item.trim()) : []
  } catch {
    return []
  }
}

/** Add a file path to recent files (deduped, newest first, max 20) */
export function addRecentWordFile(filePath: string): void {
  if (!filePath || !filePath.trim()) return
  const cleanPath = filePath.trim()
  try {
    const current = getRecentWordFiles()
    const filtered = current.filter((p) => p.toLowerCase() !== cleanPath.toLowerCase())
    const updated = [cleanPath, ...filtered].slice(0, MAX_RECENT_FILES)
    localStorage.setItem(STORAGE_KEYS.RECENT_FILES, JSON.stringify(updated))
  } catch {}
}

/** Clear all recent files */
export function clearRecentWordFiles(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.RECENT_FILES)
  } catch {}
}

/** Get the session-to-document binding map */
export function getSessionWordDocMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SESSION_WORD_DOCS)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/** Bind a document path to a specific session */
export function setSessionWordDoc(sessionId: string, filePath: string): void {
  if (!sessionId) return
  try {
    const map = getSessionWordDocMap()
    if (!filePath || !filePath.trim()) {
      delete map[sessionId]
    } else {
      map[sessionId] = filePath.trim()
    }
    localStorage.setItem(STORAGE_KEYS.SESSION_WORD_DOCS, JSON.stringify(map))
  } catch {}
}

/** Get the bound document path for a specific session */
export function getSessionWordDoc(sessionId: string): string | null {
  if (!sessionId) return null
  const map = getSessionWordDocMap()
  return map[sessionId] || null
}
