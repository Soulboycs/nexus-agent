import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { AgentTool } from './ToolRegistry'

/**
 * R6 Skill（1:1 cc SkillTool，inline 模式核心版）：
 * 加载 .agents/skills/<name>/SKILL.md（兼容 .claude/skills/），$ARGUMENTS
 * 替换后把 skill 指令注入对话。已披露简化：无 frontmatter 权限白名单、
 * fork 模式、插件/MCP prompt skill 注册表。
 */

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!m) return { frontmatter: {}, body: raw }
  const frontmatter: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line.trim())
    if (kv) frontmatter[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { frontmatter, body: m[2] }
}

function discoverSkills(workspaceRoot: string): Array<{ name: string; dir: string; description: string }> {
  const roots = [
    path.join(workspaceRoot, '.agents', 'skills'),
    path.join(workspaceRoot, '.claude', 'skills'),
  ]
  const skills: Array<{ name: string; dir: string; description: string }> = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillFile = path.join(root, entry.name, 'SKILL.md')
      if (!fs.existsSync(skillFile)) continue
      const { frontmatter } = parseFrontmatter(fs.readFileSync(skillFile, 'utf-8'))
      skills.push({
        name: frontmatter.name || entry.name,
        dir: path.dirname(skillFile),
        description: frontmatter.description || '',
      })
    }
  }
  return skills
}

export const skillTool: AgentTool = {
  name: 'Skill',
  aliases: ['skill'],
  description:
    'Launch a named skill from the workspace skill directories (.agents/skills/<name>/SKILL.md). The skill instructions are expanded into your context with $ARGUMENTS replaced by the given args. Call when the user asks for a skill explicitly (e.g. "/commit") or when a skill matches the task.',
  searchHint: 'skill launch slash command workflow instructions',
  isReadOnly: () => true,
  maxResultSizeChars: 50_000,
  parameters: z.object({
    skill: z.string().describe('The skill name, e.g. "commit", "review-pr" (leading "/" is tolerated)'),
    args: z.string().optional().describe('Optional arguments passed to the skill ($ARGUMENTS placeholder)'),
  }),
  execute: async ({ skill, args }: { skill: string; args?: string }, context) => {
    const cleanName = skill.replace(/^\//, '').trim()
    const skills = discoverSkills(context.workspaceRoot)
    const found =
      skills.find((s) => s.name.toLowerCase() === cleanName.toLowerCase()) ||
      skills.find((s) => path.basename(s.dir).toLowerCase() === cleanName.toLowerCase())

    if (!found) {
      const available = skills.map((s) => s.name).join(', ') || '(none discovered)'
      throw new Error(`Unknown skill: "${cleanName}". Available skills: ${available}`)
    }

    const raw = fs.readFileSync(path.join(found.dir, 'SKILL.md'), 'utf-8')
    const { body } = parseFrontmatter(raw)
    const expanded = body.replace(/\$ARGUMENTS/g, args ?? '')

    return [
      `Launching skill: ${found.name}`,
      expanded,
      args ? `\n---\nSkill args: ${args}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  },
}
