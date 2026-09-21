import { normalizeKeyPath } from '../../../shared/paths'

/**
 * 文档冲突检测器(计划 §6.2 规则5):
 * in-flight 写注册表(path → 占用会话集),精确重叠判定,非时间窗(无误报)。
 * 查询点:query.ts runGate(docx 工具执行前);释放:tool_call_complete/abort。
 */
export class DocConflictDetector {
  private active = new Map<string, Set<string>>() // key → sessionIds
  private calls = new Map<string, { sessionId: string; key: string }>() // toolCallId → 归属

  /** runGate 通过后登记:callId 绑定(会话,路径),完成时 releaseCall */
  registerCall(callId: string, sessionId: string, rawPath: string): void {
    const key = normalizeKeyPath(rawPath)
    this.calls.set(callId, { sessionId, key })
    this.register(sessionId, rawPath)
  }

  /** 会话结束/中止:释放其全部 in-flight 登记(防 review 指出的流中断路径泄漏) */
  releaseSession(sessionId: string): void {
    for (const [key, set] of this.active) {
      set.delete(sessionId)
      if (set.size === 0) this.active.delete(key)
    }
    for (const [callId, e] of [...this.calls]) {
      if (e.sessionId === sessionId) this.calls.delete(callId)
    }
  }

  releaseCall(callId: string): void {
    const e = this.calls.get(callId)
    if (!e) return
    this.calls.delete(callId)
    const set = this.active.get(e.key)
    if (!set) return
    set.delete(e.sessionId)
    if (set.size === 0) this.active.delete(e.key)
  }

  register(sessionId: string, rawPath: string): void {
    const key = normalizeKeyPath(rawPath)
    if (!key) return
    let set = this.active.get(key)
    if (!set) {
      set = new Set()
      this.active.set(key, set)
    }
    set.add(sessionId)
  }

  release(sessionId: string, rawPath: string): void {
    const key = normalizeKeyPath(rawPath)
    const set = this.active.get(key)
    if (!set) return
    set.delete(sessionId)
    if (set.size === 0) this.active.delete(key)
  }

  /** 该路径正被"其他会话"in-flight 修改 → 返回对方 id;否则 null */
  findOther(sessionId: string, rawPath: string): string | null {
    const set = this.active.get(normalizeKeyPath(rawPath))
    if (!set || set.size === 0) return null
    for (const sid of set) {
      if (sid !== sessionId) return sid
    }
    return null
  }
}
