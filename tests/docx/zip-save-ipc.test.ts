import JSZip from 'jszip'
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  parseDocx,
  saveDocx,
  type ParsedDocFull,
  type SaveBlock,
} from '../../src/packages/docx-engine/index'
import { buildDocx } from './helpers/build-docx'
import { zipDocxBytes } from '../../src/renderer/src/components/word/zip-save'
import { zipSavePayload } from '../../src/main/docx/docs-zip-save'

const originalOrder = (doc: ParsedDocFull): SaveBlock[] =>
  doc.blocks
    .filter((b) => !b.hidden && b.docxIndex !== null)
    .map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex! }))

// restore whatever globalThis.window held before this file swapped in its
// fake desktop bridge — later test files in the same bun process see the
// original (typically a happy-dom Window or nothing) again
const prevWindow = (globalThis as Record<string, unknown>).window
afterAll(() => {
  ;(globalThis as Record<string, unknown>).window = prevWindow
})

async function zipEntries(bytes: Uint8Array): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(bytes)
  const out: Record<string, string> = {}
  for (const name of Object.keys(zip.files)) {
    const entry = zip.file(name)
    if (!entry) continue // directory entries
    out[name] = await entry.async('string')
  }
  return out
}

describe('zip-save IPC (MS Word P1 alignment: save never freezes the renderer)', () => {
  it('the REAL main-process handler (docs-zip-save.ts) produces engine-identical output', async () => {
    // docxIpc registers zipSavePayload verbatim, so calling it directly IS the
    // production code path minus the electron transport layer
    const parsed = await parseDocx(
      await buildDocx({ bodyXml: '<w:p><w:r><w:t>handler</w:t></w:r></w:p>' }),
    )
    const blocks = originalOrder(parsed)
    const result = await zipSavePayload({ parsed, finalBlocks: blocks, options: {} })
    expect(result.ok).toBe(true)
    const local = await saveDocx(parsed, blocks, {})
    const handlerZip = await JSZip.loadAsync(new Uint8Array(result.data!))
    const localZip = await JSZip.loadAsync(local)
    expect(await handlerZip.file('word/document.xml')!.async('string')).toBe(
      await localZip.file('word/document.xml')!.async('string'),
    )
  })

  it('binds zipSave in the preload bridge and declares it in the renderer bridge types', () => {
    const preload = fs.readFileSync(path.resolve('src/preload/index.ts'), 'utf8')
    expect(preload).toContain("ipcRenderer.invoke('docs:zip-save', payload)")
    const bridge = fs.readFileSync(
      path.resolve('src/renderer/src/shared/ipc.ts'),
      'utf8',
    )
    expect(bridge).toContain('zipSave(payload: {')
  })

  it('produces byte-identical entries to the in-process save via the bridge payload', async () => {
    const parsed = await parseDocx(
      await buildDocx({ bodyXml: '<w:p><w:r><w:t>body</w:t></w:r></w:p>' }),
    )
    const blocks = originalOrder(parsed)
    const options = {
      header: {
        text: 'Chapter',
        paras: [{ align: 'center' as const, runs: [{ text: 'Chapter' }] }],
      },
    }
    // fake bridge: runs the same engine call the main-process handler runs,
    // proving the payload alone is sufficient to rebuild the document
    ;(globalThis as Record<string, unknown>).window = {
      desktop: {
        zipSave: async (payload: {
          parsed: ParsedDocFull
          finalBlocks: SaveBlock[]
          options?: Record<string, unknown>
        }) => {
          const bytes = await saveDocx(
            payload.parsed,
            payload.finalBlocks,
            payload.options as Parameters<typeof saveDocx>[2],
          )
          return {
            ok: true,
            data: bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          }
        },
      },
    }
    const ipcBytes = await zipDocxBytes(parsed, blocks, options as never)
    const localBytes = await saveDocx(parsed, blocks, options as never)
    const ipcEntries = await zipEntries(ipcBytes)
    const localEntries = await zipEntries(localBytes)
    expect(Object.keys(ipcEntries).sort()).toEqual(Object.keys(localEntries).sort())
    for (const name of Object.keys(localEntries))
      expect(ipcEntries[name]).toBe(localEntries[name])
  })

  it('falls back to the in-process engine when the bridge is absent', async () => {
    ;(globalThis as Record<string, unknown>).window = {}
    const parsed = await parseDocx(
      await buildDocx({ bodyXml: '<w:p><w:r><w:t>fallback</w:t></w:r></w:p>' }),
    )
    const blocks = originalOrder(parsed)
    const bytes = await zipDocxBytes(parsed, blocks, {})
    expect(bytes.length).toBeGreaterThan(0)
    const zip = await JSZip.loadAsync(bytes)
    expect(zip.file('word/document.xml')).not.toBeNull()
  })

  it('falls back when the bridge reports an error', async () => {
    let called = 0
    ;(globalThis as Record<string, unknown>).window = {
      desktop: {
        zipSave: async () => {
          called += 1
          return { ok: false, error: 'boom' }
        },
      },
    }
    const parsed = await parseDocx(
      await buildDocx({ bodyXml: '<w:p><w:r><w:t>err</w:t></w:r></w:p>' }),
    )
    const bytes = await zipDocxBytes(parsed, originalOrder(parsed), {})
    expect(called).toBe(1)
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('the full IPC payload survives structuredClone (Electron serialization) byte-identically', async () => {
    const parsed = await parseDocx(
      await buildDocx({
        bodyXml:
          '<w:p><w:r><w:t>clone chain</w:t></w:r></w:p><w:p><w:r><w:t>second</w:t></w:r></w:p>',
        extraStylesXml:
          '<w:style w:type="paragraph" w:styleId="Custom"><w:name w:val="Custom Style"/></w:style>',
      }),
    )
    const blocks = originalOrder(parsed)
    const options = {
      header: { text: 'H', paras: [{ align: 'center' as const, runs: [{ text: 'H' }] }] },
    }
    // Electron IPC arguments go through structuredClone; if any field of the
    // parsed doc / blocks / options were uncloneable this throws and the real
    // bridge would fall back (wasting the off-thread path) — so cloneability
    // IS the contract under test
    const cloned = structuredClone({ parsed, finalBlocks: blocks, options })
    const viaClone = await saveDocx(
      cloned.parsed,
      cloned.finalBlocks,
      cloned.options as Parameters<typeof saveDocx>[2],
    )
    const localBytes = await saveDocx(parsed, blocks, options as never)
    const cloneEntries = await zipEntries(viaClone)
    const localEntries = await zipEntries(localBytes)
    expect(Object.keys(cloneEntries).sort()).toEqual(Object.keys(localEntries).sort())
    for (const name of Object.keys(localEntries)) {
      expect(cloneEntries[name]).toBe(localEntries[name])
    }
  })
})
