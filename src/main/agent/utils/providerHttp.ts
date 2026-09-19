import { logger } from '../../utils/logger'

/**
 * Shared streaming-fetch retry policy for all providers
 * (1:1 with Claude Code services/api/withRetry.ts request-level policy).
 *
 * - Defaults: DEFAULT_MAX_RETRIES = 10, BASE_DELAY_MS = 500 with exponential
 *   backoff (500 * 2^(attempt-1), capped at 30s) — same constants as cc.
 * - Retries transient failures: 429 / 408 (timeout) / 409 (lock) / 5xx and
 *   network-level fetch errors; obeys the `x-should-retry` header when the
 *   server explicitly forbids it.
 * - Never retries aborts (AbortError) or other non-transient 4xx.
 * - Env: CLAUDE_CODE_MAX_RETRIES overrides the attempt count (same env name
 *   and meaning as cc's request-level override). NEXUS_PROVIDER_RETRY_DELAY_MS
 *   replaces the base delay (test harness only).
 */

export const BASE_DELAY_MS = 500
export const DEFAULT_MAX_RETRIES = 10
const MAX_DELAY_MS = 30_000

export function getProviderMaxRetries(): number {
  const raw = parseInt(process.env.CLAUDE_CODE_MAX_RETRIES || '', 10)
  if (Number.isFinite(raw) && raw >= 0) return raw
  const legacy = parseInt(process.env.CLAUDE_STREAM_TRANSIENT_RETRY_MAX || '', 10)
  if (Number.isFinite(legacy) && legacy >= 0) return legacy
  return DEFAULT_MAX_RETRIES
}

function baseDelayMs(): number {
  const parsed = parseInt(process.env.NEXUS_PROVIDER_RETRY_DELAY_MS || '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : BASE_DELAY_MS
}

function backoffDelayMs(attempt: number): number {
  return Math.min(baseDelayMs() * Math.pow(2, attempt - 1), MAX_DELAY_MS)
}

export interface FetchWithRetryOptions {
  url: string
  init: RequestInit
  /** Provider label for logs / status updates. */
  provider: string
  model?: string
  onStatusUpdate?: (message: string) => void
  signal?: AbortSignal
}

function isTransientStatus(status: number, headers: Headers | undefined): boolean {
  // Server explicitly forbids retry — obey (cc withRetry x-should-retry rule).
  const shouldRetryHeader = headers?.get('x-should-retry')
  if (shouldRetryHeader === 'false') return false
  if (shouldRetryHeader === 'true') return true
  return status === 429 || status === 408 || status === 409 || status >= 500
}

export async function fetchWithStreamingRetry(options: FetchWithRetryOptions): Promise<Response> {
  const maxRetries = getProviderMaxRetries()
  let retries = 0

  while (true) {
    let response: Response
    try {
      response = (await fetch(options.url, {
        ...options.init,
        signal: options.signal,
      })) as Response
    } catch (err: any) {
      if (err?.name === 'AbortError' || options.signal?.aborted) throw err
      if (retries >= maxRetries) {
        throw new Error(
          `Request failed to ${options.url} (model: ${options.model ?? 'n/a'}): ${err?.message}`
        )
      }
      retries++
      logger.warn(
        options.provider,
        `Network error on ${options.url}: ${err?.message} — retrying (attempt ${retries}/${maxRetries})`
      )
      options.onStatusUpdate?.(
        `Network error: ${err?.message}. Retrying in ${backoffDelayMs(retries) / 1000}s (attempt ${retries}/${maxRetries})...`
      )
      await new Promise((r) => setTimeout(r, backoffDelayMs(retries)))
      continue
    }

    if (response.ok) return response

    const errorText = await response.text().catch(() => '')
    if (!isTransientStatus(response.status, response.headers) || retries >= maxRetries) {
      logger.error(
        options.provider,
        `LLM API Error (${response.status}) on ${options.url}: ${errorText}`,
        { status: response.status, model: options.model, url: options.url }
      )
      throw new Error(`LLM Provider API error (${response.status}): ${errorText}`)
    }

    retries++
    logger.warn(
      options.provider,
      `Transient ${response.status} on ${options.url} — retrying (attempt ${retries}/${maxRetries})`
    )
    options.onStatusUpdate?.(
      `Rate limited or server error (${response.status}). Retrying in ${backoffDelayMs(retries) / 1000}s (attempt ${retries}/${maxRetries})...`
    )
    await new Promise((r) => setTimeout(r, backoffDelayMs(retries)))
  }
}
