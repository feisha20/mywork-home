import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'

// 目录时间只用来缓存目录项；文件正文变化仍由每轮文件指纹检查发现。
export class DirectoryCache {
  private entries = new Map<string, { signature: string; checkedAt: number; entries: Dirent[] }>()
  constructor(private readonly ttlMs = 3_600_000) {}
  clear() { this.entries.clear() }
  async read(path: string): Promise<Dirent[]> {
    try {
      const info = await stat(path)
      const signature = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}`
      const cached = this.entries.get(path)
      if (cached?.signature === signature && Date.now() - cached.checkedAt < this.ttlMs) return cached.entries
      const entries = await readdir(path, { withFileTypes: true })
      const after = await stat(path)
      // 遍历期间发生增删时不缓存，下一轮重新列举。
      if (after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs && after.ino === info.ino) {
        if (this.entries.size >= 10_000) this.clear()
        this.entries.set(path, { signature, checkedAt: Date.now(), entries })
      } else this.entries.delete(path)
      return entries
    } catch (error) { this.entries.delete(path); throw error }
  }
}
export type DirectoryReader = (path: string) => Promise<Dirent[]>
