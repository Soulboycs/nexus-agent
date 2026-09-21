/**
 * Shared tool schema serialization (1:1 with Claude Code utils/zodToJsonSchema.ts + utils/api.ts toolToAPISchema).
 *
 * All providers MUST build their tool definitions through these helpers so that
 * zod type information (string/number/boolean/enum/array/object, required,
 * descriptions) reaches the API verbatim. The previous per-provider
 * extractZodProperties copies collapsed every parameter to { type: 'string' },
 * which biased models toward emitting string-typed arguments.
 */
import { zodToJsonSchema } from 'zod-to-json-schema'
import { isDocsEditorReady as probeDocsEditorReady } from './runtimeContext'
import type { AgentTool } from '../tools/ToolRegistry'

/** Command-class tool names (cc Bash semantics), incl. legacy aliases during migration. */
export function isCommandToolName(name: string): boolean {
  return name === 'Bash' || name === 'run_command' || name === 'PowerShell' || name === 'bash'
}

export interface ToolJSONSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

// Cache by schema object identity: tool.parameters is a stable per-tool ZodType
// reference, and chatStream serializes every tool on every request.
const schemaCache = new WeakMap<object, ToolJSONSchema>()

export function toolToJSONSchema(tool: AgentTool<any>): ToolJSONSchema {
  const params = tool.parameters as object
  const hit = schemaCache.get(params)
  if (hit) return hit

  const raw = zodToJsonSchema(params as never, { $refStrategy: 'none' }) as {
    properties?: Record<string, unknown>
    required?: string[]
  }
  const schema: ToolJSONSchema = {
    type: 'object',
    properties: raw?.properties ?? {},
    ...(Array.isArray(raw?.required) && raw.required.length > 0 ? { required: raw.required } : {}),
  }
  // Freeze: the cached object is shared across requests and providers — a
  // consumer mutating it (e.g. adding `required`) would poison every later call.
  Object.freeze(schema)
  Object.freeze(schema.properties)
  schemaCache.set(params, schema)
  return schema
}

const GEMINI_TYPE_MAP: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
}

/**
 * Converts a JSON Schema node to Gemini's OpenAPI-subset parameter format
 * (uppercase types; only whitelisted keys survive — Gemini rejects unknown
 * keywords like `default`).
 */
function toGeminiNode(node: unknown): Record<string, unknown> {
  if (!node || typeof node !== 'object') return {}
  const n = node as Record<string, unknown>
  const out: Record<string, unknown> = {}

  if (typeof n.type === 'string') {
    out.type = GEMINI_TYPE_MAP[n.type] ?? n.type.toUpperCase()
  }
  if (typeof n.description === 'string') out.description = n.description
  if (Array.isArray(n.enum)) out.enum = n.enum
  if (Array.isArray(n.required)) out.required = n.required
  if (typeof n.format === 'string') out.format = n.format
  if (typeof n.minimum === 'number') out.minimum = n.minimum
  if (typeof n.maximum === 'number') out.maximum = n.maximum
  if (typeof n.exclusiveMinimum === 'number') out.exclusiveMinimum = n.exclusiveMinimum
  if (typeof n.exclusiveMaximum === 'number') out.exclusiveMaximum = n.exclusiveMaximum
  if (n.nullable === true) out.nullable = true
  if (n.items) out.items = toGeminiNode(n.items)
  if (n.properties && typeof n.properties === 'object') {
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(n.properties)) {
      props[k] = toGeminiNode(v)
    }
    out.properties = props
  }
  return out
}

export function toGeminiParameters(schema: ToolJSONSchema): Record<string, unknown> {
  return toGeminiNode(schema)
}

export interface ToolDescriptionContext {
  workspaceRoot: string
  docsEditorReady?: boolean
}

/**
 * Resolves a tool description that may be static or context-dependent
 * (P3 dynamic descriptions). Static strings pass through untouched.
 */
export function resolveToolDescription(
  tool: Pick<AgentTool<any>, 'name' | 'description'>,
  ctx?: ToolDescriptionContext
): string {
  if (typeof tool.description === 'function') {
    return (tool.description as (ctx?: ToolDescriptionContext) => string)(
      ctx ?? { workspaceRoot: '', docsEditorReady: probeDocsEditorReady() }
    )
  }
  return tool.description as string
}
