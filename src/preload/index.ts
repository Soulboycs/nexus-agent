import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { AgentEvent, ProviderConfig, IElectronAPI, PermissionMode } from '../shared/types'

const api: IElectronAPI = {
  sendMessage: (prompt: string, workspacePath?: string, sessionId?: string) => {
    return ipcRenderer.invoke('agent:send-message', prompt, workspacePath, sessionId)
  },
  abortAgent: () => {
    return ipcRenderer.invoke('agent:abort')
  },
  abort: (sessionId?: string) => {
    return ipcRenderer.invoke('agent:abort', sessionId)
  },
  respondApproval: (
    requestId: string,
    approved: boolean,
    reason?: string,
    updatedInput?: Record<string, unknown>
  ) => {
    return ipcRenderer.invoke('agent:respond-approval', requestId, approved, reason, updatedInput)
  },
  switchModel: (modelId: string, providerId?: string) => {
    return ipcRenderer.invoke('agent:switch-model', modelId, providerId)
  },
  getProviderConfig: () => {
    return ipcRenderer.invoke('agent:get-config')
  },
  saveProviderConfig: (config: ProviderConfig) => {
    return ipcRenderer.invoke('agent:save-config', config)
  },
  testProviderConnectivity: (params: any) => {
    return ipcRenderer.invoke('agent:test-provider-connectivity', params)
  },
  getCurrentWorkspace: () => {
    return ipcRenderer.invoke('workspace:get-current')
  },
  selectWorkspaceFolder: () => {
    return ipcRenderer.invoke('workspace:select-folder')
  },
  readWorkspaceFiles: (dirPath: string) => {
    return ipcRenderer.invoke('workspace:read-files', dirPath)
  },

  // Sessions Management (JSONL Append-Only Storage)
  listSessions: (workspacePath?: string) => {
    return ipcRenderer.invoke('session:list', workspacePath)
  },
  getSession: (id: string) => {
    return ipcRenderer.invoke('session:get', id)
  },
  createSession: (title?: string, workspacePath?: string) => {
    return ipcRenderer.invoke('session:create', title, workspacePath)
  },
  deleteSession: (id: string) => {
    return ipcRenderer.invoke('session:delete', id)
  },
  saveSession: (session: any) => {
    return ipcRenderer.invoke('session:save', session)
  },
  appendMessage: (sessionId: string, message: any) => {
    return ipcRenderer.invoke('session:appendMessage', sessionId, message)
  },
  claimPersistOwner: (sessionId: string) => {
    return ipcRenderer.invoke('session:claim-persist-owner', sessionId)
  },
  releasePersistOwner: (sessionId: string) => {
    return ipcRenderer.invoke('session:release-persist-owner', sessionId)
  },
  forkSession: (sessionId: string, fromMessageId: string, newTitle?: string) => {
    return ipcRenderer.invoke('session:fork', sessionId, fromMessageId, newTitle)
  },
  setActiveBranch: (sessionId: string, leafMessageId: string) => {
    return ipcRenderer.invoke('session:setActiveBranch', sessionId, leafMessageId)
  },
  renameSession: (sessionId: string, newTitle: string) => {
    return ipcRenderer.invoke('session:rename', sessionId, newTitle)
  },
  setSessionTag: (sessionId: string, tag: string) => {
    return ipcRenderer.invoke('session:setTag', sessionId, tag)
  },

  // 批量通道(计划 §7.2):主进程 agent:event-batch 每 tick 发一批
  // { sessionId, seq, event }。onAgentEventBatch 是原始形态(S6 事件总线消费),
  // onAgentEvent 保留旧签名、由批量通道派生(App.tsx 过渡期零改动)。
  onAgentEventBatch: (callback: (batch: Array<{ sessionId: string; seq: number; event: AgentEvent }>) => void) => {
    const handler = (_: any, batch: Array<{ sessionId: string; seq: number; event: AgentEvent }>) => {
      if (Array.isArray(batch)) callback(batch)
    }
    ipcRenderer.on('agent:event-batch', handler)
    return () => {
      ipcRenderer.removeListener('agent:event-batch', handler)
    }
  },
  onAgentEvent: (callback: (event: AgentEvent) => void) => {
    const handler = (_: any, batch: Array<{ sessionId: string; seq: number; event: AgentEvent }>) => {
      if (Array.isArray(batch)) for (const item of batch) callback(item.event)
    }
    ipcRenderer.on('agent:event-batch', handler)
    return () => {
      ipcRenderer.removeListener('agent:event-batch', handler)
    }
  },
  onTerminalData: (callback: (data: string) => void) => {
    const handler = (_: any, data: string) => callback(data)
    ipcRenderer.on('terminal:data', handler)
    return () => {
      ipcRenderer.removeListener('terminal:data', handler)
    }
  },
  sendTerminalInput: (data: string) => {
    return ipcRenderer.invoke('terminal:input', data)
  },
  onWordFocus: (callback: (detail: { filePath: string }) => void) => {
    const handler = (_: any, detail: any) => callback(detail)
    ipcRenderer.on('agent:word-focus', handler)
    return () => {
      ipcRenderer.removeListener('agent:word-focus', handler)
    }
  },

  setPermissionMode: (mode: PermissionMode) => {
    return ipcRenderer.invoke('agent:set-permission-mode', mode)
  },
  getPermissionMode: () => {
    return ipcRenderer.invoke('agent:get-permission-mode')
  }
}

const docsApi = {
  // Core document operations via IPC
  openDocx: () => ipcRenderer.invoke('docs:open'),
  openDocxPath: (path: string) => ipcRenderer.invoke('docs:open-path', path),
  openDocxDecrypt: (path: string, password: string) => ipcRenderer.invoke('docs:open-decrypt', path, password),
  createBlankDoc: () => ipcRenderer.invoke('docs:create-blank'),
  saveDocx: (path: string, data: ArrayBuffer, auto?: boolean) => ipcRenderer.invoke('docs:save', path, data, auto),
  saveDocxAs: (defaultName: string, data: ArrayBuffer, sourcePath?: string | null) => ipcRenderer.invoke('docs:save-as', defaultName, data, sourcePath),
  saveDocxNew: (defaultName: string, data: ArrayBuffer) => ipcRenderer.invoke('docs:save-as', defaultName, data),
  saveDocxTo: (path: string, data: ArrayBuffer, auto?: boolean) => ipcRenderer.invoke('docs:save', path, data, auto),
  zipSave: (payload: { parsed: unknown; finalBlocks: unknown[]; options?: unknown }) =>
    ipcRenderer.invoke('docs:zip-save', payload),
  pickImage: () => ipcRenderer.invoke('docs:pick-image'),

  // Boot & state consumption
  consumePendingOpenDocx: () => Promise.resolve(null),
  consumeNewBlankDoc: () => Promise.resolve(false),
  consumeAiDocContent: () => Promise.resolve(null),
  consumeHeadlessExport: () => Promise.resolve(null),
  headlessExportDone: () => {},

  // Events & listeners
  onOpenDocx: (callback: (result: any) => void) => {
    const handler = (_: any, result: any) => callback(result)
    ipcRenderer.on('docs:opened', handler)
    return () => {
      ipcRenderer.removeListener('docs:opened', handler)
    }
  },
  onRenamedDocx: (callback: (paths: { oldPath: string; newPath: string }) => void) => {
    const handler = (_: any, paths: any) => callback(paths)
    ipcRenderer.on('docs:renamed', handler)
    return () => {
      ipcRenderer.removeListener('docs:renamed', handler)
    }
  },
  onMenuCommand: () => () => {},
  onCloseCheck: () => () => {},
  reportCloseCheck: () => {},
  onCloseSaveRequest: () => () => {},
  reportCloseSaveResult: () => {},
  onTeardown: () => () => {},
  onChromePressed: () => () => {},
  onViewImage: () => () => {},

  // Preferences & settings
  getLanguage: () => Promise.resolve('zh' as const),
  onLanguageChanged: () => () => {},
  getTheme: () => Promise.resolve('dark' as const),
  onThemeChanged: () => () => {},
  getAutoSaveDefault: () => Promise.resolve({ on: true, updatedAt: Date.now() }),
  onAutoSaveDefaultChanged: () => () => {},
  getAutoSavePref: () => Promise.resolve(true),
  setAutoSavePref: () => Promise.resolve(),
  getAiPanelPrefs: () => Promise.resolve({ width: 380, side: 'right' as const }),
  setAiPanelPrefs: (patch: any) => Promise.resolve({ width: 380, side: 'right', ...patch }),
  onAiPanelPrefsChanged: () => () => {},
  getRecentFiles: () => ipcRenderer.invoke('docs:get-recent'),
  getAiSettings: () => Promise.resolve({ provider: 'anthropic', providers: {} }),
  setAiSettings: () => Promise.resolve(),

  // Password & protection
  setDocPassword: () => Promise.resolve({ ok: true }),
  docPasswordIntentRevision: () => Promise.resolve(0),
  discardDocPasswordIntents: () => Promise.resolve({ ok: true }),

  // Document extra helpers
  convertAltChunkHtml: () => Promise.resolve(null),
  writeRecoveryCopy: () => Promise.resolve({ ok: true }),
  respellKick: () => Promise.resolve(),
  spellDiag: () => {},
  getWordSuggestions: (word: string): string[] => {
    try {
      return webFrame.getWordSuggestions(word)
    } catch {
      return []
    }
  },
  fontMetrics: () => Promise.resolve(null),
  print: (scale?: number) => ipcRenderer.invoke('docs:print', scale),
  exportPdf: (
    defaultName: string,
    pageWidthTwips: number,
    pageHeightTwips: number,
    outPath?: string,
    scale?: number
  ) =>
    ipcRenderer.invoke(
      'docs:export-pdf',
      defaultName,
      pageWidthTwips,
      pageHeightTwips,
      outPath,
      scale
    ),
  exportHtml: (defaultName: string, html: string, outPath?: string) =>
    ipcRenderer.invoke('docs:export-html', defaultName, html, outPath),
  exportMarkdown: () => Promise.resolve({ ok: false }),
  exportPlainText: () => Promise.resolve({ ok: false }),
  exportImages: () => Promise.resolve({ ok: false }),
  writeExportImage: () => Promise.resolve({ ok: true }),
  saveImageAs: () => {},
  reportViewMenuState: () => {},
  copyImageToClipboard: (dataUrl: string, metaJson?: string) =>
    ipcRenderer.invoke('docs:copy-image-to-clipboard', dataUrl, metaJson),
  fetchImage: async (src: string) => {
    try {
      const res = await fetch(src)
      const buf = await res.arrayBuffer()
      return { bytes: new Uint8Array(buf), mimeType: res.headers.get('content-type') || 'image/png' }
    } catch {
      return null
    }
  },
  createDocument: () => Promise.resolve({ ok: false }),
  listDocsTabs: () => Promise.resolve([]),
  openNewTab: () => {},
  focusDocsTab: () => {},

  // Zotero stubs
  zoteroCommand: () => Promise.resolve({ ok: false }),
  onZoteroRequest: () => () => {},
  respondToZotero: () => {},

  // MCP bridge
  onMcpCommand: (callback: (message: any) => void) => {
    const handler = (_: any, message: any) => callback(message)
    ipcRenderer.on('docs:mcp-command', handler)
    return () => {
      ipcRenderer.removeListener('docs:mcp-command', handler)
    }
  },
  reportMcpResult: (result: any) => ipcRenderer.send('docs:mcp-result', result),
  signalMcpReady: (info?: { path?: string | null }) => ipcRenderer.send('docs:mcp-ready', info),
  onWordFileChanged: (callback: (detail: { filePath: string }) => void) => {
    const handler = (_: any, detail: any) => callback(detail)
    ipcRenderer.on('docs:file-changed', handler)
    return () => {
      ipcRenderer.removeListener('docs:file-changed', handler)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electronAPI', api)
    contextBridge.exposeInMainWorld('docsApi', docsApi)
    contextBridge.exposeInMainWorld('desktop', docsApi)
  } catch (error) {
    console.error('Failed to expose APIs in contextIsolated mode:', error)
  }
} else {
  // @ts-ignore
  window.electronAPI = api
  // @ts-ignore
  window.docsApi = docsApi
  // @ts-ignore
  window.desktop = docsApi
}
