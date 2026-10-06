import { SEED_ROWS } from './seed'
import { groutRows, mortarRows, resetStore } from '@/domain/grout'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'

// grouting / mortar 已收归补浆领域存储，通用表里不再保留这两份，避免两边数据分叉。
const DOMAIN_KEYS = new Set(['grouting', 'mortar'])

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 首次读取通用表：触发补浆领域的存量迁移，并从合并后的快照里剔除两个领域键。 */
function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
    // 领域模块在首次访问其领域存储时完成存量迁移（按环次重排、同编号去重）。
    resetStore()
    for (const key of DOMAIN_KEYS) {
      delete cache[key]
    }
  }
  const merged: Record<string, EntryRow[]> = { ...cache }
  merged['grouting'] = groutRows()
  merged['mortar'] = mortarRows()
  return merged
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  if (DOMAIN_KEYS.has(key)) {
    // 领域键只读投影：写操作必须走补浆领域服务，这里不允许通用路径另存一份。
    return
  }
  const next = { ...readView(), [key]: rows }
  cache = stripDomain(next)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  }
}

export function resetRows(key: string): EntryRow[] {
  if (DOMAIN_KEYS.has(key)) {
    resetStore()
    return listRows(key)
  }
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

function readView(): Record<string, EntryRow[]> {
  return cache ?? readStorage()
}

function stripDomain(view: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const next = { ...view }
  for (const key of DOMAIN_KEYS) {
    delete next[key]
  }
  return next
}

export function storageKey(): string {
  return STORAGE_KEY
}
