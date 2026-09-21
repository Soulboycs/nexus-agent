import { describe, it, expect } from 'bun:test'
import {
  parsePermissionRule,
  matchesPermissionRule
} from '../src/main/agent/permissions/ruleParser'

describe('Permission Rule Parser & Matcher', () => {
  it('should parse simple tool name rule without arguments', () => {
    const rule = parsePermissionRule('run_command')
    expect(rule.toolName).toBe('run_command')
    expect(rule.specifier).toBeUndefined()
  })

  it('should parse tool name with specifier parameter', () => {
    const rule = parsePermissionRule('run_command(git status)')
    expect(rule.toolName).toBe('run_command')
    expect(rule.specifier).toBe('git status')
  })

  it('should parse tool name with wildcard specifier', () => {
    const rule = parsePermissionRule('run_command(bun test *)')
    expect(rule.toolName).toBe('run_command')
    expect(rule.specifier).toBe('bun test *')
  })

  it('should parse file path glob specifier', () => {
    const rule = parsePermissionRule('write_to_file(src/**)')
    expect(rule.toolName).toBe('write_to_file')
    expect(rule.specifier).toBe('src/**')
  })

  it('should match tool execution against rule correctly', () => {
    // Exact tool name match
    const toolRule = parsePermissionRule('docx_read')
    expect(matchesPermissionRule(toolRule, 'docx_read', {})).toBe(true)
    expect(matchesPermissionRule(toolRule, 'view_file', {})).toBe(false)

    // Command prefix / wildcard match
    const gitRule = parsePermissionRule('run_command(git *)')
    expect(matchesPermissionRule(gitRule, 'run_command', { CommandLine: 'git status' })).toBe(true)
    expect(matchesPermissionRule(gitRule, 'run_command', { CommandLine: 'git commit -m "feat"' })).toBe(true)
    expect(matchesPermissionRule(gitRule, 'run_command', { CommandLine: 'npm install' })).toBe(false)

    // File path glob match
    const srcRule = parsePermissionRule('write_to_file(src/**)')
    expect(matchesPermissionRule(srcRule, 'write_to_file', { TargetFile: 'd:/Agent/src/agent/query.ts' })).toBe(true)
    expect(matchesPermissionRule(srcRule, 'write_to_file', { TargetFile: 'd:/Agent/package.json' })).toBe(false)
  })
})
