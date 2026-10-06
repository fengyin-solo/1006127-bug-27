// Node 测试用的最小 localStorage 垫片：让领域仓储在无浏览器环境也能跑。
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
  dump(): Record<string, string> {
    return Object.fromEntries(this.map.entries())
  }
}

export function installStorage(): MemoryStorage {
  const storage = new MemoryStorage()
  ;(globalThis as { localStorage?: unknown }).localStorage = storage
  return storage
}

export type { MemoryStorage }
