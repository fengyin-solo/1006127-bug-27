import { DOMAIN_GROUT_SEED, DOMAIN_MORTAR_SEED } from './seed'
import type {
  BatchCursor,
  GroutRecord,
  GroutStatus,
  GroutStore,
  MortarBatch,
  RepairRecord,
  RepairVerdict,
} from './types'

/**
 * 注浆领域仓储：注浆记录、浆液批次、批量游标放在同一个 key、同一份快照里。
 * - 整笔原子写：先在内存里算好下一份快照再落库，写失败恢复旧快照，不留半条；
 * - 存量记录：把旧通用表里的 grouting/mortar 迁移过来，按对应环次重新入库、同编号去重；
 * - 写库故障可注入（writeFault），用于验证「写不成就整笔退回」。
 */

const STORE_KEY = 'shield-tunnel-construction:grout-domain:v1'
const LEGACY_KEY = 'shield-tunnel-construction:entries'
const STORE_VERSION = 1

/** 写库故障注入：always 让下一次提交必失败；once 只让下一次失败一次（验证就地撤销后可重提）。 */
export type WriteFault = 'none' | 'once' | 'always'
let writeFault: WriteFault = 'none'

export function setWriteFault(mode: WriteFault): void {
  writeFault = mode
}

export function getWriteFault(): WriteFault {
  return writeFault
}

type StorageShape = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storage(): StorageShape | null {
  if (typeof globalThis === 'undefined') return null
  const candidate = (globalThis as { localStorage?: StorageShape }).localStorage
  return candidate ?? null
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(String(value).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : null
}

function toNumber(value: unknown, fallback = 0): number {
  const n = toNumberOrNull(value)
  return n === null ? fallback : n
}

/**
 * 旧通用表行（EntryRow 结构）映射成领域注浆记录。
 * 历史占位数据大多没有数值/设计量：能解析的解析，解析不了的按 legacy 保留。
 */
function fromLegacyGrout(row: Record<string, unknown>, index: number): GroutRecord {
  const groutNo = String(row['注浆编号'] ?? `LEGACY-GROUT-${index + 1}`)
  const ringNo = String(row['对应环号'] ?? `R-LEGACY-${index + 1}`)
  const rawStatus = String(row['注浆状态'] ?? row['status'] ?? '已完成')
  const status: GroutStatus = (['待注浆', '注浆中', '已完成', '已补浆'] as const).some(
    (s) => s === rawStatus,
  )
    ? (rawStatus as GroutStatus)
    : '已完成'
  const amount = toNumberOrNull(row['注浆量'])
  const pressure = toNumberOrNull(row['注浆压力'])
  const initialSetTime = String(row['初凝时间'] ?? '')
  const looksLikePlaceholder = (v: unknown) =>
    typeof v === 'string' && /样例\d+$/.test(v)

  return {
    id: index + 1,
    groutNo,
    ringNo: looksLikePlaceholder(ringNo) ? ringNo.replace(/.*样例/, 'R-LEGACY-') : ringNo,
    mixRatio: looksLikePlaceholder(row['浆液配比']) ? '待补录' : String(row['浆液配比'] ?? '待补录'),
    groutAmount: amount ?? 0,
    pressure: pressure ?? 0,
    initialSetTime: /\d{4}-\d{2}-\d{2}/.test(initialSetTime) ? initialSetTime : '',
    crew: looksLikePlaceholder(row['注浆班组']) ? '待补录' : String(row['注浆班组'] ?? '待补录'),
    // 老表没有设计量字段：一律视为历史记录，超量判定豁免。
    designAmount: null,
    status,
    confirmed: status === '已完成' || status === '已补浆',
    verified: null,
    legacy: true,
  }
}

function fromLegacyMortar(row: Record<string, unknown>, index: number): MortarBatch {
  const rawStatus = String(row['批次状态'] ?? row['status'] ?? '检验合格')
  const status = (['待拌制', '拌制中', '检验合格', '已废弃'] as const).some((s) => s === rawStatus)
    ? (rawStatus as MortarBatch['status'])
    : '检验合格'
  return {
    id: index + 1,
    batchNo: String(row['批次编号'] ?? `LEGACY-MORT-${index + 1}`),
    mortarType: '同步注浆惰性浆液',
    cementKg: toNumber(row['水泥用量'], 120),
    bentoniteKg: toNumber(row['膨润土用量'], 60),
    waterCementRatio: toNumber(row['水灰比'], 3.5),
    consistency: toNumber(row['稠度'], 95),
    mixedAt: String(row['拌制日期'] ?? ''),
    status,
  }
}

/**
 * 同一注浆编号只留一条的取舍规则（冲突时拍板）：
 * 1. 已完成注浆确认的优先于未确认；
 * 2. 都确认/都未确认时，现场读数更完整（有注浆量且有初凝时间）的优先；
 * 3. 仍分不出，取后出现的一条（视作最新提交）。
 */
function dedupeGrout(records: GroutRecord[]): GroutRecord[] {
  const byNo = new Map<string, GroutRecord>()
  for (const incoming of records) {
    const existing = byNo.get(incoming.groutNo)
    if (!existing) {
      byNo.set(incoming.groutNo, incoming)
      continue
    }
    const score = (r: GroutRecord) =>
      (r.confirmed ? 2 : 0) + (r.groutAmount > 0 ? 1 : 0) + (r.initialSetTime ? 1 : 0)
    if (score(incoming) >= score(existing)) {
      byNo.set(incoming.groutNo, { ...incoming, id: existing.id })
    }
  }
  return [...byNo.values()]
}

/** 存量记录按对应环次重新入库：环次升序，环次相同按注浆编号，主键随之稳定重排。 */
function reindexByRing(records: GroutRecord[]): GroutRecord[] {
  const sorted = [...records].sort((a, b) => {
    const ring = a.ringNo.localeCompare(b.ringNo, 'zh-Hans-CN', { numeric: true })
    return ring !== 0 ? ring : a.groutNo.localeCompare(b.groutNo)
  })
  return sorted.map((row, index) => ({ ...row, id: index + 1 }))
}

function reindexMortar(batches: MortarBatch[]): MortarBatch[] {
  const sorted = [...batches].sort((a, b) => a.batchNo.localeCompare(b.batchNo))
  return sorted.map((row, index) => ({ ...row, id: index + 1 }))
}

function readLegacy(): { grouting: GroutRecord[]; mortar: MortarBatch[] } {
  const ls = storage()
  if (!ls) return { grouting: [], mortar: [] }
  const raw = ls.getItem(LEGACY_KEY)
  if (!raw) return { grouting: [], mortar: [] }
  try {
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>[]>
    const grouting = (parsed['grouting'] ?? []).map((row, i) => fromLegacyGrout(row, i))
    const mortar = (parsed['mortar'] ?? []).map((row, i) => fromLegacyMortar(row, i))
    return { grouting, mortar }
  } catch {
    return { grouting: [], mortar: [] }
  }
}

function initialStore(): GroutStore {
  const ls = storage()
  if (ls) {
    const raw = ls.getItem(STORE_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as GroutStore
        if (parsed && Array.isArray(parsed.grouting) && Array.isArray(parsed.mortar)) {
          return { ...parsed, cursor: parsed.cursor ?? null }
        }
      } catch {
        // 落库内容损坏时不使用半截数据，落回「种子+迁移」重建。
      }
    }
  }

  // 首次进入：合并领域种子与存量通用表数据，同编号去重、按环次重新入库。
  const legacy = readLegacy()
  const grouting = reindexByRing(dedupeGrout([...DOMAIN_GROUT_SEED, ...legacy.grouting]))
  const mortar = reindexMortar([...DOMAIN_MORTAR_SEED, ...legacy.mortar])
  const store: GroutStore = { version: STORE_VERSION, grouting, mortar, cursor: null }

  // 去重后新领域表即唯一数据源；清掉旧 key 里的两份，避免两边分成两份。
  if (ls) {
    ls.setItem(STORE_KEY, JSON.stringify(store))
    try {
      const raw = ls.getItem(LEGACY_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        delete parsed['grouting']
        delete parsed['mortar']
        ls.setItem(LEGACY_KEY, JSON.stringify(parsed))
      }
    } catch {
      // 旧 key 清理失败不阻塞新表建立，投影层只认新表。
    }
  }
  return store
}

let cache: GroutStore | null = null

export function getStore(): GroutStore {
  if (cache === null) {
    cache = initialStore()
  }
  return cache
}

/** 测试/重置入口。 */
export function resetStore(): GroutStore {
  cache = null
  return getStore()
}

/**
 * 原子提交：在副本上改，落库成功才替换内存；落库失败就地撤销，内存保持旧值。
 * 返回 false 表示写库失败（调用方整笔退回，不得认为已登记）。
 */
export function commit(mutator: (draft: GroutStore) => void): { ok: boolean; reason?: string } {
  const current = getStore()
  const next = clone(current)
  mutator(next)

  if (writeFault !== 'none') {
    const reason =
      writeFault === 'always'
        ? '写库失败：存储介质不可用（注入故障）'
        : '写库失败：本次提交被中断（注入故障）'
    if (writeFault === 'once') writeFault = 'none'
    // 不替换 cache、不写 localStorage：整笔撤销，不留半条。
    return { ok: false, reason }
  }

  const ls = storage()
  if (ls) {
    try {
      ls.setItem(STORE_KEY, JSON.stringify(next))
    } catch (error) {
      return {
        ok: false,
        reason: `写库失败：${error instanceof Error ? error.message : 'localStorage 写入异常'}，已整笔撤销`,
      }
    }
  }
  cache = next
  return { ok: true }
}

/** 直接取注浆记录副本。 */
export function listGrouting(): GroutRecord[] {
  return clone(getStore().grouting)
}

/** 直接取浆液批次副本。 */
export function listMortar(): MortarBatch[] {
  return clone(getStore().mortar)
}

export function getCursor(): BatchCursor | null {
  return getStore().cursor ? clone(getStore().cursor as BatchCursor) : null
}

export function nextGroutId(rows: GroutRecord[]): number {
  return rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
}

export type { GroutRecord, MortarBatch, RepairRecord, RepairVerdict }
