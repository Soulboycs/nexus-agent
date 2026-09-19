/**
 * Memory type taxonomy and serialization contracts (1:1 aligned with Claude Code).
 *
 * Memories are constrained to four types capturing context NOT derivable
 * from the current project state (e.g. code architecture, git history, and files
 * should NOT be saved into memory).
 */

export const MEMORY_TYPES = [
  'user',
  'feedback',
  'project',
  'reference'
] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

export interface MemoryFrontmatter {
  name: string
  description: string
  type: MemoryType
  date?: string
}

export interface MemoryItem {
  filename: string
  name: string
  description: string
  type: MemoryType
  content: string
  date?: string
  updatedAt?: string
}

export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') return undefined
  return MEMORY_TYPES.find((t) => t.toLowerCase() === raw.toLowerCase())
}

/**
 * Parses markdown files with YAML-like frontmatter:
 * ---
 * name: ...
 * description: ...
 * type: user | feedback | project | reference
 * ---
 * Content body...
 */
export function parseMemoryFile(raw: string, filename: string): MemoryItem {
  const trimmed = raw.trim()
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
  const match = trimmed.match(frontmatterRegex)

  if (!match) {
    return {
      filename,
      name: filename.replace(/\.md$/, ''),
      description: '',
      type: 'project',
      content: trimmed
    }
  }

  const yamlLines = match[1].split('\n')
  const body = match[2].trim()
  const fields: Record<string, string> = {}

  for (const line of yamlLines) {
    const colonIdx = line.indexOf(':')
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim()
      let value = line.slice(colonIdx + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      fields[key] = value
    }
  }

  return {
    filename,
    name: fields.name || filename.replace(/\.md$/, ''),
    description: fields.description || '',
    type: parseMemoryType(fields.type) || 'project',
    date: fields.date,
    content: body
  }
}

/**
 * Serializes a memory item into YAML frontmatter + markdown body.
 */
export function serializeMemoryFile(item: MemoryItem): string {
  const formatYamlValue = (val: string) => {
    if (val.includes('\n') || val.includes(':') || val.includes('"') || val.includes("'")) {
      return JSON.stringify(val)
    }
    return val
  }

  const frontmatter = [
    '---',
    `name: ${formatYamlValue(item.name)}`,
    `description: ${formatYamlValue(item.description)}`,
    `type: ${item.type}`,
    ...(item.date ? [`date: ${formatYamlValue(item.date)}`] : []),
    '---',
    '',
    item.content.trim(),
    ''
  ].join('\n')

  return frontmatter
}
