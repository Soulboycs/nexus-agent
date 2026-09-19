import { dialog, ipcMain, BrowserWindow, nativeImage, clipboard } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { basename } from 'path'
import { createHash } from 'crypto'
import { atomicWriteFile } from './atomic-write'
import {
  isEncryptedDocx,
  decryptDocx,
  encryptDocx,
  DocxDecryptError,
  rememberDocPassword,
  docPasswordFor
} from './docx-encryption'
import { buildBlankDocx, saveDocx, type ParsedDocFull, type SaveBlock, type SaveOptions } from '../../packages/docx-engine'
import { installDocsBridge, notifyDocsSavedByEditor } from './docsBridge'
import { recordRecentFile, getRecentFiles } from './docx-recent'

export interface OpenFileResult {
  path: string
  name: string
  data: ArrayBuffer
  hash: string
  encrypted?: boolean
}

export interface OpenFileNeedsPassword {
  needsPassword: true
  path: string
  name: string
}

export type OpenDocxResult = OpenFileResult | OpenFileNeedsPassword | null

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export function registerDocxIpc(getMainWindow: () => BrowserWindow | null) {
  installDocsBridge(getMainWindow)

  // 1. Open file dialog
  ipcMain.handle('docs:open', async (event): Promise<OpenDocxResult> => {
    const win = getMainWindow()
    const opts = {
      title: '打开 Word 文档',
      filters: [{ name: 'Word Documents', extensions: ['docx'] }],
      properties: ['openFile' as const]
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    return loadDocx(result.filePaths[0], event.sender.id)
  })

  // 2. Open by absolute path
  ipcMain.handle('docs:open-path', async (event, filePath: string): Promise<OpenDocxResult> => {
    return loadDocx(filePath, event.sender.id)
  })

  // 3. Decrypt and open
  ipcMain.handle(
    'docs:open-decrypt',
    async (
      event,
      filePath: string,
      password: string
    ): Promise<
      | { ok: true; result: OpenFileResult }
      | { ok: false; reason: 'wrong-password' | 'unsupported' | 'error'; error?: string }
    > => {
      try {
        const raw = await readFile(filePath)
        const plain = await decryptDocx(raw, password)
        rememberDocPassword(event.sender.id, filePath, password)
        const hash = sha256(raw)
        return {
          ok: true,
          result: {
            path: filePath,
            name: basename(filePath),
            data: plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) as ArrayBuffer,
            hash,
            encrypted: true
          }
        }
      } catch (err: any) {
        if (err instanceof DocxDecryptError) {
          return { ok: false, reason: err.reason, error: err.message }
        }
        return { ok: false, reason: 'error', error: err?.message || String(err) }
      }
    }
  )

  // 4. Create blank document
  ipcMain.handle('docs:create-blank', async (): Promise<ArrayBuffer> => {
    const uint8 = await buildBlankDocx()
    return uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength) as ArrayBuffer
  })

  // 5. Save document in place
  ipcMain.handle(
    'docs:save',
    async (
      event,
      filePath: string,
      data: ArrayBuffer,
      _auto?: boolean
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        let outBuffer: Buffer = Buffer.from(data as any)
        const pwd = docPasswordFor(event.sender.id, filePath)
        if (pwd) {
          outBuffer = encryptDocx(outBuffer, pwd)
        }
        await atomicWriteFile(filePath, outBuffer)
        notifyDocsSavedByEditor(filePath)
        return { ok: true }
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) }
      }
    }
  )

  // 5b. Zip + DEFLATE off the renderer thread: the renderer sends the parsed
  // doc and final blocks (structured clone) and this process runs the
  // CPU-heavy compression, so saving a large document never freezes the UI
  ipcMain.handle(
    'docs:zip-save',
    async (
      _event,
      payload: { parsed: ParsedDocFull; finalBlocks: SaveBlock[]; options?: SaveOptions }
    ): Promise<{ ok: boolean; data?: ArrayBuffer; error?: string }> => {
      try {
        const bytes = await saveDocx(payload.parsed, payload.finalBlocks, payload.options ?? {})
        return {
          ok: true,
          data: bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength
          ) as ArrayBuffer
        }
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) }
      }
    }
  )

  // 6. Save document As
  ipcMain.handle(
    'docs:save-as',
    async (
      event,
      defaultName: string,
      data: ArrayBuffer
    ): Promise<{ ok: boolean; path?: string; error?: string }> => {
      const win = getMainWindow()
      const opts = {
        title: '另存为 Word 文档',
        defaultPath: defaultName || 'Document.docx',
        filters: [{ name: 'Word Document', extensions: ['docx'] }]
      }
      const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (result.canceled || !result.filePath) {
        return { ok: false }
      }

      const filePath = result.filePath
      try {
        let outBuffer: Buffer = Buffer.from(data as any)
        const pwd = docPasswordFor(event.sender.id, filePath)
        if (pwd) {
          outBuffer = encryptDocx(outBuffer, pwd)
        }
        await atomicWriteFile(filePath, outBuffer)
        return { ok: true, path: filePath }
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) }
      }
    }
  )

  // 7. Pick local image
  ipcMain.handle('docs:pick-image', async (): Promise<{ base64: string; mime: string; name: string } | null> => {
    const win = getMainWindow()
    const opts = {
      title: '插入图片',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
      properties: ['openFile' as const]
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    const buf = await readFile(filePath)
    const ext = filePath.split('.').pop()?.toLowerCase() || 'png'
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : 'image/png'
    return {
      base64: buf.toString('base64'),
      mime,
      name: basename(filePath)
    }
  })

  // 8. Copy image to clipboard
  ipcMain.handle('docs:copy-image-to-clipboard', async (_event, dataUrl: unknown): Promise<boolean> => {
    if (typeof dataUrl !== 'string') return false
    try {
      if (dataUrl.startsWith('data:image/')) {
        const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
        const image = nativeImage.createFromBuffer(bytes)
        if (image.isEmpty()) return false
        clipboard.writeImage(image)
        return true
      }
      return false
    } catch {
      return false
    }
  })

  // 9. Export to PDF
  const TWIPS_PER_INCH = 1440
  ipcMain.handle(
    'docs:export-pdf',
    async (
      event,
      defaultName: string,
      pageWidthTwips: number,
      pageHeightTwips: number,
      outPath?: string,
      scale?: number
    ): Promise<{ ok: boolean; path?: string; error?: string }> => {
      const win = getMainWindow()
      let filePath = outPath ?? null
      if (!filePath) {
        const opts = {
          title: '导出为 PDF',
          defaultPath: (defaultName || 'Document.docx').replace(/\.docx$/i, '') + '.pdf',
          filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
        }
        const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
        if (result.canceled || !result.filePath) return { ok: false }
        filePath = result.filePath
      }
      try {
        const data = await event.sender.printToPDF({
          printBackground: true,
          pageSize: {
            width: (pageWidthTwips || 11906) / TWIPS_PER_INCH,
            height: (pageHeightTwips || 16838) / TWIPS_PER_INCH
          },
          margins: { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 } as any,
          scale: scale && scale > 0 ? scale : 1
        })
        await writeFile(filePath, data)
        return { ok: true, path: filePath }
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err), path: filePath }
      }
    }
  )

  // 10. Export to clean HTML
  ipcMain.handle(
    'docs:export-html',
    async (
      _event,
      defaultName: string,
      html: string,
      outPath?: string
    ): Promise<{ ok: boolean; path?: string; error?: string }> => {
      if (typeof html !== 'string' || !html) return { ok: false, error: 'empty document' }
      const win = getMainWindow()
      let filePath = outPath ?? null
      if (!filePath) {
        const opts = {
          title: '导出为 HTML',
          defaultPath: (defaultName || 'Document.docx').replace(/\.docx$/i, '') + '.html',
          filters: [{ name: 'HTML Document', extensions: ['html'] }]
        }
        const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
        if (result.canceled || !result.filePath) return { ok: false }
        filePath = result.filePath
      }
      try {
        await writeFile(filePath, html, 'utf8')
        return { ok: true, path: filePath }
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err), path: filePath }
      }
    }
  )

  // 11. Print document
  ipcMain.handle('docs:print', async (event, scale?: number): Promise<{ ok: boolean; error?: string }> => {
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      event.sender.print(
        {
          margins: { marginType: 'none' } as any,
          scaleFactor: scale && scale > 0 && scale !== 1 ? Math.round(scale * 100) : undefined
        },
        (success, failureReason) => {
          resolve({
            ok: success,
            ...(failureReason && !/cancel/i.test(failureReason) ? { error: failureReason } : {})
          })
        }
      )
    })
  })

  // 12. Recent documents list
  ipcMain.handle('docs:get-recent', async () => getRecentFiles())
}

export { recordRecentFile, getRecentFiles } from './docx-recent'

async function loadDocx(filePath: string, wcId: number): Promise<OpenDocxResult> {
  try {
    const raw = await readFile(filePath)
    const encrypted = isEncryptedDocx(raw)
    if (encrypted) {
      const pwd = docPasswordFor(wcId, filePath)
      if (!pwd) {
        return { needsPassword: true, path: filePath, name: basename(filePath) }
      }
      try {
        const plain = await decryptDocx(raw, pwd)
        recordRecentFile(filePath)
        return {
          path: filePath,
          name: basename(filePath),
          data: plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) as ArrayBuffer,
          hash: sha256(raw),
          encrypted: true
        }
      } catch {
        return { needsPassword: true, path: filePath, name: basename(filePath) }
      }
    }

    recordRecentFile(filePath)
    return {
      path: filePath,
      name: basename(filePath),
      data: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
      hash: sha256(raw),
      encrypted: false
    }
  } catch (err) {
    console.error('[docxIpc] Failed to load docx:', err)
    return null
  }
}
