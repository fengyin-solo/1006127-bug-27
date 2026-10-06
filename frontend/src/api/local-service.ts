import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows, transact } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  PendingRegroutBatch,
  RegroutBatchResult,
  RegroutInput,
  RegroutItemResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

function terminalStatuses(meta: ModuleMeta): string[] {
  return meta.terminalStatuses ?? [meta.statuses[meta.statuses.length - 1]]
}

// 动作允许从哪些状态发起：显式登记优先，缺省按状态链取目标的前一格。
function allowedSources(meta: ModuleMeta, action: string, target: string): string[] {
  const explicit = meta.actionSources?.[action]
  if (explicit) {
    return explicit
  }
  const targetIndex = meta.statuses.indexOf(target)
  return targetIndex > 0 ? [meta.statuses[targetIndex - 1]] : []
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 越级当场拦下：没走到动作要求的状态，不许跳转（比如没确认完成就不许安排补浆）。
  const sources = allowedSources(meta, action, target)
  if (sources.length > 0 && !sources.includes(current)) {
    return {
      ok: false,
      message: `${meta.entity}当前状态「${current}」不能执行「${action}」，需要先走到「${sources.join('」或「')}」`,
    }
  }
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: !terminalStatuses(meta).includes(target),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  // 看板也先过一遍存量校正，保证第一眼看到的就是重新入库后的口径。
  ensureRegroutConsistency()
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// —— 统计卡：全站页面共用这一份算法，行列与数字都不再各写一份 ——

function numericValues(rows: EntryRow[], field: string): number[] {
  return rows
    .map((row) => Number.parseFloat(String(row[field] ?? '')))
    .filter((value) => Number.isFinite(value))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

const STAT_COMPUTERS: Record<string, (rows: EntryRow[]) => number> = {
  'grouting:注浆总量': (rows) => round2(numericValues(rows, '注浆量').reduce((s, v) => s + v, 0)),
  'grouting:待补浆记录': () => listPendingRegroutBatches().length,
  'grouting:平均注浆压力': (rows) => {
    const values = numericValues(rows, '注浆压力')
    return values.length ? round2(values.reduce((s, v) => s + v, 0) / values.length) : 0
  },
  'regrout:待补浆批次': () => listPendingRegroutBatches().length,
  'regrout:超量补浆记录': (rows) => rows.filter((row) => row.abnormal).length,
  'mortar:待拌制批次': (rows) => rows.filter((row) => row.status === '待拌制').length,
  'mortar:合格批次': (rows) => rows.filter((row) => row.status === '检验合格').length,
  'mortar:废弃批次': (rows) => rows.filter((row) => row.status === '已废弃').length,
}

export function moduleStats(key: string): { label: string; value: number }[] {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  return meta.metrics.map((label) => {
    const computer = STAT_COMPUTERS[`${key}:${label}`]
    if (computer) {
      return { label, value: computer(rows) }
    }
    // 通用算法：指标文案里包含哪个状态名，就数那个状态的记录数，数不到就是 0。
    const matched = meta.statuses.find((status) => label.includes(status))
    return { label, value: matched ? rows.filter((row) => row.status === matched).length : 0 }
  })
}

// —— 补浆：取数与登记两处入口共用这一份实现 ——

const GROUTING_KEY = 'grouting'
const REGROUT_KEY = 'regrout'
const MORTAR_KEY = 'mortar'

// 超量判定（拍板）：以源注浆记录的注浆量为基准，补浆量超过基准 20% 即判超量，
// 登记照走但打异常标记，由值班工程师在页面上复核；历史记录注浆量不是数字时
// 按无基准处理，只登记不判超量（兼容历史注浆记录）。
const OVER_QUANTITY_RATIO = 1.2

// 冲突裁决（拍板）：同一注浆编号重复提交，以已入库的记录为准（先写为准），
// 后来的整笔退回并说明原因，不覆盖、不合并；对应环号一律以源注浆记录为准。

function cloneStore<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function codeSuffix(code: string, fallback: number): string {
  const matched = /(\d+)$/.exec(code.trim())
  return matched ? matched[1] : String(fallback).padStart(4, '0')
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// 存量记录按对应环次重新入库：去重（同一注浆编号只留最先一条）、以源注浆记录
// 校正对应环号、补齐/去重浆液拌制侧的待用批次。返回是否有改动。
function normalizeRegrout(all: Record<string, EntryRow[]>): { next: Record<string, EntryRow[]>; changed: boolean } {
  const next = cloneStore(all)
  let changed = false

  const groutingByCode = new Map<string, EntryRow>()
  for (const row of next[GROUTING_KEY] ?? []) {
    groutingByCode.set(String(row['注浆编号'] ?? ''), row)
  }

  const seen = new Set<string>()
  const keptRegrout: EntryRow[] = []
  for (const row of next[REGROUT_KEY] ?? []) {
    const code = String(row['注浆编号'] ?? '').trim()
    if (code && seen.has(code)) {
      // 同一注浆编号重复入库的历史记录：只留最先一条，其余的当场清掉。
      changed = true
      continue
    }
    seen.add(code)
    const source = groutingByCode.get(code)
    if (source) {
      const ring = String(source['对应环号'] ?? '')
      if (ring && row['对应环号'] !== ring) {
        row['对应环号'] = ring
        changed = true
      }
    } else if (!row.abnormal) {
      // 历史遗留：找不到源注浆记录，标异常留着，不偷偷删。
      row.abnormal = true
      changed = true
    }
    keptRegrout.push(row)
  }
  if (keptRegrout.length !== (next[REGROUT_KEY] ?? []).length) {
    next[REGROUT_KEY] = keptRegrout
    changed = true
  }

  const regroutCodes = new Set(keptRegrout.map((row) => String(row['注浆编号'] ?? '')))
  const pendingCodes = new Set(
    keptRegrout
      .filter((row) => row.status === '待补浆' || row.status === '补浆中')
      .map((row) => String(row['注浆编号'] ?? '')),
  )

  // 待用批次去重去孤儿：同一注浆编号只留一批，没有对应补浆记录的批次清掉。
  const keptMortar: EntryRow[] = []
  const batchSeen = new Set<string>()
  for (const row of next[MORTAR_KEY] ?? []) {
    const linked = String(row['关联注浆编号'] ?? '').trim()
    if (!linked) {
      keptMortar.push(row)
      continue
    }
    if (batchSeen.has(linked) || !regroutCodes.has(linked)) {
      changed = true
      continue
    }
    batchSeen.add(linked)
    keptMortar.push(row)
  }
  if (keptMortar.length !== (next[MORTAR_KEY] ?? []).length) {
    next[MORTAR_KEY] = keptMortar
    changed = true
  }

  // 待补浆/补浆中的记录必须有一批待用浆液，缺了就补建，保证两侧对得上。
  for (const code of pendingCodes) {
    if (!batchSeen.has(code)) {
      const id = nextId(next[MORTAR_KEY] ?? [])
      const batch = buildStandbyBatch(id, code)
      next[MORTAR_KEY] = [...(next[MORTAR_KEY] ?? []), batch]
      batchSeen.add(code)
      changed = true
    }
  }

  return { next, changed }
}

// 取数、登记两个入口都先过这一关，保证看到的是同一份、且是最新校正后的数据。
function ensureRegroutConsistency(): void {
  const { next, changed } = normalizeRegrout(allRows())
  if (changed) {
    transact(() => next)
  }
}

function buildStandbyBatch(id: number, groutingCode: string): EntryRow {
  return {
    id,
    status: '待拌制',
    pending: true,
    abnormal: false,
    批次编号: `MORT-R${codeSuffix(groutingCode, id)}`,
    浆液类型: '补浆待用液',
    水泥用量: '待配',
    膨润土用量: '待配',
    水灰比: '待配',
    稠度: '待配',
    拌制日期: today(),
    批次状态: '待用',
    关联注浆编号: groutingCode,
  }
}

function normalizeInput(input: RegroutInput): RegroutInput {
  return {
    注浆编号: input.注浆编号.trim(),
    补浆量: input.补浆量.trim(),
    注浆压力: input.注浆压力.trim(),
    初凝时间: input.初凝时间.trim(),
    补浆班组: input.补浆班组.trim(),
  }
}

// 落库前校验一遍：任何一项不过都整笔退回，不写半条。
function validateRegroutInput(all: Record<string, EntryRow[]>, input: RegroutInput): string | null {
  if (!input.注浆编号) {
    return '注浆编号不能为空'
  }
  const groutingRow = (all[GROUTING_KEY] ?? []).find((row) => String(row['注浆编号']) === input.注浆编号)
  if (!groutingRow) {
    return `注浆编号 ${input.注浆编号} 没有对应的注浆记录`
  }
  const duplicated = (all[REGROUT_KEY] ?? []).find((row) => String(row['注浆编号']) === input.注浆编号)
  if (duplicated) {
    return `注浆编号 ${input.注浆编号} 已登记过补浆记录（${duplicated['补浆编号']}），同一编号只留一条，本次整笔退回`
  }
  if (String(groutingRow.status) === '已补浆') {
    return `注浆记录 ${input.注浆编号} 已是「已补浆」，不许重复安排补浆`
  }
  if (String(groutingRow.status) !== '已完成') {
    return `注浆记录 ${input.注浆编号} 当前状态「${groutingRow.status}」，没走完注浆确认，不许安排补浆`
  }
  const volume = Number.parseFloat(input.补浆量)
  if (!input.补浆量 || !Number.isFinite(volume) || volume <= 0) {
    return '补浆量必须是大于 0 的数字；取不到数就按失败处理，不许拿旧读数顶替'
  }
  const pressure = Number.parseFloat(input.注浆压力)
  if (!input.注浆压力 || !Number.isFinite(pressure) || pressure < 0) {
    return '注浆压力必须是不小于 0 的数字；取不到数就按失败处理，不许拿旧读数顶替'
  }
  if (!input.初凝时间 || Number.isNaN(Date.parse(input.初凝时间))) {
    return '初凝时间不能为空，格式为 YYYY-MM-DD'
  }
  if (!input.补浆班组) {
    return '补浆班组不能为空'
  }
  return null
}

function overQuantityNote(all: Record<string, EntryRow[]>, input: RegroutInput): string {
  const groutingRow = (all[GROUTING_KEY] ?? []).find((row) => String(row['注浆编号']) === input.注浆编号)
  const base = Number.parseFloat(String(groutingRow?.['注浆量'] ?? ''))
  const volume = Number.parseFloat(input.补浆量)
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(volume)) {
    return ''
  }
  if (volume > base * OVER_QUANTITY_RATIO) {
    return `补浆量 ${volume} 超过注浆量基准 ${base} 的 20%，判为超量`
  }
  return ''
}

// 一笔登记 = 补浆记录 + 浆液拌制待用批次 + 源注浆记录状态，同一事务里同生同灭。
function buildRegroutRegistration(all: Record<string, EntryRow[]>, input: RegroutInput): Record<string, EntryRow[]> {
  const reason = validateRegroutInput(all, input)
  if (reason) {
    throw new Error(reason)
  }
  const note = overQuantityNote(all, input)
  const groutingRows = all[GROUTING_KEY] ?? []
  const regroutRows = all[REGROUT_KEY] ?? []
  const mortarRows = all[MORTAR_KEY] ?? []
  const groutingRow = groutingRows.find((row) => String(row['注浆编号']) === input.注浆编号) as EntryRow

  const regroutId = nextId(regroutRows)
  const suffix = codeSuffix(input.注浆编号, regroutId)
  const regroutRow: EntryRow = {
    id: regroutId,
    status: '待补浆',
    pending: true,
    abnormal: note !== '',
    补浆编号: `REGR-${suffix}`,
    注浆编号: input.注浆编号,
    对应环号: String(groutingRow['对应环号'] ?? ''),
    补浆量: input.补浆量,
    注浆压力: input.注浆压力,
    初凝时间: input.初凝时间,
    补浆班组: input.补浆班组,
    补浆状态: '待补浆',
    ...(note ? { 超量说明: note } : {}),
  }
  const batchRow = buildStandbyBatch(nextId(mortarRows), input.注浆编号)
  const updatedGrouting: EntryRow = {
    ...groutingRow,
    status: '已补浆',
    pending: false,
    补浆编号: regroutRow['补浆编号'],
  }

  return {
    ...all,
    [GROUTING_KEY]: groutingRows.map((row) => (row.id === groutingRow.id ? updatedGrouting : row)),
    [REGROUT_KEY]: [...regroutRows, regroutRow],
    [MORTAR_KEY]: [...mortarRows, batchRow],
  }
}

// 批量登记：逐笔校验、逐笔落库，每一笔都是一个完整事务。
// 中途断掉时，已经登记的留在库里，重跑只会跳过它们（不再重来），
// 失败的那几笔带着原因留在结果里，从断掉的那条接着走。
export function registerRegroutBatch(inputs: RegroutInput[]): RegroutBatchResult {
  ensureRegroutConsistency()
  const results: RegroutItemResult[] = []
  for (const raw of inputs) {
    const input = normalizeInput(raw)
    try {
      const note = overQuantityNote(allRows(), input)
      transact((current) => buildRegroutRegistration(current, input))
      results.push({
        input,
        ok: true,
        duplicated: false,
        message: note ? `已登记，${note}，已打异常标记待复核` : '已登记',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({ input, ok: false, duplicated: message.includes('只留一条'), message })
    }
  }
  return {
    results,
    registered: results.filter((item) => item.ok).length,
    duplicated: results.filter((item) => item.duplicated).length,
    failed: results.filter((item) => !item.ok && !item.duplicated).length,
  }
}

export function registerRegrout(input: RegroutInput): RegroutItemResult {
  return registerRegroutBatch([input]).results[0]
}

// 补浆取数入口：先校正存量，再按条件列表；取不到就抛错，不拿旧读数顶替。
export function listRegroutEntries(filters: Record<string, string> = {}): PageResult {
  ensureRegroutConsistency()
  return listEntries(REGROUT_KEY, filters)
}

// 还可以安排补浆的注浆记录：已确认完成、且还没登记过补浆。
export function listEligibleGrouting(): EntryRow[] {
  ensureRegroutConsistency()
  const used = new Set((allRows()[REGROUT_KEY] ?? []).map((row) => String(row['注浆编号'] ?? '')))
  return (allRows()[GROUTING_KEY] ?? []).filter(
    (row) => row.status === '已完成' && !used.has(String(row['注浆编号'] ?? '')),
  )
}

// 待补浆批次对账清单：补浆侧与浆液拌制侧都从这一份取，两边自然对得上。
export function listPendingRegroutBatches(): PendingRegroutBatch[] {
  ensureRegroutConsistency()
  const all = allRows()
  const batchByCode = new Map<string, EntryRow>()
  for (const row of all[MORTAR_KEY] ?? []) {
    const linked = String(row['关联注浆编号'] ?? '').trim()
    if (linked) {
      batchByCode.set(linked, row)
    }
  }
  return (all[REGROUT_KEY] ?? [])
    .filter((row) => row.status === '待补浆' || row.status === '补浆中')
    .map((row) => {
      const code = String(row['注浆编号'] ?? '')
      const batch = batchByCode.get(code)
      return {
        补浆编号: String(row['补浆编号'] ?? ''),
        注浆编号: code,
        对应环号: String(row['对应环号'] ?? ''),
        补浆量: String(row['补浆量'] ?? ''),
        初凝时间: String(row['初凝时间'] ?? ''),
        批次编号: batch ? String(batch['批次编号']) : '未生成',
        批次状态: batch ? String(batch.status) : '缺失',
      }
    })
}
