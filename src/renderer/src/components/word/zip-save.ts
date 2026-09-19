/**
 * DEFLATE compression is CPU-heavy: run the zip splice in the main process so
 * saving a large document never freezes the renderer (typing keeps working).
 * Falls back to the local engine call when the bridge is missing or fails —
 * both paths run the same engine code and produce identical bytes.
 */
import {
  saveDocx,
  type ParsedDocFull,
  type SaveBlock,
  type SaveOptions,
} from '@genoffice/docx-engine'

export async function zipDocxBytes(
  parsed: ParsedDocFull,
  finalBlocks: SaveBlock[],
  options: SaveOptions,
): Promise<Uint8Array> {
  const bridge = (
    window as unknown as {
      desktop?: {
        zipSave?: (payload: {
          parsed: unknown
          finalBlocks: unknown[]
          options?: unknown
        }) => Promise<{ ok: boolean; data?: ArrayBuffer; error?: string }>
      }
    }
  ).desktop
  if (bridge?.zipSave) {
    try {
      const res = await bridge.zipSave({ parsed, finalBlocks, options })
      if (res.ok && res.data) return new Uint8Array(res.data)
      if (!res.ok) throw new Error(res.error ?? 'docs:zip-save failed')
    } catch {
      // structured-clone limits or a missing handler: recompute in-process
    }
  }
  return saveDocx(parsed, finalBlocks, options)
}
