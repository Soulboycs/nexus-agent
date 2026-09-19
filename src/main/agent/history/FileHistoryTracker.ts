import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'

export interface FileBackupRecord {
  filePath: string
  relativePath: string
  backupPath: string | null // null means file did not exist prior to this turn
  existed: boolean
  timestamp: number
}

export interface FileSnapshot {
  snapshotId: string
  timestamp: number
  backups: Record<string, FileBackupRecord>
}

export interface IFileHistoryTracker {
  trackEdit(filePath: string, workspaceRoot: string): Promise<void>
  createSnapshot(snapshotId?: string): void
  rewindLastSnapshot(workspaceRoot: string): Promise<{ restored: string[]; deleted: string[] }>
  canRewind(): boolean
  getSnapshotCount(): number
}

export class FileHistoryTracker implements IFileHistoryTracker {
  private snapshots: FileSnapshot[] = []
  private pendingBackups: Record<string, FileBackupRecord> = {}
  private backupDir: string | null = null

  constructor(private workspaceRoot?: string) {}

  private async getBackupDir(root: string): Promise<string> {
    const dir = path.join(root, '.nexus', 'history', 'backups')
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  /**
   * Tracks a file edit before it happens (1:1 with Claude Code fileHistoryTrackEdit)
   * Captures initial pre-edit state so rewind can cleanly restore or delete the file.
   */
  async trackEdit(filePath: string, workspaceRoot: string): Promise<void> {
    const root = workspaceRoot || this.workspaceRoot || process.cwd()
    const normalizedFile = path.resolve(filePath)
    const relPath = path.relative(root, normalizedFile).replace(/\\/g, '/')

    // If already tracked in current pending turn, preserve original v1 backup
    if (this.pendingBackups[relPath]) {
      return
    }

    try {
      const stats = await fs.stat(normalizedFile)
      if (stats.isDirectory()) return

      const backupDir = await this.getBackupDir(root)
      const content = await fs.readFile(normalizedFile)
      const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
      const backupFilename = `${Date.now()}_${hash}.bak`
      const backupPath = path.join(backupDir, backupFilename)

      await fs.writeFile(backupPath, content)

      this.pendingBackups[relPath] = {
        filePath: normalizedFile,
        relativePath: relPath,
        backupPath,
        existed: true,
        timestamp: Date.now()
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        // File does not exist yet (will be newly created)
        this.pendingBackups[relPath] = {
          filePath: normalizedFile,
          relativePath: relPath,
          backupPath: null,
          existed: false,
          timestamp: Date.now()
        }
      }
    }
  }

  /**
   * Commits the pending mutations into a completed snapshot
   */
  createSnapshot(snapshotId?: string): void {
    if (Object.keys(this.pendingBackups).length === 0) {
      return
    }

    const snapshot: FileSnapshot = {
      snapshotId: snapshotId || `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      backups: { ...this.pendingBackups }
    }

    this.snapshots.push(snapshot)
    this.pendingBackups = {}
  }

  canRewind(): boolean {
    return this.snapshots.length > 0 || Object.keys(this.pendingBackups).length > 0
  }

  getSnapshotCount(): number {
    return this.snapshots.length
  }

  /**
   * Rewinds the most recent snapshot (1:1 with Claude Code fileHistoryRewind)
   * Restores prior file contents or deletes created files.
   */
  async rewindLastSnapshot(workspaceRoot: string): Promise<{ restored: string[]; deleted: string[] }> {
    const root = workspaceRoot || this.workspaceRoot || process.cwd()

    // If there are uncommitted pending edits, rewind those first
    let targetBackups: Record<string, FileBackupRecord> = {}
    if (Object.keys(this.pendingBackups).length > 0) {
      targetBackups = this.pendingBackups
      this.pendingBackups = {}
    } else if (this.snapshots.length > 0) {
      const snap = this.snapshots.pop()!
      targetBackups = snap.backups
    } else {
      return { restored: [], deleted: [] }
    }

    const restored: string[] = []
    const deleted: string[] = []

    for (const [relPath, record] of Object.entries(targetBackups)) {
      try {
        if (!record.existed || record.backupPath === null) {
          // File was created; delete it to restore pre-edit state
          await fs.rm(record.filePath, { force: true })
          deleted.push(relPath)
        } else {
          // File existed; restore previous contents from backup
          await fs.mkdir(path.dirname(record.filePath), { recursive: true })
          await fs.copyFile(record.backupPath, record.filePath)
          restored.push(relPath)
        }
      } catch (err) {
        // Continue best-effort rewind for other files
      }
    }

    return { restored, deleted }
  }
}
