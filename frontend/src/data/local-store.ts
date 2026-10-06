import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'
const READ_RETRY_TIMES = 2

// 取数失败：往上抛，调用方按失败处理，不许拿旧读数顶替。
export class StorageReadError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`本地数据读取失败：${reason}`)
    this.name = 'StorageReadError'
    this.reason = reason
  }
}

// 写库失败：就地撤销，调用方整笔退回，不留半条。
export class StorageWriteError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`本地数据写入失败：${reason}`)
    this.name = 'StorageWriteError'
    this.reason = reason
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isRowArray(value: unknown): value is EntryRow[] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        typeof (row as EntryRow).id !== 'undefined' &&
        typeof (row as EntryRow).status === 'string',
    )
  )
}

// 落库前校验一遍：每一行都得有 id / status / pending / abnormal，缺了就不存。
function validateRows(key: string, rows: EntryRow[]): void {
  if (!Array.isArray(rows)) {
    throw new StorageWriteError(`模块 ${key} 的数据不是列表，拒绝落库`)
  }
  for (const row of rows) {
    if (
      row === null ||
      typeof row !== 'object' ||
      typeof row.id !== 'number' ||
      typeof row.status !== 'string' ||
      typeof row.pending !== 'boolean' ||
      typeof row.abnormal !== 'boolean'
    ) {
      throw new StorageWriteError(`模块 ${key} 存在缺 id/状态 的半截记录，拒绝落库`)
    }
  }
}

function readRaw(): string | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch (error) {
    throw new StorageReadError(error instanceof Error ? error.message : '浏览器拒绝了读取请求')
  }
}

function parseStorage(raw: string): Record<string, EntryRow[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 数据损坏时绝不拿示例数据或旧缓存顶替，也不覆盖现场数据，按失败处理。
    throw new StorageReadError('存根不是合法 JSON，可能已损坏；未用旧数据顶替，请重试或联系值班员恢复')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StorageReadError('存根结构不是模块字典，可能已损坏；未用旧数据顶替')
  }
  const store = parsed as Record<string, unknown>
  for (const [key, value] of Object.entries(store)) {
    if (!isRowArray(value)) {
      throw new StorageReadError(`模块 ${key} 的记录结构不完整，可能写入了半截数据；未用旧数据顶替`)
    }
  }
  return store as Record<string, EntryRow[]>
}

function seedStorage(): Record<string, EntryRow[]> {
  // 首次打开（或当前环境没有 localStorage）：播种示例数据，这不属于“拿旧读数顶替”。
  const fallback = clone(SEED_ROWS)
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    } catch (error) {
      throw new StorageWriteError(error instanceof Error ? error.message : '播种初始数据时被浏览器拒绝')
    }
  }
  return fallback
}

// 取不到就按失败处理并重试；重试仍失败把原因写清楚抛出去。
function readStorage(): Record<string, EntryRow[]> {
  let lastError: StorageReadError | null = null
  for (let attempt = 0; attempt <= READ_RETRY_TIMES; attempt += 1) {
    try {
      const raw = readRaw()
      if (raw === null) {
        return seedStorage()
      }
      return { ...clone(SEED_ROWS), ...parseStorage(raw) }
    } catch (error) {
      if (error instanceof StorageWriteError) {
        throw error
      }
      lastError = error instanceof StorageReadError ? error : new StorageReadError(String(error))
    }
  }
  throw new StorageReadError(`重试 ${READ_RETRY_TIMES} 次仍失败，${lastError?.reason ?? '原因未知'}`)
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 整库原子写：先校验、先落库，落库成功才换内存；任何一步失败都就地撤销，不留半条。
function persistAll(next: Record<string, EntryRow[]>): void {
  for (const [key, rows] of Object.entries(next)) {
    validateRows(key, rows)
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    const serialized = JSON.stringify(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, serialized)
    } catch (error) {
      cache = null
      throw new StorageWriteError(error instanceof Error ? error.message : '浏览器拒绝写入（可能超出配额）')
    }
    // 复查一遍：读回来确认真的存上了、且就是刚写的那版，存不成就算失败。
    try {
      const confirmRaw = readRaw()
      if (confirmRaw === null) {
        throw new StorageWriteError('写入后复查读不到数据')
      }
      parseStorage(confirmRaw)
      if (confirmRaw !== serialized) {
        throw new StorageWriteError('写入后复查与本次提交不一致')
      }
    } catch (error) {
      cache = null
      if (error instanceof StorageWriteError) {
        throw error
      }
      throw new StorageWriteError(error instanceof Error ? error.message : '写入后复查失败')
    }
  }
  cache = next
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  persistAll(next)
}

// 一次事务改多个模块：mutate 基于当前整库算出下一版，校验通过后一次性落库。
// 中途抛错（校验不过、写库失败）时内存与存根都保持原样，整笔退回。
export function transact(mutate: (current: Record<string, EntryRow[]>) => Record<string, EntryRow[]>): void {
  const current = allRows()
  const next = mutate(clone(current))
  persistAll(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
