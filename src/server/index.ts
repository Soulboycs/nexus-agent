import { ServerWebSocket } from 'bun'
import { sessionDb } from './services/db'
import { ClientMessage, ServerMessage } from './ws/events'
import { query, QueryTerminal } from '../agent/core/query'
import { ToolOrchestrator } from '../agent/core/ToolOrchestrator'
import { createDefaultAgentEngine } from '../main/agent/index'
import { MockLLMProvider, OpenAICompatibleProvider } from '../main/agent/providers/LLMProvider'
import { ProviderConfig, normalizePermissionMode, PermissionMode } from '../shared/types'
import path from 'path'
import os from 'os'
import fs from 'fs'
import crypto from 'crypto'

export function getGitCommit(): string {
  try {
    const gitDir = path.join(process.cwd(), '.git')
    if (fs.existsSync(gitDir)) {
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim()
      if (head.startsWith('ref: ')) {
        const refPath = head.slice(5)
        const commitFile = path.join(gitDir, refPath)
        if (fs.existsSync(commitFile)) {
          return fs.readFileSync(commitFile, 'utf-8').trim().slice(0, 7)
        }
        const packedRefs = path.join(gitDir, 'packed-refs')
        if (fs.existsSync(packedRefs)) {
          const lines = fs.readFileSync(packedRefs, 'utf-8').split('\n')
          for (const line of lines) {
            if (line.endsWith(refPath)) {
              return line.split(' ')[0].slice(0, 7)
            }
          }
        }
      } else {
        return head.slice(0, 7)
      }
    }
  } catch {}
  return process.env.GIT_COMMIT || 'development'
}

export function verifyGitHubSignature(secret: string, signatureHeader: string | null, rawBody: string): boolean {
  if (!secret) return true
  if (!signatureHeader) return false
  const hmac = crypto.createHmac('sha256', secret)
  const calculated = 'sha256=' + hmac.update(rawBody).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(calculated))
  } catch {
    return false
  }
}

export function triggerDeployTask(branch: string, commit?: string) {
  console.log(`[Webhook] Triggering automated deployment for ${branch} (${commit || 'latest'})...`)
  const deployScript = path.join(process.cwd(), 'scripts', 'webhook-deploy.sh')

  if (os.platform() === 'linux') {
    const bashCmd = fs.existsSync(deployScript)
      ? `/bin/bash "${deployScript}"`
      : `cd /opt/claude-code-agent && git fetch origin main && git reset --hard origin/main && /usr/local/bin/bun install --production && systemctl restart claude-code-agent.service`

    if (fs.existsSync('/usr/bin/systemd-run')) {
      const unitName = `claude-deploy-${Date.now()}`
      try {
        Bun.spawn(['/usr/bin/systemd-run', `--unit=${unitName}`, '--setenv=HOME=/root', '/bin/bash', '-c', bashCmd], {
          stdout: 'inherit',
          stderr: 'inherit',
        })
      } catch (err) {
        console.error('[Webhook] systemd-run error:', err)
      }
    } else {
      try {
        Bun.spawn(['/bin/bash', '-c', `nohup bash -c '${bashCmd}' > /var/log/claude-code-agent-deploy.log 2>&1 &`], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
      } catch (err) {
        console.error('[Webhook] spawn error:', err)
      }
    }
  } else {
    console.log('[Webhook] Deployment trigger simulated on non-Linux platform')
  }
}

export interface WebSocketData {
  sessionId: string
  channel: 'client' | 'sdk'
  connectedAt: number
}

// Active session controllers
interface ActiveSession {
  abortController?: AbortController
  pendingApprovals: Map<string, (approved: boolean) => void>
}

const activeSessions = new Map<string, ActiveSession>()
const connectedClients = new Map<string, Set<ServerWebSocket<WebSocketData>>>()

// Local provider config
const configPath = path.join(os.homedir(), '.claude-agent', 'config.json')

function loadProviderConfig(): ProviderConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch {
    return {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY || '',
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: 'gpt-4o',
      temperature: 0.2,
    }
  }
}

function saveProviderConfig(cfg: ProviderConfig): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8')
}

export function broadcastToSession(sessionId: string, message: ServerMessage) {
  const clients = connectedClients.get(sessionId)
  if (!clients) return
  const payload = JSON.stringify(message)
  for (const ws of clients) {
    try {
      ws.send(payload)
    } catch {}
  }
}

export function startServer(port = 3456, host = process.env.SERVER_HOST || '0.0.0.0') {
  return Bun.serve<WebSocketData>({
    port,
    hostname: host,
    idleTimeout: 0, // Disable idle timeout for stable Windows socket pools

    async fetch(req, server) {
      const url = new URL(req.url)

      // 1. Health Probe
      if (url.pathname === '/health') {
        return Response.json({
          name: 'NEXUS AGENT',
          status: 'ok',
          runtime: 'bun',
          version: Bun.version,
          commit: getGitCommit(),
          timestamp: new Date().toISOString(),
        })
      }

      // 1.1 Download & Landing Web Page (GET / or /download)
      if (url.pathname === '/' || url.pathname === '/download') {
        const htmlPath = path.join(import.meta.dir, 'public', 'index.html')
        if (fs.existsSync(htmlPath)) {
          const html = fs.readFileSync(htmlPath, 'utf-8')
          return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        }
      }

      // 1.2 Desktop Windows Client Download (/download/desktop or /downloads/NEXUS-AGENT-Windows-x64.zip)
      if (url.pathname === '/download/desktop' || url.pathname === '/downloads/NEXUS-AGENT-Windows-x64.zip') {
        const localZip = path.join(process.cwd(), 'public', 'downloads', 'NEXUS-AGENT-Windows-x64.zip')
        if (fs.existsSync(localZip)) {
          const file = Bun.file(localZip)
          return new Response(file, {
            headers: {
              'Content-Type': 'application/zip',
              'Content-Disposition': 'attachment; filename="NEXUS-AGENT-Windows-x64.zip"',
              'Content-Length': String(fs.statSync(localZip).size),
            },
          })
        }
        // Fallback to source bundle if desktop client not available
        return Response.redirect('/download/source', 302)
      }

      // 1.3 Source & CLI Release Download Endpoint (/download/source or /download/latest)
      if (url.pathname === '/download/source' || url.pathname === '/download/latest' || url.pathname === '/downloads/nexus-agent-latest.zip') {
        const localZip = path.join(process.cwd(), 'public', 'downloads', 'nexus-agent-latest.zip')
        if (fs.existsSync(localZip)) {
          const file = Bun.file(localZip)
          return new Response(file, {
            headers: {
              'Content-Type': 'application/zip',
              'Content-Disposition': `attachment; filename="nexus-agent-${getGitCommit()}.zip"`,
              'Content-Length': String(fs.statSync(localZip).size),
            },
          })
        }
        // Fallback to GitHub Release Archive
        return Response.redirect('https://github.com/Soulboycs/nexus-agent/archive/refs/heads/main.zip', 302)
      }

      // 1.4 Generic Downloads File Serving
      if (url.pathname.startsWith('/downloads/')) {
        const fileName = path.basename(url.pathname)
        const filePath = path.join(process.cwd(), 'public', 'downloads', fileName)
        if (fs.existsSync(filePath)) {
          return new Response(Bun.file(filePath), {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': `attachment; filename="${fileName}"`,
              'Content-Length': String(fs.statSync(filePath).size),
            },
          })
        }
      }

      // 2. CORS Preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-GitHub-Event, X-Hub-Signature-256',
          },
        })
      }

      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-GitHub-Event, X-Hub-Signature-256',
      }

      // 3. WebSocket Upgrade (/ws/:sessionId)
      if (url.pathname.startsWith('/ws/')) {
        const sessionId = url.pathname.slice(4)
        if (!sessionId) {
          return new Response('Missing sessionId', { status: 400 })
        }

        const upgraded = server.upgrade(req, {
          data: {
            sessionId,
            channel: 'client',
            connectedAt: Date.now(),
          },
        })

        if (upgraded) return undefined
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      // 4. REST API: Sessions
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        return Response.json(sessionDb.list(), { headers: corsHeaders })
      }

      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const body = (await req.json()) as any
        const id = body.id || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
        const workDir = body.workDir || process.cwd()
        const title = body.title || 'New Session'
        const session = sessionDb.create(id, workDir, title)
        return Response.json(session, { status: 201, headers: corsHeaders })
      }

      if (url.pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
        const id = url.pathname.slice('/api/sessions/'.length)
        sessionDb.delete(id)
        return Response.json({ success: true }, { headers: corsHeaders })
      }

      // 5. REST API: Config
      if (url.pathname === '/api/config' && req.method === 'GET') {
        return Response.json(loadProviderConfig(), { headers: corsHeaders })
      }

      if (url.pathname === '/api/config' && req.method === 'POST') {
        const body = (await req.json()) as ProviderConfig
        saveProviderConfig(body)
        return Response.json({ success: true }, { headers: corsHeaders })
      }

      // 6. Push-to-Deploy GitHub Webhook
      if (url.pathname === '/api/webhook/deploy') {
        if (req.method === 'GET') {
          return Response.json({
            status: 'ready',
            endpoint: '/api/webhook/deploy',
            targetBranch: 'refs/heads/main',
            commit: getGitCommit(),
          }, { headers: corsHeaders })
        }

        if (req.method === 'POST') {
          const rawBody = await req.text()
          const secret = process.env.WEBHOOK_SECRET || process.env.DEPLOY_WEBHOOK_SECRET || ''

          if (secret) {
            const sig = req.headers.get('x-hub-signature-256')
            if (!verifyGitHubSignature(secret, sig, rawBody)) {
              return Response.json({ error: 'Invalid webhook signature' }, { status: 401, headers: corsHeaders })
            }
          }

          const ghEvent = req.headers.get('x-github-event')
          if (ghEvent === 'ping') {
            return Response.json({ status: 'pong', message: 'GitHub webhook ping received' }, { headers: corsHeaders })
          }

          let payload: any = {}
          try {
            payload = JSON.parse(rawBody)
          } catch {
            try {
              const params = new URLSearchParams(rawBody)
              const rawPayload = params.get('payload')
              if (rawPayload) payload = JSON.parse(rawPayload)
            } catch {}
          }

          const ref = payload.ref || ''
          if (ref === 'refs/heads/main' || !ref) {
            const commitSha = payload.after || payload.head_commit?.id || 'latest'
            triggerDeployTask(ref || 'refs/heads/main', commitSha)

            return Response.json({
              success: true,
              message: 'Automated deployment triggered successfully for refs/heads/main',
              ref: ref || 'refs/heads/main',
              commit: commitSha,
            }, { headers: corsHeaders })
          }

          return Response.json({
            success: false,
            message: `Ignored push event for ref: ${ref} (only refs/heads/main triggers deployment)`,
          }, { headers: corsHeaders })
        }
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders })
    },

    websocket: {
      open(ws) {
        const { sessionId } = ws.data
        if (!connectedClients.has(sessionId)) {
          connectedClients.set(sessionId, new Set())
        }
        connectedClients.get(sessionId)!.add(ws)

        if (!activeSessions.has(sessionId)) {
          activeSessions.set(sessionId, { pendingApprovals: new Map() })
        }

        // Initial handshake
        ws.send(JSON.stringify({ type: 'connected', sessionId }))
        ws.send(JSON.stringify({ type: 'session_state', turnState: 'idle' }))
      },

      async message(ws, message) {
        const { sessionId } = ws.data
        let clientMsg: ClientMessage
        try {
          clientMsg = JSON.parse(String(message))
        } catch {
          return
        }

        const sessionState = activeSessions.get(sessionId) || { pendingApprovals: new Map() }
        activeSessions.set(sessionId, sessionState)

        if (clientMsg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }))
          return
        }

        if (clientMsg.type === 'permission_response') {
          const resolver = sessionState.pendingApprovals.get(clientMsg.requestId)
          if (resolver) {
            resolver(
              clientMsg.updatedInput
                ? { approved: clientMsg.allowed, updatedInput: clientMsg.updatedInput }
                : clientMsg.allowed
            )
            sessionState.pendingApprovals.delete(clientMsg.requestId)
          }
          broadcastToSession(sessionId, {
            type: 'permission_resolved',
            requestId: clientMsg.requestId,
            allowed: clientMsg.allowed,
          })
          return
        }

        if (clientMsg.type === 'stop_generation') {
          sessionState.abortController?.abort()
          sessionState.abortController = undefined
          broadcastToSession(sessionId, {
            type: 'status',
            state: 'idle',
            message: 'Generation stopped by user.',
          })
          return
        }

        if (clientMsg.type === 'set_permission_mode') {
          ;(sessionState as any).permissionMode = normalizePermissionMode(clientMsg.mode)
          broadcastToSession(sessionId, {
            type: 'status',
            state: 'idle',
            message: `Permission mode set to ${(sessionState as any).permissionMode}.`,
          })
          return
        }

        if (clientMsg.type === 'user_message') {
          const session = sessionDb.get(sessionId)
          const workDir = session?.workDir || process.cwd()

          sessionState.abortController = new AbortController()
          const signal = sessionState.abortController.signal

          broadcastToSession(sessionId, { type: 'session_state', turnState: 'running' })
          broadcastToSession(sessionId, { type: 'status', state: 'thinking' })

          const engine = createDefaultAgentEngine({ workspaceRoot: workDir })
          const orchestrator = new ToolOrchestrator(engine.getToolRegistry())
          const cfg = loadProviderConfig()
          const provider = cfg.apiKey ? new OpenAICompatibleProvider(cfg) : new MockLLMProvider()

          // Security gate (review fix): the server path previously ran the
          // query with no permission engine and no sandbox — tool-level
          // requiresApproval was the only guard. Reuse the engine's gate stack;
          // approval mode defaults to 'ask' per session (set_permission_mode).
          const permissionEngine = engine.getPermissionEngine()
          const sandboxGuard = engine.getSandboxGuard()
          const permissionMode: PermissionMode = normalizePermissionMode(
            (sessionState as any).permissionMode ?? session?.permissionMode
          )

          // Execute query state machine
          const q = query({
            messages: [
              {
                role: 'system',
                content:
                  'You are an expert autonomous AI Coding Agent. Inspect files and run commands to complete tasks.',
              },
              { role: 'user', content: clientMsg.content },
            ],
            toolRegistry: engine.getToolRegistry(),
            orchestrator,
            provider,
            workspaceRoot: workDir,
            signal,
            permissionEngine,
            sandboxGuard,
            permissionMode,
            onApprovalRequired: (req) => {
              return new Promise<boolean | import('../shared/types').ApprovalVerdict>((resolve) => {
                sessionState.pendingApprovals.set(req.id, resolve)
                broadcastToSession(sessionId, {
                  type: 'permission_request',
                  requestId: req.id,
                  toolName: req.toolName,
                  toolUseId: req.toolCallId,
                  input: req.arguments,
                  description: req.promptMessage,
                })
              })
            },
          })

          try {
            for await (const event of q) {
              if (event.type === 'thinking_delta') {
                broadcastToSession(sessionId, { type: 'thinking', text: event.delta })
              } else if (event.type === 'message_delta') {
                broadcastToSession(sessionId, { type: 'content_delta', text: event.delta })
              } else if (event.type === 'tool_call_start') {
                broadcastToSession(sessionId, {
                  type: 'content_start',
                  blockType: 'tool_use',
                  toolName: event.toolCall.name,
                  toolUseId: event.toolCall.id,
                })
                broadcastToSession(sessionId, {
                  type: 'tool_use_complete',
                  toolName: event.toolCall.name,
                  toolUseId: event.toolCall.id,
                  input: event.toolCall.arguments,
                })
              } else if (event.type === 'tool_call_complete') {
                broadcastToSession(sessionId, {
                  type: 'tool_result',
                  toolUseId: event.result.toolCallId,
                  content: event.result.output || event.result.error,
                  isError: event.result.isError,
                })
              } else if (event.type === 'status_change') {
                broadcastToSession(sessionId, {
                  type: 'status',
                  state: event.status as any,
                  message: event.message,
                })
              }
            }

            broadcastToSession(sessionId, { type: 'message_complete' })
            broadcastToSession(sessionId, { type: 'session_state', turnState: 'idle' })
          } catch (err: any) {
            broadcastToSession(sessionId, {
              type: 'error',
              message: String(err?.message || err),
            })
            broadcastToSession(sessionId, { type: 'session_state', turnState: 'idle' })
          } finally {
            sessionState.abortController = undefined
          }
        }
      },

      close(ws) {
        const { sessionId } = ws.data
        const clients = connectedClients.get(sessionId)
        if (clients) {
          clients.delete(ws)
          if (clients.size === 0) {
            connectedClients.delete(sessionId)
          }
        }
      },
    },
  })
}

// Standalone execution
if (import.meta.main) {
  const port = parseInt(process.env.SERVER_PORT || '3456', 10)
  const host = process.env.SERVER_HOST || '0.0.0.0'
  const server = startServer(port, host)
  console.log(`[Bun.serve] Claude Code Agent server listening on http://${host}:${port}`)
}
