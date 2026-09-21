/* 清理 E2E 污染会话:删除标题含 __perf 的会话(走 SessionStore API,index 同步更新) */
import { SessionStore } from '../../src/main/session/sessionStore'

const dir = process.argv[2] || 'C:/Users/Administrator/AppData/Roaming/nexus-agent/sessions'
const store = new SessionStore(dir)
const sessions = await store.listSessions('D:/Agent')
const targets = sessions.filter((s) => (s.title || '').includes('__perf'))
for (const s of targets) {
  await store.deleteSession(s.id)
  console.log('deleted:', s.id, s.title)
}
console.log(`done, ${targets.length} session(s) removed`)
process.exit(0)
