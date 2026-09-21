import * as fs from 'fs'
import * as path from 'path'

/**
 * R7 read-before-write 状态机（1:1 cc readFileState 语义，数据安全级）：
 * Read 成功后记录 mtime；Write/Edit/NotebookEdit 对已存在文件执行前必须
 * 有记录且 mtime 未漂移——防止模型盲写覆盖用户/linter 的并发修改。
 * Windows mtime 抖动用 ±2s 容差（cc 用全量内容比对兜底，我们以容差近似）。
 */

interface FileReadRecord {
  mtimeMs: number
}

const fileStates = new Map<string, FileReadRecord>()

/** 归一键：Windows 大小写不敏感盘符上的路径统一小写 */
function stateKey(fullPath: string): string {
  return process.platform === 'win32' ? path.resolve(fullPath).toLowerCase() : path.resolve(fullPath)
}

export function recordFileRead(fullPath: string, mtimeMs: number): void {
  fileStates.set(stateKey(fullPath), { mtimeMs })
}

export function peekFileReadRecord(fullPath: string): FileReadRecord | undefined {
  return fileStates.get(stateKey(fullPath))
}

/** cc FileEditTool error 6/7 文案（模型可自救：先 Read 再写） */
export function assertReadBeforeWrite(
  fullPath: string,
  exists: boolean,
  currentMtimeMs: number | undefined
): void {
  if (!exists) return // 新建文件无需 read-first
  const key = stateKey(fullPath)
  const record = fileStates.get(key)
  if (!record) {
    throw new Error(
      'File has not been read yet. Read it first before writing to it (use the Read tool).'
    )
  }
  const drift = currentMtimeMs === undefined ? 0 : Math.abs(currentMtimeMs - record.mtimeMs)
  if (drift > 2000) {
    throw new Error(
      'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.'
    )
  }
}

/** 测试/清理钩子 */
export function clearFileStates(): void {
  fileStates.clear()
}

/**
 * cc findSimilarFile/suggestPathUnderCwd 简化版：同目录下找"仅大小写/
 * 扩展名不同"或前缀相近的文件名，供 ENOENT 错误文案给出 Did you mean。
 */
export async function findSimilarFile(fullPath: string): Promise<string | null> {
  const dir = path.dirname(fullPath)
  const base = path.basename(fullPath)
  let entries: string[]
  try {
    entries = await fs.promises.readdir(dir)
  } catch {
    return null
  }
  const baseLower = base.toLowerCase()
  const stem = base.replace(/\.[^.]+$/, '')
  const stemLower = stem.toLowerCase()
  let best: string | null = null
  for (const entry of entries) {
    if (entry === base) continue
    const entryLower = entry.toLowerCase()
    const sameStem = entryLower.startsWith(stemLower) && stemLower.length >= 3
    const caseOnly = entryLower === baseLower
    if (caseOnly || sameStem) {
      best = entry
      break
    }
  }
  return best
}
