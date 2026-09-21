import { app, shell, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { createDefaultAgentEngine, AgentEngine } from './agent'
import { SessionManager, type SessionEngineLike } from './agent/SessionManager'
import { SendRateMeter } from './agent/utils/sendRateMeter'
import { DocConflictDetector } from './agent/utils/docConflictDetector'
import { installTerminalBridge } from './terminal/shellService'
import { createPerfLoadProvider } from './agent/utils/perfLoad'
import { AgentEvent, ProviderConfig, FileTreeNode, PermissionMode, normalizePermissionMode } from '../shared/types'
import { logger } from './utils/logger'
import { registerDocxIpc } from './docx/docxIpc'
import { isDocsEditorReady } from './docx/docsBridge'
import { setDocsEditorReadyProbe } from './agent/utils/runtimeContext'
import { registerCronRunner } from './agent/tools/cronTools'

// E2E 隔离:GUI 测试传入独立 userData,避免污染真实用户数据/布局
if (process.env.NEXUS_TEST_USERDATA) {
  app.setPath('userData', process.env.NEXUS_TEST_USERDATA)
}
try { require('fs').appendFileSync('D:/Agent/tests/gui/.main-debug.log', `[boot] env=${process.env.NEXUS_TEST_USERDATA || 'none'} userData=${app.getPath('userData')}
`) } catch {}

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('disable-gpu-compositing')

process.on('uncaughtException', (err) => {
  console.error('[CRITICAL UNCAUGHT EXCEPTION]', err)
  logger.error('MainProcess', 'CRITICAL UNCAUGHT EXCEPTION', err)
  require('fs').appendFileSync('D:\\Agent\\electron_crash.log', `[UNCAUGHT] ${err.stack || err}\n`)
})
process.on('unhandledRejection', (reason) => {
  console.error('[CRITICAL UNHANDLED REJECTION]', reason)
  logger.error('MainProcess', 'CRITICAL UNHANDLED REJECTION', reason)
  require('fs').appendFileSync('D:\\Agent\\electron_crash.log', `[REJECTION] ${reason}\n`)
})
let mainWindow: BrowserWindow | null = null
let currentWorkspace: string = process.cwd()

// ── 多会话引擎接线(计划 §7.1/§7.2:SessionManager 为唯一引擎源)──
let sessionManager: SessionManager | null = null
/** §8.3 指标:webContents.send 次数口径(滚动 1s 窗口峰值) */
const sendMeter = new SendRateMeter()
/** 跨会话文档写冲突检测(§6.2 规则5):全部引擎共享一份 */
const docConflicts = new DocConflictDetector()
/** renderer 声明落盘所有权的会话(pane 存续期间 main 跳过 onTurnEnd 落盘,防双写) */
const rendererPersistOwned = new Set<string>()
/** sessionId → 创建引擎时烘焙的 workspace(变更时销毁重建,不走 setWorkspaceRoot) */
const engineWorkspace = new Map<string, string>()
/** sessionId → 创建引擎时的 provider 指纹;save-config 后清空 = 全量失效,下次 send 惰性重建 */
const providerFingerprintBySession = new Map<string, string>()
/** SessionManager 工厂取用的"当前创建上下文"(接线层在 ensure 前设置) */
let pendingCreateCtx: {
  workspaceRoot: string
  providerConfig: ProviderConfig
  customProvider?: import('./agent/providers/LLMProvider').ILLMProvider
} | null = null

function providerFingerprint(config: ProviderConfig): string {
  // 整配置序列化(含 providers[] 的 baseURL/apiFormat 变更);仅存内存,不落日志
  return JSON.stringify(config)
}

/** 真实 AgentEngine → SessionEngineLike 适配(仅 respondApproval 签名不同) */
function adaptEngine(engine: AgentEngine): SessionEngineLike {
  const like = engine as unknown as SessionEngineLike
  like.respondApproval = (callId, verdict) => {
    const v = (verdict ?? {}) as { approved?: boolean; reason?: string; updatedInput?: Record<string, unknown> }
    return engine.respondApproval(callId, v.approved !== false, v.reason, v.updatedInput)
  }
  return like
}

// Default configuration path
const configPath = join(app.getPath('userData'), 'agent-config.json')

async function loadConfig(): Promise<ProviderConfig> {
  let config: ProviderConfig
  try {
    const data = await fs.readFile(configPath, 'utf-8')
    config = JSON.parse(data)
  } catch {
    config = {
      model: 'deepseek-chat',
      temperature: 0.2
    }
  }

  // Auto migration / initialization of providers
  if (!config.providers || !Array.isArray(config.providers) || config.providers.length === 0) {
    const { createDefaultProviders } = await import('../shared/models')
    config.providers = createDefaultProviders(config)
  }

  const { findActiveModelAndProvider } = await import('../shared/models')
  let active = findActiveModelAndProvider(
    config.providers,
    config.activeModelId || config.model,
    config.activeProviderId
  )

  if (!active) {
    active = findActiveModelAndProvider(config.providers)
  }

  if (active) {
    config.activeModelId = active.model.id
    config.activeProviderId = active.provider.id
    config.model = active.model.id
    config.baseURL = active.provider.baseURL
    config.apiKey = active.provider.apiKey
    config.providerType = active.provider.id as any
  }

  return config
}

async function saveConfig(config: ProviderConfig): Promise<boolean> {
  try {
    // Keep legacy fields in sync for backward compatibility
    if (config.providers && config.providers.length > 0) {
      const { findActiveModelAndProvider } = await import('../shared/models')
      const active = findActiveModelAndProvider(
        config.providers,
        config.activeModelId || config.model,
        config.activeProviderId
      )
      if (active) {
        config.baseURL = active.provider.baseURL
        config.apiKey = active.provider.apiKey
        config.model = active.model.id
        config.activeModelId = active.model.id
        config.activeProviderId = active.provider.id
        if (active.provider.apiFormat === 'anthropic_messages') {
          config.providerType = 'anthropic'
        } else if (active.provider.id === 'deepseek') {
          config.providerType = 'deepseek'
        } else if (active.provider.id === 'ollama') {
          config.providerType = 'ollama'
        } else {
          config.providerType = 'openai'
        }
      }
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
    // Provider 失效策略(计划 §7.1):全量失效,下次 send 惰性重建,禁止 mid-run setProvider
    providerFingerprintBySession.clear()
    logger.info(
      'MainProcess',
      `Provider config saved; engines will lazily rebuild provider (model="${config.activeModelId || config.model}", provider="${config.activeProviderId || config.providerType}")`
    )
    return true
  } catch (err) {
    console.error('Failed to save config:', err)
    logger.error('MainProcess', 'Failed to save config', err)
    return false
  }
}


async function scanDirectory(dirPath: string, maxDepth = 3, currentDepth = 0): Promise<FileTreeNode[]> {
  if (currentDepth > maxDepth) return []
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const nodes: FileTreeNode[] = []

    for (const entry of entries) {
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'out'
      ) {
        continue
      }

      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        const children = await scanDirectory(fullPath, maxDepth, currentDepth + 1)
        nodes.push({
          name: entry.name,
          path: fullPath,
          isDirectory: true,
          children
        })
      } else {
        nodes.push({
          name: entry.name,
          path: fullPath,
          isDirectory: false
        })
      }
    }

    return nodes.sort((a, b) => {
      if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name)
      return a.isDirectory ? -1 : 1
    })
  } catch {
    return []
  }
}

function createWindow(): void {
  console.log('[DEBUG] createWindow called')
  mainWindow = new BrowserWindow({
    title: 'Antigravity',
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    show: true,
    center: true,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#4b5563',
      height: 28
    },
    webPreferences: {
      preload: existsSync(join(__dirname, '../preload/index.mjs'))
        ? join(__dirname, '../preload/index.mjs')
        : join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  mainWindow.removeMenu()
  mainWindow.setMenu(null)
  mainWindow.setMenuBarVisibility(false)
  mainWindow.show()
  mainWindow.focus()

  mainWindow.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL) => {
    console.error('[LOAD FAILED]', errorCode, errorDescription, validatedURL)
    require('fs').appendFileSync('D:\\Agent\\electron_crash.log', `[LOAD_FAILED] ${errorCode} ${errorDescription} ${validatedURL}\n`)
  })

  mainWindow.webContents.on('render-process-gone', (_, details) => {
    console.error('[RENDER PROCESS GONE]', details)
    require('fs').appendFileSync('D:\\Agent\\electron_crash.log', `[RENDER_GONE] ${JSON.stringify(details)}\n`)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Load HMR URL in development or index.html in production
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

let cronRunnerRegistered = false

async function initAgent() {
  const config = await loadConfig()
  // P3 dynamic descriptions: providers consult this probe (electron-free
  // indirection so the Bun sidecar server stays import-safe, default false).
  setDocsEditorReadyProbe(() => isDocsEditorReady())
  sessionManager = new SessionManager({
    createEngine: () => {
      if (!pendingCreateCtx) throw new Error('Engine factory invoked without create context')
      // R7 Cron：到点且默认会话空闲时把 prompt 作为新用户回合提交（注册一次）
      if (!cronRunnerRegistered) {
        cronRunnerRegistered = true
        registerCronRunner(pendingCreateCtx.workspaceRoot, async (prompt) => {
          const sm = sessionManager
          if (!sm) return
          try {
            await sm.run('cron-scheduled', prompt)
          } catch (err) {
            // 会话忙 → 本轮跳过（fail-closed，不中断正在跑的回合）
            console.log('[cron] scheduled prompt skipped:', (err as Error).message)
          }
        })
      }
      return adaptEngine(
        createDefaultAgentEngine({
          workspaceRoot: pendingCreateCtx.workspaceRoot,
          providerConfig: pendingCreateCtx.providerConfig,
          customProvider: pendingCreateCtx.customProvider,
          docConflict: docConflicts
        })
      )
    },
    onOutbound: (batch) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        sendMeter.record(performance.now())
        mainWindow.webContents.send('agent:event-batch', batch)
      }
    },
    onTurnEnd: (sid) => {
      // §7.1 持久化上移(main 侧):仅当 renderer pane 未声明所有权时兜底落盘。
      // 历史为 LLMMessage(无 blocks),确定性 id `${sid}_h${idx}` 保证幂等。
      if (rendererPersistOwned.has(sid)) return
      void (async () => {
        try {
          const engine = sessionManager?.getEngine(sid)
          if (!engine) return
          const history = (engine as unknown as { getConversationHistory(): Array<{ role: string; content: string }> }).getConversationHistory()
          const transcript = history.filter((m) => m.role === 'user' || m.role === 'assistant')
          const { sessionStore } = await import('./session/sessionStore')
          const existing = await sessionStore.getSession(sid)
          const base = existing ? existing.messages.filter((m) => m.role !== 'system').length : 0
          for (let i = base; i < transcript.length; i++) {
            const m = transcript[i]
            await sessionStore.appendMessage(sid, {
              id: `${sid}_h${i}`,
              role: m.role as 'user' | 'assistant',
              content: m.content,
              timestamp: Date.now() - (transcript.length - i)
            })
          }
        } catch (err) {
          logger.warn('MainProcess', 'onTurnEnd persistence failed:', err)
        }
      })()
    }
  })
}

import { spawn, ChildProcess } from 'child_process'

let serverProcess: ChildProcess | null = null

async function ensureSidecarServer(): Promise<void> {
  try {
    const res = await fetch('http://127.0.0.1:3456/health')
    if (res.ok) {
      console.log('[Sidecar] Bun server already healthy on http://127.0.0.1:3456')
      return
    }
  } catch {}

  const bunPath = process.env.BUN_PATH || 'C:\\Users\\Administrator\\.bun\\bin\\bun.exe'
  const serverScript = join(__dirname, '../../src/server/index.ts')

  try {
    serverProcess = spawn(bunPath, ['run', serverScript], {
      cwd: join(__dirname, '../..'),
      stdio: 'pipe',
      env: { ...process.env, SERVER_PORT: '3456' },
      windowsHide: true
    })
    console.log('[Sidecar] Started local Bun server process')
  } catch (err) {
    console.warn('[Sidecar] Could not spawn local bun sidecar:', err)
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  createWindow()
  registerDocxIpc(() => mainWindow)
  installTerminalBridge(ipcMain, (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:data', data)
  }, () => currentWorkspace)
  await initAgent()

  // IPC: Agent Control
  ipcMain.handle('agent:send-message', async (_, prompt: string, workspacePath?: string, sessionId?: string) => {
    if (!sessionManager) {
      logger.error('IPC', 'sessionManager is not initialized')
      return
    }
    const sid = sessionId?.trim() || randomUUID()
    const ws = workspacePath?.trim() || currentWorkspace
    logger.info('IPC', `Received agent:send-message: "${prompt.slice(0, 80)}" (session: ${sid})`)
    const config = await loadConfig()
    const fp = providerFingerprint(config)

    // workspace/provider 变更 → 引擎销毁重建(忙则推迟到本轮结束,禁止 mid-run setProvider)
    const existing = sessionManager.getEngine(sid)
    if (
      existing &&
      (engineWorkspace.get(sid) !== ws || providerFingerprintBySession.get(sid) !== fp)
    ) {
      const st = existing.getStatus()
      if (st === 'thinking' || st === 'tool_executing') {
        logger.warn(
          'MainProcess',
          `Session ${sid} is busy; engine rebuild (workspace/provider) deferred until turn ends`
        )
      } else {
        sessionManager.dropEngine(sid)
        engineWorkspace.delete(sid)
        providerFingerprintBySession.delete(sid)
        logger.info('MainProcess', `Session ${sid} engine dropped for rebuild (workspace/provider changed)`)
      }
    }

    if (!sessionManager.has(sid)) {
      if (ws !== currentWorkspace) currentWorkspace = ws
      // §8.3 确定性负载:__perf 前缀 → 引擎改用合成流式 provider(无真实 LLM,压测用)
      if (prompt.startsWith('__perf')) logger.info('MainProcess', `__perf engine requested for ${sid}`)
      pendingCreateCtx = {
        workspaceRoot: currentWorkspace,
        providerConfig: config,
        ...(prompt.startsWith('__perf')
          ? {
              customProvider: createPerfLoadProvider({
                totalChars: 6000,
                chunkChars: 120,
                delayMs: 25,
                burstEvery: 8,
                burstChars: 10_240
              })
            }
          : {})
      }
    }

    sessionManager
      .run(sid, prompt)
      .then(() => {
        if (!providerFingerprintBySession.has(sid)) providerFingerprintBySession.set(sid, fp)
        if (!engineWorkspace.has(sid)) engineWorkspace.set(sid, ws)
      })
      .catch((err) => {
        const msg = err?.message || String(err)
        logger.error('MainProcess', `Agent run error: ${msg}`, err)
        sessionManager!.fail(sid, msg)
      })
      .finally(() => {
        docConflicts.releaseSession(sid)
      })
    pendingCreateCtx = null
  })

  ipcMain.handle('session:claim-persist-owner', async (_, sessionId: string) => {
    rendererPersistOwned.add(sessionId)
    return true
  })
  ipcMain.handle('session:release-persist-owner', async (_, sessionId: string) => {
    rendererPersistOwned.delete(sessionId)
    return true
  })

  ipcMain.handle('agent:abort', async (_, sessionId?: string) => {
    // 带sessionId=中止该会话(pane 停止按钮);无参=旧式全量中止
    if (sessionId) sessionManager?.abort(sessionId)
    else sessionManager?.abortAll()
  })

  ipcMain.handle(
    'agent:respond-approval',
    async (
      _,
      requestId: string,
      approved: boolean,
      reason?: string,
      updatedInput?: Record<string, unknown>
    ) => {
      const ok = sessionManager?.respondApprovalByCallId(requestId, { approved, reason, updatedInput })
      if (!ok) logger.warn('IPC', `agent:respond-approval: no pending approval owned by ${requestId}`)
    }
  )

  ipcMain.handle('agent:set-permission-mode', async (_, mode: PermissionMode) => {
    sessionManager?.setDefaultPermissionMode(normalizePermissionMode(mode))
  })

  ipcMain.handle('agent:get-permission-mode', async () => {
    return sessionManager?.getDefaultPermissionMode() ?? 'ask'
  })

  // 性能指标(§8.3,dev):send 次数口径的 1s 窗口峰值,验收 < 60/s
  ipcMain.handle('perf:get-stats', async () => {
    return { sendPeakPerSec: sendMeter.peakRate(performance.now()) }
  })

  // IPC: Configuration
  ipcMain.handle('agent:get-config', async () => {
    return loadConfig()
  })

  ipcMain.handle('agent:save-config', async (_, config: ProviderConfig) => {
    return saveConfig(config)
  })

  ipcMain.handle('agent:test-provider-connectivity', async (_, params: {
    baseURL: string
    apiKey?: string
    apiFormat: 'anthropic_messages' | 'chat_completions' | 'responses'
    modelId?: string
  }) => {
    const { baseURL, apiKey = '', apiFormat, modelId } = params
    const startTime = Date.now()
    const cleanBase = (baseURL || '').replace(/\/+$/, '')

    if (!cleanBase) {
      return { success: false, latencyMs: 0, error: 'Base URL 不能为空' }
    }

    try {
      let targetUrl = ''
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      let body: any = {}

      if (apiFormat === 'anthropic_messages') {
        targetUrl = cleanBase.endsWith('/v1/messages') ? cleanBase : `${cleanBase}/v1/messages`
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = '2023-06-01'
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
        body = {
          model: modelId || 'claude-3-5-haiku-20241022',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }]
        }
      } else if (apiFormat === 'responses') {
        targetUrl = cleanBase.endsWith('/responses') ? cleanBase : `${cleanBase}/responses`
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
        body = {
          model: modelId || 'gpt-4o-mini',
          input: [{ role: 'user', content: 'ping' }],
          max_output_tokens: 1
        }
      } else {
        // chat_completions
        targetUrl = cleanBase.endsWith('/chat/completions') ? cleanBase : `${cleanBase}/chat/completions`
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
        body = {
          model: modelId || 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1
        }
      }

      const res = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(6000)
      })

      const latencyMs = Date.now() - startTime

      if (res.ok) {
        return { success: true, latencyMs, statusCode: res.status }
      } else {
        const errorText = await res.text().catch(() => '')
        let shortMsg = `HTTP ${res.status}`
        try {
          const parsed = JSON.parse(errorText)
          if (parsed.error?.message) shortMsg += `: ${parsed.error.message}`
          else if (parsed.message) shortMsg += `: ${parsed.message}`
        } catch {
          if (errorText) shortMsg += `: ${errorText.slice(0, 100)}`
        }
        return { success: false, latencyMs, statusCode: res.status, error: shortMsg }
      }
    } catch (err: any) {
      const latencyMs = Date.now() - startTime
      let errorMsg = err.message || String(err)
      if (err.name === 'TimeoutError' || errorMsg.includes('aborted')) {
        errorMsg = '请求超时 (超过 6 秒未响应)'
      }
      return { success: false, latencyMs, error: errorMsg }
    }
  })

  ipcMain.handle('agent:switch-model', async (_, modelId: string, providerId?: string) => {
    logger.info('IPC', `agent:switch-model requested: modelId="${modelId}", providerId="${providerId}"`)
    const config = await loadConfig()
    const { findActiveModelAndProvider } = await import('../shared/models')
    const active = findActiveModelAndProvider(config.providers, modelId, providerId)

    if (active) {
      config.activeModelId = active.model.id
      config.activeProviderId = active.provider.id
      config.model = active.model.id
      config.baseURL = active.provider.baseURL
      config.apiKey = active.provider.apiKey
      config.providerType = active.provider.id as any
    } else {
      const { getModelDef } = await import('../shared/models')
      const modelDef = getModelDef(modelId)
      if (!modelDef) return false
      config.model = modelId
      config.activeModelId = modelId
      config.providerType = modelDef.provider as any
    }

    await saveConfig(config)
    return true
  })


  // IPC: Workspace Explorer
  ipcMain.handle('workspace:get-current', async () => {
    return currentWorkspace
  })

  ipcMain.handle('workspace:select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: 'Select Project Workspace Directory'
    })
    if (!result.canceled && result.filePaths.length > 0) {
      currentWorkspace = result.filePaths[0]
      // 引擎 workspace 是 per-session 的:全局选择只影响之后新建的会话引擎
      return currentWorkspace
    }
    return null
  })

  ipcMain.handle('workspace:read-files', async (_, dirPath: string) => {
    return scanDirectory(dirPath || currentWorkspace)
  })

  // IPC: Session Management
  ipcMain.handle('session:list', async (_, workspacePath?: string) => {
    const { sessionStore } = await import('./session/sessionStore')
    return sessionStore.listSessions(workspacePath || currentWorkspace)
  })

  ipcMain.handle('session:get', async (_, id: string) => {
    const { sessionStore } = await import('./session/sessionStore')
    return sessionStore.getSession(id)
  })

  ipcMain.handle('session:create', async (_, title?: string, workspacePath?: string) => {
    const { sessionStore } = await import('./session/sessionStore')
    return sessionStore.createSession(title, workspacePath || currentWorkspace)
  })

  ipcMain.handle('session:delete', async (_, id: string) => {
    const { sessionStore } = await import('./session/sessionStore')
    return sessionStore.deleteSession(id)
  })

  ipcMain.handle('session:save', async (_, session: any) => {
    const { sessionStore } = await import('./session/sessionStore')
    return sessionStore.saveSession(session)
  })

  ipcMain.handle('session:appendMessage', async (_, sessionId: string, message: any) => {
    const { sessionStore } = await import('./session/sessionStore')
    return sessionStore.appendMessage(sessionId, message)
  })

  ipcMain.handle('session:fork', async (_, sessionId: string, fromMessageId: string, newTitle?: string) => {
    const { sessionStore } = await import('./session/sessionStore')
    return sessionStore.forkSession(sessionId, fromMessageId, newTitle)
  })

  ipcMain.handle('session:setActiveBranch', async (_, sessionId: string, leafMessageId: string) => {
    const { sessionStore } = await import('./session/sessionStore')
    return sessionStore.setActiveBranch(sessionId, leafMessageId)
  })

  ipcMain.handle('session:rename', async (_, sessionId: string, newTitle: string) => {
    const { sessionStore } = await import('./session/sessionStore')
    return sessionStore.renameSession(sessionId, newTitle)
  })

  ipcMain.handle('session:setTag', async (_, sessionId: string, tag: string) => {
    const { sessionStore } = await import('./session/sessionStore')
    return sessionStore.setSessionTag(sessionId, tag)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill()
    serverProcess = null
  }
})
