/**
 * docs:zip-save IPC handler body, extracted so the real production code path
 * (main-process DEFLATE compression) is directly testable without Electron.
 * docxIpc registers this function verbatim — same code the app executes.
 */
import {
  saveDocx,
  type ParsedDocFull,
  type SaveBlock,
  type SaveOptions,
} from '../../packages/docx-engine'

export interface ZipSavePayload {
  parsed: ParsedDocFull
  finalBlocks: SaveBlock[]
  options?: SaveOptions
}

export type ZipSaveResult = { ok: boolean; data?: ArrayBuffer; error?: string }

export async function zipSavePayload(payload: ZipSavePayload): Promise<ZipSaveResult> {
  try {
    const bytes = await saveDocx(payload.parsed, payload.finalBlocks, payload.options ?? {})
    return {
      ok: true,
      data: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}
