import { describe, it, expect } from 'bun:test'
import { PermissionEngine } from '../src/main/agent/permissions/PermissionEngine'
import { normalizePermissionMode } from '../src/shared/types'

/**
 * P2a 三模式权限体系（ask / plan / bypass）语义与迁移测试。
 * ask 继承原 acceptEdits 语义：读+编辑放行，命令等其余 ask。
 */

describe('PermissionMode 收敛 — ask/plan/bypass', () => {
  const engine = new PermissionEngine({ rules: [] })

  it('bypass：一切放行且不需审批', () => {
    for (const tool of ['run_command', 'write_to_file', 'docx_modify_block', 'view_file']) {
      const res = engine.evaluate(tool, {}, 'bypass')
      expect(`${tool}: ${res.behavior}`).toBe(`${tool}: allow`)
      expect(res.requiresApproval).toBe(false)
    }
  })

  it('plan：只读放行；写/命令/docx 变更一律 deny（负向）', () => {
    expect(engine.evaluate('view_file', {}, 'plan').behavior).toBe('allow')
    expect(engine.evaluate('docx_read', {}, 'plan').behavior).toBe('allow')
    for (const tool of ['write_to_file', 'replace_file_content', 'run_command', 'docx_modify_block', 'docx_apply_ops']) {
      const res = engine.evaluate(tool, {}, 'plan')
      expect(`${tool}: ${res.behavior}`).toBe(`${tool}: deny`)
    }
  })

  it('ask（=原 acceptEdits）：读+编辑放行，命令与其余未知工具 ask（负向：未知工具不放行）', () => {
    for (const tool of ['view_file', 'docx_read', 'write_to_file', 'replace_file_content', 'docx_modify_block']) {
      const res = engine.evaluate(tool, {}, 'ask')
      expect(`${tool}: ${res.behavior}`).toBe(`${tool}: allow`)
    }
    expect(engine.evaluate('run_command', {}, 'ask').behavior).toBe('ask')
    expect(engine.evaluate('totally_unknown_tool', {}, 'ask').behavior).toBe('ask')
  })

  it('默认参数为 ask（缺省调用等价于 ask 语义）', () => {
    expect(engine.evaluate('run_command', {}).behavior).toBe('ask')
    expect(engine.evaluate('view_file', {}).behavior).toBe('allow')
  })

  it('normalizePermissionMode：旧值迁移，未知值 fail-closed 到 ask（负向）', () => {
    expect(normalizePermissionMode('bypassPermissions')).toBe('bypass')
    expect(normalizePermissionMode('acceptEdits')).toBe('ask')
    expect(normalizePermissionMode('default')).toBe('ask')
    expect(normalizePermissionMode('dontAsk')).toBe('ask')
    expect(normalizePermissionMode('ask')).toBe('ask')
    expect(normalizePermissionMode('plan')).toBe('plan')
    expect(normalizePermissionMode('bypass')).toBe('bypass')
    // 负向：任意垃圾值不得落入 bypass
    for (const junk of [undefined, null, '', 'BYPASS', 'bypass ', 42, {}, true]) {
      expect(normalizePermissionMode(junk)).toBe('ask')
    }
  })
})
