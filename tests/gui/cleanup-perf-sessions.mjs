/* 清理 E2E 污染会话:删除标题为 __perf 压测 的会话(走 SessionStore API) */
import { spawnSync } from 'node:child_process'
const r = spawnSync('bun', ['-e', `
const { SessionStore } = await import('./src/main/session/sessionStore.ts')
const store = new SessionStore()
const sessions = await store.listSessions('D:/Agent')
const targets = sessions.filter(s => (s.title || '').includes('__perf'))
for (const s of targets) await store.deleteSession(s.id)
console.log('deleted:', targets.length, targets.map(t => t.id).join(','))
`], { cwd: 'D:/Agent', encoding: 'utf-8', env: { ...process.env, NEXUS_SESSIONS_DIR: process.argv[2] || '' } })
console.log(r.stdout || r.stderr)
