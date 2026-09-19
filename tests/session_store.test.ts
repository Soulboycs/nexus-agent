import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test'
import { join } from 'path'
import fs from 'fs/promises'
import { existsSync, readFileSync, appendFileSync } from 'fs'
import {
  SessionStore,
  extractSessionTitle,
  buildConversationChain,
  sanitizePath,
  extractFirstPromptFromHead,
  extractLastJsonStringField,
  extractJsonStringField
} from '../src/main/session/sessionStore'
import { ChatMessage, SessionRecord } from '../src/shared/types'

const TEST_DIR = join(process.cwd(), 'tests', '.temp_sessions_' + Date.now())

describe('SessionStore & Title Derivation — TDD Test Suite', () => {
  let store: SessionStore

  beforeAll(async () => {
    store = new SessionStore(TEST_DIR)
    await store.init()
  })

  afterAll(async () => {
    try {
      if (existsSync(TEST_DIR)) {
        await fs.rm(TEST_DIR, { recursive: true, force: true })
      }
    } catch {}
  })

  describe('extractSessionTitle', () => {
    it('returns default fallback when messages array is empty or undefined', () => {
      expect(extractSessionTitle(undefined)).toBe('New Conversation')
      expect(extractSessionTitle([])).toBe('New Conversation')
      expect(extractSessionTitle([], 'Custom Fallback')).toBe('Custom Fallback')
    })

    it('extracts first user prompt text ignoring assistant or system messages', () => {
      const messages: ChatMessage[] = [
        { id: '1', role: 'assistant', content: 'Greeting', timestamp: 1 },
        { id: '2', role: 'user', content: 'How to sort arrays in TS?', timestamp: 2 }
      ]
      expect(extractSessionTitle(messages)).toBe('How to sort arrays in TS?')
    })

    it('strips XML tags and prompt wrappers', () => {
      const messages: ChatMessage[] = [
        {
          id: '1',
          role: 'user',
          content: '<prompt><context>dir</context>Refactor the auth module</prompt>',
          timestamp: 1
        }
      ]
      expect(extractSessionTitle(messages)).toBe('Refactor the auth module')
    })

    it('truncates long prompt to 30 characters with ellipsis', () => {
      const messages: ChatMessage[] = [
        {
          id: '1',
          role: 'user',
          content: 'This is an exceptionally long prompt that exceeds thirty characters by a significant margin',
          timestamp: 1
        }
      ]
      const title = extractSessionTitle(messages)
      expect(title.length).toBeLessThanOrEqual(30)
      expect(title.endsWith('...')).toBe(true)
    })

    it('handles multi-line prompt by using the first line', () => {
      const messages: ChatMessage[] = [
        {
          id: '1',
          role: 'user',
          content: 'Line One Title\nLine Two Details\nLine Three Footer',
          timestamp: 1
        }
      ]
      expect(extractSessionTitle(messages)).toBe('Line One Title')
    })
  })

  describe('Project Directory Isolation (Claude Code 1:1 Parity)', () => {
    it('sanitizePath converts Windows and POSIX paths to safe directory keys', () => {
      expect(sanitizePath('D:\\Agent')).toBe('D--Agent')
      expect(sanitizePath('D:/ProjectB')).toBe('D--ProjectB')
      expect(sanitizePath('/Users/admin/work')).toBe('-Users-admin-work')
      expect(sanitizePath('')).toBe('default')
    })

    it('stores session files physically under projects/<sanitizedProjectDir>/', async () => {
      const session = await store.createSession('Directory Test', 'D:/MyProject')
      const safeId = session.id.replace(/[^a-zA-Z0-9_-]/g, '_')

      // Physical path must be inside projects/D--MyProject/
      const expectedPhysicalPath = join(TEST_DIR, 'projects', 'D--MyProject', `${safeId}.jsonl`)
      expect(existsSync(expectedPhysicalPath)).toBe(true)

      const foundPath = await store.findSessionFilePath(session.id)
      expect(foundPath).toBe(expectedPhysicalPath)
    })
  })

  describe('SessionStore CRUD & Persistence (1:1 Claude Code Entry JSONL)', () => {
    it('creates a new session and stores as 1:1 Claude Code custom-title entry when title is provided', async () => {
      const session = await store.createSession('Initial Title', 'D:/Agent')
      expect(session.id).toBeDefined()
      expect(session.title).toBe('Initial Title')
      expect(session.workspacePath).toBe('D:/Agent')
      expect(session.messages).toEqual([])

      const filePath = (await store.findSessionFilePath(session.id))!
      expect(existsSync(filePath)).toBe(true)

      const raw = readFileSync(filePath, 'utf-8')
      const lines = raw.split('\n').filter((l) => l.trim().length > 0)
      expect(lines.length).toBe(1) // 1:1 custom-title entry

      const entry = JSON.parse(lines[0])
      expect(entry.type).toBe('custom-title')
      expect(entry.sessionId).toBe(session.id)
      expect(entry.customTitle).toBe('Initial Title')

      const fetched = await store.getSession(session.id)
      expect(fetched).not.toBeNull()
      expect(fetched?.id).toBe(session.id)
      expect(fetched?.title).toBe('Initial Title')
      expect(fetched?.messages).toEqual([])
    })

    it('saves session with messages as 1:1 Claude Code Entry lines (user, assistant, summary)', async () => {
      const session = await store.createSession('New Conversation', 'D:/Agent')

      const msgs: ChatMessage[] = [
        {
          id: 'u1',
          role: 'user',
          content: 'Implement OAuth2 login flow',
          timestamp: Date.now()
        },
        {
          id: 'a1',
          role: 'assistant',
          content: 'Here is the implementation...',
          blocks: [
            { type: 'thinking', id: 'th1', content: 'Analyzing requirements...' },
            { type: 'text', id: 'tx1', content: 'Here is the implementation...' }
          ],
          timestamp: Date.now()
        }
      ]

      session.messages = msgs
      const ok = await store.saveSession(session)
      expect(ok).toBe(true)

      const filePath = (await store.findSessionFilePath(session.id))!
      const raw = readFileSync(filePath, 'utf-8')
      const lines = raw.split('\n').filter((l) => l.trim().length > 0)
      // 2 messages + 1 summary (active_leaf)
      expect(lines.length).toBeGreaterThanOrEqual(2)

      const userEntry = JSON.parse(lines[0])
      expect(userEntry.type).toBe('user')
      expect(userEntry.uuid).toBe('u1')
      expect(userEntry.message.role).toBe('user')
      expect(userEntry.message.content).toBe('Implement OAuth2 login flow')

      const assistantEntry = JSON.parse(lines[1])
      expect(assistantEntry.type).toBe('assistant')
      expect(assistantEntry.uuid).toBe('a1')
      expect(assistantEntry.message.role).toBe('assistant')
      expect(assistantEntry.message.blocks?.length).toBe(2)

      const reloaded = await store.getSession(session.id)
      expect(reloaded).not.toBeNull()
      expect(reloaded?.title).toBe('Implement OAuth2 login flow')
      expect(reloaded?.messages?.length).toBe(2)
      expect(reloaded?.messages?.[1].blocks?.length).toBe(2)
    })

    it('appendMessage appends a single line without full rewrite (crash-safe)', async () => {
      const session = await store.createSession('Append Test', 'D:/Agent')
      const filePath = (await store.findSessionFilePath(session.id))!

      let raw = readFileSync(filePath, 'utf-8')
      let lines = raw.split('\n').filter((l) => l.trim().length > 0)
      expect(lines.length).toBe(1)

      // Zero-trust Spy: intercept fs.writeFile to mathematically prove NO session file rewrite happens
      const writeFileSpy = spyOn(fs, 'writeFile')

      const msg1: ChatMessage = {
        id: 'u1',
        role: 'user',
        content: 'Hello agent',
        timestamp: Date.now()
      }
      const ok1 = await store.appendMessage(session.id, msg1)
      expect(ok1).toBe(true)

      // PROOF: ZERO calls to fs.writeFile on the session file! Pure synchronous append-only!
      const sessionWrites1 = writeFileSpy.mock.calls.filter(([target]) => target === filePath)
      expect(sessionWrites1.length).toBe(0)

      raw = readFileSync(filePath, 'utf-8')
      lines = raw.split('\n').filter((l) => l.trim().length > 0)
      expect(lines.length).toBe(3) // custom-title + 1 msg + rolling last-prompt
      expect(lines.some((l) => l.includes('"type":"last-prompt"'))).toBe(true)

      const msg2: ChatMessage = {
        id: 'a1',
        role: 'assistant',
        content: 'Hello! How can I help?',
        timestamp: Date.now()
      }
      const ok2 = await store.appendMessage(session.id, msg2)
      expect(ok2).toBe(true)

      // PROOF: Still ZERO calls to fs.writeFile on the session file across turns!
      const sessionWrites2 = writeFileSpy.mock.calls.filter(([target]) => target === filePath)
      expect(sessionWrites2.length).toBe(0)
      writeFileSpy.mockRestore()

      raw = readFileSync(filePath, 'utf-8')
      lines = raw.split('\n').filter((l) => l.trim().length > 0)
      expect(lines.length).toBe(4) // custom-title + 1 msg + rolling last-prompt + 1 assistant msg

      const reloaded = await store.getSession(session.id)
      expect(reloaded?.messages?.length).toBe(2)
      expect(reloaded?.messages?.[0].content).toBe('Hello agent')
      expect(reloaded?.messages?.[1].content).toBe('Hello! How can I help?')
    })

    it('crash recovery: safely handles corrupted partial lines at tail without crashing or wiping data', async () => {
      const session = await store.createSession('Crash Recovery Test', 'D:/Agent')
      const filePath = (await store.findSessionFilePath(session.id))!

      await store.appendMessage(session.id, {
        id: 'msg_valid_1',
        role: 'user',
        content: 'First valid turn',
        timestamp: 1
      })
      await store.appendMessage(session.id, {
        id: 'msg_valid_2',
        role: 'assistant',
        content: 'Second valid turn',
        timestamp: 2
      })

      // Simulate unexpected process termination mid-write (corrupted incomplete JSON at EOF)
      appendFileSync(filePath, '{"t":"msg","id":"corrupt_half_chunk', 'utf-8')

      // getSession must survive, discard the corrupted trailing line, and preserve all prior history
      const recovered = await store.getSession(session.id)
      expect(recovered).not.toBeNull()
      expect(recovered?.messages.length).toBe(2)
      expect(recovered?.messages.map((m) => m.id)).toEqual(['msg_valid_1', 'msg_valid_2'])
    })

    it('readHeadAndTail bounds memory to 64KB chunks even on multi-line files', async () => {
      const session = await store.createSession('Large Buffer Test', 'D:/Agent')
      const filePath = (await store.findSessionFilePath(session.id))!

      const filler = 'X'.repeat(500)
      for (let i = 0; i < 200; i++) {
        appendFileSync(filePath, JSON.stringify({ t: 'msg', id: `fill_${i}`, role: 'user', content: filler, timestamp: i }) + '\n')
      }

      const { head, tail } = await store.readHeadAndTail(filePath)
      expect(head.length).toBeGreaterThan(0)
      expect(tail.length).toBeGreaterThan(0)
      expect(head.length).toBeLessThanOrEqual(65536)
      expect(tail.length).toBeLessThanOrEqual(65536)
    })

    it('appendMessage auto-derives title from first user message', async () => {
      const session = await store.createSession('New Conversation', 'D:/Agent')

      const msg: ChatMessage = {
        id: 'u1',
        role: 'user',
        content: 'Build a REST API server',
        timestamp: Date.now()
      }
      await store.appendMessage(session.id, msg)

      const reloaded = await store.getSession(session.id)
      expect(reloaded?.title).toBe('Build a REST API server')
    })

    it('lists sessions and filters by workspacePath', async () => {
      const s1 = await store.createSession('Project A Session', 'D:/ProjectA')
      const s2 = await store.createSession('Project B Session', 'D:/ProjectB')

      const all = await store.listSessions()
      expect(all.length).toBeGreaterThanOrEqual(2)

      const filteredA = await store.listSessions('D:/ProjectA')
      expect(filteredA.some((s) => s.id === s1.id)).toBe(true)
      expect(filteredA.some((s) => s.id === s2.id)).toBe(false)

      const filteredB = await store.listSessions('D:/ProjectB')
      expect(filteredB.some((s) => s.id === s2.id)).toBe(true)
      expect(filteredB.some((s) => s.id === s1.id)).toBe(false)
    })

    it('deletes session .jsonl file and updates index cache', async () => {
      const session = await store.createSession('To Delete', 'D:/Agent')
      expect(await store.getSession(session.id)).not.toBeNull()

      const deleted = await store.deleteSession(session.id)
      expect(deleted).toBe(true)

      const afterDelete = await store.getSession(session.id)
      expect(afterDelete).toBeNull()

      const list = await store.listSessions()
      expect(list.some((s) => s.id === session.id)).toBe(false)
    })

    it('rejects ephemeral placeholder messages from being persisted', async () => {
      const session = await store.createSession('Ephemeral Test', 'D:/Agent')

      const ephemeralMsg: ChatMessage = {
        id: 'placeholder_1',
        role: 'assistant',
        content: '',
        blocks: [],
        toolCalls: [],
        timestamp: Date.now()
      }

      const result = await store.appendMessage(session.id, ephemeralMsg)
      expect(result).toBe(false)

      const reloaded = await store.getSession(session.id)
      expect(reloaded?.messages.length).toBe(0)
    })

    it('preserves customTitle over auto-derived title', async () => {
      const session = await store.createSession('Initial Default', 'D:/Agent')
      session.customTitle = 'My Pinned Architecture Review'
      session.messages = [
        {
          id: 'u1',
          role: 'user',
          content: 'This prompt would normally become title',
          timestamp: Date.now()
        }
      ]

      await store.saveSession(session)

      const reloaded = await store.getSession(session.id)
      expect(reloaded?.title).toBe('My Pinned Architecture Review')
      expect(reloaded?.customTitle).toBe('My Pinned Architecture Review')
    })
  })

  describe('Message DAG & Branching Engine (Claude Code 1:1 Parity)', () => {
    it('buildConversationChain correctly backtracks a linear thread from a DAG with branches', () => {
      const messages: ChatMessage[] = [
        { id: 'u1', parentId: null, role: 'user', content: 'Prompt 1', timestamp: 100 },
        { id: 'a1', parentId: 'u1', role: 'assistant', content: 'Response 1', timestamp: 101 },
        { id: 'u2', parentId: 'a1', role: 'user', content: 'Prompt 2', timestamp: 102 },
        { id: 'a2_v1', parentId: 'u2', role: 'assistant', content: 'Response 2 (Draft 1)', timestamp: 103 },
        { id: 'a2_v2', parentId: 'u2', role: 'assistant', content: 'Response 2 (Draft 2)', timestamp: 104 }
      ]

      const chainB = buildConversationChain(messages, 'a2_v2')
      expect(chainB.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2_v2'])

      const chainA = buildConversationChain(messages, 'a2_v1')
      expect(chainA.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2_v1'])
    })

    it('buildConversationChain handles circular parentId safely without infinite loop', () => {
      const messages: ChatMessage[] = [
        { id: 'm1', parentId: 'm2', role: 'user', content: 'Loop 1', timestamp: 100 },
        { id: 'm2', parentId: 'm1', role: 'assistant', content: 'Loop 2', timestamp: 101 }
      ]

      const chain = buildConversationChain(messages, 'm2')
      expect(chain.length).toBeLessThanOrEqual(2)
    })

    it('appendMessage automatically links parentId to previous message in sequence', async () => {
      const session = await store.createSession('DAG Auto Chain', 'D:/Agent')

      const m1: ChatMessage = { id: 'msg_1', role: 'user', content: 'Step 1', timestamp: 100 }
      const m2: ChatMessage = { id: 'msg_2', role: 'assistant', content: 'Step 2', timestamp: 200 }

      await store.appendMessage(session.id, m1)
      await store.appendMessage(session.id, m2)

      const reloaded = await store.getSession(session.id)
      expect(reloaded?.messages.length).toBe(2)
      expect(reloaded?.messages[0].parentId).toBeNull()
      expect(reloaded?.messages[1].parentId).toBe('msg_1')
      expect(reloaded?.activeLeafId).toBe('msg_2')
    })

    it('setActiveBranch switches the active conversation view to another branch', async () => {
      const session = await store.createSession('Branch Switch Test', 'D:/Agent')

      const m1: ChatMessage = { id: 'n1', parentId: null, role: 'user', content: 'Hello', timestamp: 1 }
      const m2: ChatMessage = { id: 'n2', parentId: 'n1', role: 'assistant', content: 'First try', timestamp: 2 }
      const m3: ChatMessage = { id: 'n3', parentId: 'n1', role: 'assistant', content: 'Second try', timestamp: 3 }

      await store.appendMessage(session.id, m1)
      await store.appendMessage(session.id, m2)
      await store.appendMessage(session.id, m3)

      let current = await store.getSession(session.id)
      expect(current?.messages.map((m) => m.id)).toEqual(['n1', 'n3'])

      await store.setActiveBranch(session.id, 'n2')

      current = await store.getSession(session.id)
      expect(current?.messages.map((m) => m.id)).toEqual(['n1', 'n2'])
      expect(current?.activeLeafId).toBe('n2')
    })

    it('forkSession creates a new distinct SessionRecord from a historical message node', async () => {
      const session = await store.createSession('Base Session', 'D:/Agent')

      await store.appendMessage(session.id, { id: 'f1', role: 'user', content: 'Prompt 1', timestamp: 1 })
      await store.appendMessage(session.id, { id: 'f2', role: 'assistant', content: 'Answer 1', timestamp: 2 })
      await store.appendMessage(session.id, { id: 'f3', role: 'user', content: 'Prompt 2 (discard later)', timestamp: 3 })

      const forked = await store.forkSession(session.id, 'f2', 'Forked Experiment')
      expect(forked).not.toBeNull()
      expect(forked?.id).not.toBe(session.id)
      expect(forked?.title).toBe('Forked Experiment')
      expect(forked?.messages.map((m) => m.id)).toEqual(['f1', 'f2'])
    })
  })

  describe('Index Auto-Calibration & Self-Healing (Single Source of Truth)', () => {
    it('automatically prunes index entries when .jsonl files are deleted directly from disk', async () => {
      const s1 = await store.createSession('Manual Delete Target', 'D:/Agent')
      let list = await store.listSessions()
      expect(list.some((s) => s.id === s1.id)).toBe(true)

      const filePath = (await store.findSessionFilePath(s1.id))!
      expect(existsSync(filePath)).toBe(true)
      await fs.unlink(filePath)

      list = await store.listSessions()
      expect(list.some((s) => s.id === s1.id)).toBe(false)
    })

    it('automatically discovers and indexes new .jsonl files added directly to disk', async () => {
      const externalId = 'session_external_discovered_' + Date.now()
      const projectDir = store.getProjectDir('D:/Agent')
      if (!existsSync(projectDir)) {
        await fs.mkdir(projectDir, { recursive: true })
      }
      const filePath = join(projectDir, `${externalId}.jsonl`)
      const meta = {
        t: 'meta',
        id: externalId,
        title: 'Discovered Session Title',
        workspacePath: 'D:/Agent',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      await fs.writeFile(filePath, JSON.stringify(meta) + '\n', 'utf-8')

      const list = await store.listSessions()
      const found = list.find((s) => s.id === externalId)
      expect(found).toBeDefined()
      expect(found?.title).toBe('Discovered Session Title')
    })
  })

  describe('1:1 Claude Code Official Transcript Interoperability & Dual Compatibility', () => {
    it('extractFirstPromptFromHead extracts prompt, strips XML tags, and truncates to 200 chars', () => {
      const sampleHead = [
        JSON.stringify({
          type: 'user',
          sessionId: 's1',
          uuid: 'u0',
          message: { role: 'user', content: '<command-name>/help</command-name>' }
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 's1',
          uuid: 'u1',
          message: {
            role: 'user',
            content: 'How do quantum computers execute superposition algorithms in practical physics?'
          }
        })
      ].join('\n')

      const prompt = extractFirstPromptFromHead(sampleHead)
      expect(prompt).toBe('How do quantum computers execute superposition algorithms in practical physics?')
    })

    it('extractLastJsonStringField extracts the latest appended customTitle and aiTitle', () => {
      const sampleTail = [
        JSON.stringify({ type: 'ai-title', sessionId: 's1', aiTitle: 'Quantum Superposition' }),
        JSON.stringify({ type: 'custom-title', sessionId: 's1', customTitle: 'Renamed Physics Notes' })
      ].join('\n')

      expect(extractLastJsonStringField(sampleTail, 'aiTitle')).toBe('Quantum Superposition')
      expect(extractLastJsonStringField(sampleTail, 'customTitle')).toBe('Renamed Physics Notes')
      expect(extractJsonStringField(sampleTail, 'sessionId')).toBe('s1')
    })

    it('loads and resumes an official Claude Code format .jsonl file 100% seamlessly', async () => {
      const claudeSessionId = 'claude_official_transcript_' + Date.now()
      const projectDir = store.getProjectDir('D:/ClaudeProject')
      if (!existsSync(projectDir)) {
        await fs.mkdir(projectDir, { recursive: true })
      }
      const filePath = join(projectDir, `${claudeSessionId}.jsonl`)

      // Official Claude Code entries (NO Line 0 meta!)
      const entries = [
        {
          type: 'user',
          uuid: 'c_msg_1',
          parentUuid: null,
          sessionId: claudeSessionId,
          cwd: 'D:/ClaudeProject',
          timestamp: '2026-09-18T00:00:00.000Z',
          message: {
            role: 'user',
            content: 'Explain the difference between TCP and UDP'
          }
        },
        {
          type: 'assistant',
          uuid: 'c_msg_2',
          parentUuid: 'c_msg_1',
          sessionId: claudeSessionId,
          cwd: 'D:/ClaudeProject',
          timestamp: '2026-09-18T00:00:01.000Z',
          message: {
            role: 'assistant',
            content: 'TCP is connection-oriented and reliable, whereas UDP is connectionless and fast.',
            blocks: [
              { type: 'text', id: 'tx_1', content: 'TCP is connection-oriented...' }
            ]
          }
        },
        {
          type: 'ai-title',
          sessionId: claudeSessionId,
          aiTitle: 'TCP vs UDP Comparison'
        },
        {
          type: 'custom-title',
          sessionId: claudeSessionId,
          customTitle: 'Networking Fundamentals'
        }
      ]

      await fs.writeFile(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')

      // NEXUS-AGENT must load this official Claude Code session without errors
      const session = await store.getSession(claudeSessionId)
      expect(session).not.toBeNull()
      expect(session?.id).toBe(claudeSessionId)
      expect(session?.title).toBe('Networking Fundamentals') // customTitle takes precedence
      expect(session?.customTitle).toBe('Networking Fundamentals')
      expect(session?.messages.length).toBe(2)
      expect(session?.messages[0].content).toBe('Explain the difference between TCP and UDP')
      expect(session?.messages[1].parentId).toBe('c_msg_1')
      expect(session?.messages[1].content).toContain('connection-oriented')
    })

    it('retains backward compatibility with legacy {"t":"meta"} format files', async () => {
      const legacySessionId = 'legacy_session_compat_' + Date.now()
      const projectDir = store.getProjectDir('D:/Agent')
      if (!existsSync(projectDir)) {
        await fs.mkdir(projectDir, { recursive: true })
      }
      const filePath = join(projectDir, `${legacySessionId}.jsonl`)

      const legacyLines = [
        JSON.stringify({
          t: 'meta',
          id: legacySessionId,
          title: 'Legacy Session Title',
          workspacePath: 'D:/Agent',
          createdAt: 100,
          updatedAt: 200,
          activeLeafId: 'leg_2'
        }),
        JSON.stringify({ t: 'msg', id: 'leg_1', role: 'user', content: 'Legacy question', timestamp: 101 }),
        JSON.stringify({ t: 'msg', id: 'leg_2', parentId: 'leg_1', role: 'assistant', content: 'Legacy answer', timestamp: 102 }),
        JSON.stringify({ t: 'meta_update', title: 'Updated Legacy Title', activeLeafId: 'leg_2' })
      ]

      await fs.writeFile(filePath, legacyLines.join('\n') + '\n', 'utf-8')

      const session = await store.getSession(legacySessionId)
      expect(session).not.toBeNull()
      expect(session?.id).toBe(legacySessionId)
      expect(session?.title).toBe('Updated Legacy Title')
      expect(session?.messages.length).toBe(2)
      expect(session?.messages[0].content).toBe('Legacy question')
      expect(session?.messages[1].parentId).toBe('leg_1')
    })

    it('loads and seamlessly handles all 20 Claude Code official Entry types without data loss', async () => {
      const fullSessionId = 'full_20_entries_session_' + Date.now()
      const projectDir = store.getProjectDir('D:/Agent')
      if (!existsSync(projectDir)) {
        await fs.mkdir(projectDir, { recursive: true })
      }
      const filePath = join(projectDir, `${fullSessionId}.jsonl`)

      // Construct entries covering ALL 20 official Claude Code types
      const allTwentyEntries = [
        { type: 'user', uuid: 'u_1', parentUuid: null, sessionId: fullSessionId, cwd: 'D:/Agent', timestamp: '2026-09-18T00:00:00.000Z', message: { role: 'user', content: 'What is WebSockets?' } },
        { type: 'assistant', uuid: 'a_1', parentUuid: 'u_1', sessionId: fullSessionId, cwd: 'D:/Agent', timestamp: '2026-09-18T00:00:01.000Z', message: { role: 'assistant', content: 'WebSockets provide full-duplex communication.' } },
        { type: 'custom-title', sessionId: fullSessionId, customTitle: 'Custom WebSocket Guide' },
        { type: 'ai-title', sessionId: fullSessionId, aiTitle: 'WebSockets Overview' },
        { type: 'summary', leafUuid: 'a_1', summary: 'Discussion on full-duplex networking' },
        { type: 'last-prompt', sessionId: fullSessionId, lastPrompt: 'What is WebSockets?' },
        { type: 'task-summary', sessionId: fullSessionId, summary: 'Answering networking architecture question', timestamp: '2026-09-18T00:00:02.000Z' },
        { type: 'tag', sessionId: fullSessionId, tag: 'networking' },
        { type: 'agent-name', sessionId: fullSessionId, agentName: 'NetworkArchitect' },
        { type: 'agent-color', sessionId: fullSessionId, agentColor: '#2563eb' },
        { type: 'agent-setting', sessionId: fullSessionId, agentSetting: 'default' },
        { type: 'pr-link', sessionId: fullSessionId, prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42', prRepository: 'org/repo', timestamp: '2026-09-18T00:00:03.000Z' },
        { type: 'file-history-snapshot', messageId: 'a_1', snapshot: { 'net.ts': 'hash_123' }, isSnapshotUpdate: false },
        { type: 'attribution-snapshot', messageId: 'a_1', surface: 'desktop', fileStates: {} },
        { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-09-18T00:00:04.000Z' },
        { type: 'speculation-accept', timestamp: '2026-09-18T00:00:05.000Z', timeSavedMs: 250 },
        { type: 'mode', sessionId: fullSessionId, mode: 'coordinator' },
        { type: 'worktree-state', sessionId: fullSessionId, worktreeSession: null },
        { type: 'content-replacement', sessionId: fullSessionId, replacements: [] },
        { type: 'marble-origami-commit', sessionId: fullSessionId, collapseId: 'col_01', summaryUuid: 'u_1', summaryContent: '<c>summary</c>', summary: 'summary', firstArchivedUuid: 'u_1', lastArchivedUuid: 'u_1' },
        { type: 'marble-origami-snapshot', sessionId: fullSessionId, staged: [], armed: false, lastSpawnTokens: 0 }
      ]

      await fs.writeFile(filePath, allTwentyEntries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')

      const loaded = await store.getSession(fullSessionId)
      expect(loaded).not.toBeNull()
      expect(loaded?.id).toBe(fullSessionId)
      expect(loaded?.customTitle).toBe('Custom WebSocket Guide')
      expect(loaded?.tag).toBe('networking')
      expect(loaded?.agentName).toBe('NetworkArchitect')
      expect(loaded?.agentColor).toBe('#2563eb')
      expect(loaded?.mode).toBe('coordinator')
      expect(loaded?.lastPrompt).toBe('What is WebSockets?')
      expect(loaded?.messages.length).toBe(2)
      expect(loaded?.messages[0].id).toBe('u_1')
      expect(loaded?.messages[1].id).toBe('a_1')
    })

    it('forkSession attaches forkedFrom metadata, clones ancestor chain, and creates independent session', async () => {
      const origSession = await store.createSession('Base Conversation', 'D:/Agent')
      await store.appendMessage(origSession.id, { id: 'node_1', role: 'user', content: 'Step 1: Setup project' })
      await store.appendMessage(origSession.id, { id: 'node_2', role: 'assistant', content: 'Step 1 complete: Project setup done' })
      await store.appendMessage(origSession.id, { id: 'node_3', role: 'user', content: 'Step 2: Add sqlite db' })
      await store.appendMessage(origSession.id, { id: 'node_4', role: 'assistant', content: 'Step 2 complete: sqlite added' })

      // Fork from node_2 (exclude node_3 and node_4)
      const forked = await store.forkSession(origSession.id, 'node_2', 'Alternative Architecture Branch')
      expect(forked).not.toBeNull()
      expect(forked?.id).not.toBe(origSession.id)
      expect(forked?.title).toBe('Alternative Architecture Branch')
      expect(forked?.forkedFrom?.sessionId).toBe(origSession.id)
      expect(forked?.forkedFrom?.messageUuid).toBe('node_2')

      // Verifies DAG ancestor chain was cleanly sliced up to node_2
      expect(forked?.messages.length).toBe(2)
      expect(forked?.messages.map((m) => m.id)).toEqual(['node_1', 'node_2'])

      // Verifies physical persistence of forkedFrom
      const forkedFile = await store.findSessionFilePath(forked!.id)
      expect(forkedFile).not.toBeNull()
      const rawDisk = await fs.readFile(forkedFile!, 'utf-8')
      expect(rawDisk).toContain(`"forkedFrom":{"sessionId":"${origSession.id}","messageUuid":"node_2"}`)

      // Original session remains unaffected
      const origReloaded = await store.getSession(origSession.id)
      expect(origReloaded?.messages.length).toBe(4)
    })

    it('renameSession appends custom-title line and updates title in index and getSession', async () => {
      const sess = await store.createSession('Initial Title', 'D:/Agent')
      const ok = await store.renameSession(sess.id, 'Renamed By User')
      expect(ok).toBe(true)

      const filePath = await store.findSessionFilePath(sess.id)
      const raw = await fs.readFile(filePath!, 'utf-8')
      expect(raw).toContain(`"type":"custom-title","sessionId":"${sess.id}","customTitle":"Renamed By User"`)

      const loaded = await store.getSession(sess.id)
      expect(loaded?.title).toBe('Renamed By User')
      expect(loaded?.customTitle).toBe('Renamed By User')

      const list = await store.listSessions('D:/Agent')
      const item = list.find((s) => s.id === sess.id)
      expect(item?.title).toBe('Renamed By User')
    })

    it('setSessionTag appends tag line and updates tag in index and getSession', async () => {
      const sess = await store.createSession('Tag Test', 'D:/Agent')
      const ok = await store.setSessionTag(sess.id, 'experimental')
      expect(ok).toBe(true)

      const filePath = await store.findSessionFilePath(sess.id)
      const raw = await fs.readFile(filePath!, 'utf-8')
      expect(raw).toContain(`"type":"tag","sessionId":"${sess.id}","tag":"experimental"`)

      const loaded = await store.getSession(sess.id)
      expect(loaded?.tag).toBe('experimental')

      const list = await store.listSessions('D:/Agent')
      const item = list.find((s) => s.id === sess.id)
      expect(item?.tag).toBe('experimental')
    })

    it('readMetaOnly excludes subagent sidechains (1:1 with Claude Code isSidechain check)', async () => {
      const sidechainSessionId = 'd1111111-2222-4333-8444-555555555555'
      const sidechainFile = join(store.getProjectDir('D:/Agent'), `${sidechainSessionId}.jsonl`)
      const sidechainLine = JSON.stringify({
        type: 'user',
        uuid: 'sc_msg_1',
        sessionId: sidechainSessionId,
        isSidechain: true,
        cwd: 'D:/Agent',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'Subagent internal prompt' }
      })
      await fs.writeFile(sidechainFile, sidechainLine + '\n', 'utf-8')

      const meta = await store.readMetaOnly(sidechainFile)
      expect(meta).toBeNull()
    })

    it('appendMessage appends rolling last-prompt entry for user messages (1:1 with Claude Code)', async () => {
      const sess = await store.createSession('Prompt Test', 'D:/Agent')
      await store.appendMessage(sess.id, {
        id: 'user_prompt_1',
        role: 'user',
        content: 'Explain quantum computing simply'
      })

      const filePath = await store.findSessionFilePath(sess.id)
      const raw = await fs.readFile(filePath!, 'utf-8')
      expect(raw).toContain(`"type":"last-prompt","sessionId":"${sess.id}","lastPrompt":"Explain quantum computing simply"`)

      const meta = await store.readMetaOnly(filePath!)
      expect(meta?.lastPrompt).toBe('Explain quantum computing simply')
    })

    it('persists desktop attachment messages and recovers them in getSession (1:1 with sessionStorageFlush.test.ts)', async () => {
      const sess = await store.createSession('Attachment Test', 'D:/Agent')
      await store.appendMessage(sess.id, {
        id: 'u_attach_prompt',
        role: 'user',
        content: '@"/workspace/README.md" summarize it',
        timestamp: 1000
      })
      await store.appendMessage(sess.id, {
        id: 'attach_entry_1',
        role: 'attachment',
        content: 'README.md desktop attachment resume canary content',
        timestamp: 1001
      })
      await store.appendMessage(sess.id, {
        id: 'a_attach_reply',
        role: 'assistant',
        content: 'Here is the summary of README.md',
        timestamp: 1002
      })

      const loaded = await store.getSession(sess.id)
      expect(loaded).not.toBeNull()
      expect(loaded?.messages.length).toBe(3)
      expect(loaded?.messages[1].role).toBe('attachment')
      expect(loaded?.messages[1].content).toContain('README.md desktop attachment resume canary content')
    })

    it('round-trips complete tool-use, thinking, and tool-result message turn across JSONL persistence', async () => {
      const sess = await store.createSession('Tool Turn Test', 'D:/Agent')

      const uMsg: ChatMessage = {
        id: 'tool_u1',
        role: 'user',
        content: 'Check the package version',
        timestamp: 1000
      }
      const aToolMsg: ChatMessage = {
        id: 'tool_a1',
        role: 'assistant',
        content: 'I will run read_file to check package.json.',
        thinking: 'Locate version field in package.json',
        toolCalls: [
          {
            id: 'tc_101',
            name: 'read_file',
            parameters: { path: 'package.json' }
          }
        ],
        timestamp: 1001
      }
      const uResultMsg: ChatMessage = {
        id: 'tool_u2',
        role: 'user',
        content: '{"name": "test-pkg", "version": "1.2.3"}',
        timestamp: 1002
      }
      const aFinalMsg: ChatMessage = {
        id: 'tool_a2',
        role: 'assistant',
        content: 'The package version is 1.2.3.',
        timestamp: 1003
      }

      await store.appendMessage(sess.id, uMsg)
      await store.appendMessage(sess.id, aToolMsg)
      await store.appendMessage(sess.id, uResultMsg)
      await store.appendMessage(sess.id, aFinalMsg)

      const loaded = await store.getSession(sess.id)
      expect(loaded).not.toBeNull()
      expect(loaded?.messages.length).toBe(4)

      const reloadedToolMsg = loaded?.messages[1]
      expect(reloadedToolMsg?.thinking).toBe('Locate version field in package.json')
      expect(reloadedToolMsg?.toolCalls?.length).toBe(1)
      expect(reloadedToolMsg?.toolCalls?.[0].name).toBe('read_file')
      expect(reloadedToolMsg?.toolCalls?.[0].id).toBe('tc_101')
      expect(loaded?.messages[3].content).toBe('The package version is 1.2.3.')
    })

    it('reconciles incomplete multi-byte UTF-8 tail write without dropping earlier history and permits subsequent appends (1:1 with history.test.ts)', async () => {
      const sess = await store.createSession('UTF8 Crash Test', 'D:/Agent')
      const filePath = (await store.findSessionFilePath(sess.id))!

      await store.appendMessage(sess.id, {
        id: 'utf_1',
        role: 'user',
        content: 'First valid turn with UTF-8 你好😀',
        timestamp: 1
      })
      await store.appendMessage(sess.id, {
        id: 'utf_2',
        role: 'assistant',
        content: 'Second valid turn: 了解，已保存',
        timestamp: 2
      })

      // Simulate partial write with corrupted UTF-8 suffix (broken JSON syntax & surrogate)
      appendFileSync(filePath, '{"type":"user","uuid":"u_broken","message":{"role":"user","content":"Half written 你好😀', 'utf-8')

      // getSession must ignore the unclosed broken line and return the 2 good messages
      const recovered = await store.getSession(sess.id)
      expect(recovered?.messages.length).toBe(2)
      expect(recovered?.messages[0].id).toBe('utf_1')
      expect(recovered?.messages[1].id).toBe('utf_2')

      // Subsequent append must continue smoothly
      const appendOk = await store.appendMessage(sess.id, {
        id: 'utf_3',
        role: 'user',
        content: 'Third turn after crash recovery',
        timestamp: 3
      })
      expect(appendOk).toBe(true)

      const updated = await store.getSession(sess.id)
      expect(updated?.messages.length).toBe(3)
      expect(updated?.messages[2].id).toBe('utf_3')
      expect(updated?.messages[2].content).toBe('Third turn after crash recovery')
    })
  })
})

