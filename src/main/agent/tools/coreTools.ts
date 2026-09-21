import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { AgentTool } from './ToolRegistry'

/**
 * R5 工具目录补齐（1:1 cc 核心工具）：TodoWrite / WebFetch / WebSearch。
 * 全部只读或内部状态写入，不触碰用户工作区文件。
 */

// ============ TodoWrite（1:1 cc TodoWrite） ============

const todoItemSchema = z.object({
  content: z.string().min(1).describe('The task description (imperative form, e.g. "Run tests")'),
  status: z
    .enum(['pending', 'in_progress', 'completed'])
    .describe('Task state: pending | in_progress | completed'),
  activeForm: z
    .string()
    .min(1)
    .describe('Present-tense form shown while in_progress (e.g. "Running tests")'),
})

export const todoWriteTool: AgentTool = {
  name: 'TodoWrite',
  aliases: ['todo_write'],
  description:
    'Write the task list for the current session. Use proactively for complex multi-step work: mark tasks in_progress before starting each, and completed immediately after finishing. Only one task may be in_progress at a time.',
  searchHint: 'task list todo planning progress tracking',
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  maxResultSizeChars: 5_000,
  parameters: z.object({
    todos: z.array(todoItemSchema).describe('The full replacement todo list (merge + update in one call)'),
  }),
  execute: async ({ todos }: { todos: Array<{ content: string; status: string; activeForm?: string }> }, context) => {
    const inProgress = todos.filter((t) => t.status === 'in_progress').length
    if (inProgress > 1) {
      throw new Error(`Only one task may be in_progress at a time (got ${inProgress}).`)
    }

    const dir = path.join(context.workspaceRoot, '.nexus')
    await fs.promises.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'todos.json')

    // 1:1 cc：全部 completed 时存储清空（保留输出回显语义）
    const allCompleted = todos.length > 0 && todos.every((t) => t.status === 'completed')
    const payload = {
      updatedAt: new Date().toISOString(),
      todos: allCompleted ? [] : todos,
    }
    await fs.promises.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8')

    // 1:1 cc 固定确认语（不回显列表，省上下文）
    return 'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable'
  },
}

// ============ WebFetch（1:1 cc WebFetch，最小实现：抓取+正文提取） ============

export const webFetchTool: AgentTool = {
  name: 'WebFetch',
  aliases: ['web_fetch', 'read_url_content', 'fetch_url'],
  description:
    'Fetch a URL over HTTP(S) and return its content as readable text (HTML stripped, whitespace collapsed). Use for reading public web pages, docs, and JSON/API endpoints. Read-only.',
  searchHint: 'fetch url http page content read web',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: 30_000,
  parameters: z.object({
    url: z.string().url().describe('The http(s) URL to fetch'),
    maxChars: z
      .number()
      .int()
      .positive()
      .max(100_000)
      .default(20_000)
      .describe('Max characters of extracted text to return'),
  }),
  execute: async ({ url, maxChars }: { url: string; maxChars: number }) => {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`WebFetch only supports http(s) URLs, got: ${url}`)
    }
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusAgent/0.1; +https://github.com/Soulboycs/nexus-agent)' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      throw new Error(`WebFetch failed (${response.status}) for ${url}`)
    }
    const contentType = response.headers.get('content-type') || ''
    let body = await response.text()

    if (contentType.includes('html') || /^\s*<(!doctype|html)/i.test(body)) {
      body = body
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim()
    }

    if (body.length > maxChars) {
      return `Content from ${url} (truncated to ${maxChars} of ${body.length} chars):\n\n${body.slice(0, maxChars)}\n\n[truncated — fetch again with a higher maxChars if needed]`
    }
    return `Content from ${url}:\n\n${body}`
  },
}

// ============ WebSearch（1:1 cc WebSearch；DuckDuckGo HTML 后端，尽力而为） ============

export const webSearchTool: AgentTool = {
  name: 'WebSearch',
  aliases: ['web_search', 'search_web'],
  description:
    'Search the web (DuckDuckGo) and return ranked result titles with URLs. Use for current events, docs lookup, and error-message research. Read-only. Best-effort: parsing may fail if the upstream layout changes.',
  searchHint: 'search web internet query duckduckgo',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: 10_000,
  parameters: z.object({
    query: z.string().min(1).describe('The search query'),
    maxResults: z.number().int().positive().max(15).default(8).describe('Max results to return'),
  }),
  execute: async ({ query, maxResults }: { query: string; maxResults: number }) => {
    const response = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (compatible; NexusAgent/0.1)',
      },
      body: new URLSearchParams({ q: query }).toString(),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      throw new Error(`WebSearch failed (${response.status}) for query: ${query}`)
    }
    const html = await response.text()

    // DDG html 结果形如 <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=<encoded>">title</a>
    const results: Array<{ title: string; url: string }> = []
    const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let m: RegExpExecArray | null
    while ((m = linkRe.exec(html)) && results.length < maxResults) {
      let href = m[1]
      const uddg = /[?&]uddg=([^&]+)/.exec(href)
      if (uddg) href = decodeURIComponent(uddg[1])
      if (href.startsWith('//')) href = 'https:' + href
      const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      if (title && href.startsWith('http')) results.push({ title, url: href })
    }

    if (results.length === 0) {
      return `No results parsed for query: ${query} (upstream layout may have changed, or the query returned nothing).`
    }
    const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`)
    return `Web search results for "${query}" (${results.length}):\n\n${lines.join('\n')}`
  },
}
