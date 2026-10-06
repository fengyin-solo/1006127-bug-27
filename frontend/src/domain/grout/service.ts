import { commit, getCursor, listGrouting, listMortar, nextGroutId } from './repository'
import { fetchReading } from './device-gateway'
import { GROUT_ACTION_FROM, judgeRepair } from './policy'
import type {
  BatchCursor,
  DeviceReading,
  FetchOutcome,
  GroutRecord,
  GroutStatus,
  GroutStore,
  MortarBatch,
  RegisterResult,
  RepairRecord,
} from './types'

/**
 * 补浆领域服务：取数入口与登记入口共用这一份校验和落库逻辑。
 * 所有写操作都经过 repository 的原子提交：落库前校验，写不成就整笔退回，不留半条。
 */

export type GroutDraft = {
  groutNo: string
  ringNo: string
  mixRatio: string
  groutAmount: number
  pressure: number
  initialSetTime: string
  crew: string
  designAmount: number | null
}

export type RepairDraft = {
  groutNo: string
  batchNo: string
  amount: number
  pressure: number
  initialSetTime: string
  excessNote?: string
}

/** 落库前统一校验：取数入口和手工登记入口都走这里。 */
export function validateDraft(draft: GroutDraft): string | null {
  if (!draft.groutNo.trim()) return '注浆编号不能为空'
  if (!draft.ringNo.trim()) return '对应环号不能为空'
  if (!Number.isFinite(draft.groutAmount) || draft.groutAmount < 0) return '注浆量必须是不小于 0 的数值'
  if (!Number.isFinite(draft.pressure) || draft.pressure < 0) return '注浆压力必须是不小于 0 的数值'
  if (draft.groutAmount > 0 && !draft.initialSetTime.trim()) {
    return '已有注浆量时初凝时间不能为空，注浆量与初凝时间必须在同一份登记里'
  }
  if (draft.designAmount !== null && (!Number.isFinite(draft.designAmount) || draft.designAmount < 0)) {
    return '设计注浆量必须是不小于 0 的数值，或留空按历史记录处理'
  }
  return null
}

/** 时间归一：datetime-local 的 T 与现场纸面记录的空格两种写法统一成空格。 */
function normalizeTime(value: string): string {
  return value.trim().replace('T', ' ')
}

function normalizeDraft(draft: GroutDraft): GroutDraft {
  return { ...draft, initialSetTime: normalizeTime(draft.initialSetTime) }
}

function sameCore(a: GroutDraft, b: GroutRecord): boolean {
  return (
    a.ringNo === b.ringNo &&
    Math.abs(a.groutAmount - b.groutAmount) < 1e-9 &&
    Math.abs(a.pressure - b.pressure) < 1e-9 &&
    a.initialSetTime === b.initialSetTime
  )
}

/**
 * 登记一条注浆记录。
 * - 同一注浆编号重复提交：已确认且内容一致 → 幂等，只记一次；
 * - 已确认但读数对不上 → 拒绝（现场确认值为准，防止拿新读数顶掉确认记录）；
 * - 未确认草稿 → 允许最新提交覆盖；
 * - 写库失败 → 整笔退回。
 */
export function registerGrouting(
  draftInput: GroutDraft,
): RegisterResult<{ record: GroutRecord; duplicated: boolean }> {
  const draft = normalizeDraft(draftInput)
  const invalid = validateDraft(draft)
  if (invalid) return { ok: false, reason: invalid }

  const rows = listGrouting()
  const existing = rows.find((row) => row.groutNo === draft.groutNo)

  if (existing) {
    if (sameCore(draft, existing)) {
      return { ok: true, data: { record: existing, duplicated: true }, notice: '该注浆编号已登记，重复提交未重复记账' }
    }
    if (existing.confirmed) {
      return {
        ok: false,
        reason: `注浆编号 ${draft.groutNo} 已完成注浆确认且读数与本次提交不一致（登记注浆量 ${existing.groutAmount}、压力 ${existing.pressure}）；冲突时以现场已确认记录为准，如需更正请走复查订正入口`,
      }
    }
  }

  const result = commit((draft2: GroutStore) => {
    const index = draft2.grouting.findIndex((row) => row.groutNo === draft.groutNo)
    if (index >= 0) {
      draft2.grouting[index] = {
        ...draft2.grouting[index],
        ...draft,
        mixRatio: draft.mixRatio || draft2.grouting[index].mixRatio,
        crew: draft.crew || draft2.grouting[index].crew,
        lastError: undefined,
      }
      return
    }
    const record: GroutRecord = {
      id: nextGroutId(draft2.grouting),
      ...draft,
      status: '待注浆',
      confirmed: false,
      verified: null,
      lastError: undefined,
    }
    draft2.grouting.push(record)
  })

  if (!result.ok) return { ok: false, reason: result.reason ?? '写库失败，已整笔退回' }
  const saved = listGrouting().find((row) => row.groutNo === draft.groutNo)
  if (!saved) return { ok: false, reason: '写库后复查未找到该记录，本次登记撤销' }
  return { ok: true, data: { record: saved, duplicated: false } }
}

/** 把取数网关读数直接变成登记草稿：两个入口共用 registerGrouting。 */
export function draftFromReading(
  reading: DeviceReading,
  crew = '注浆一班',
  mixRatio = '水泥:膨润土:砂:水=120:60:800:420',
): GroutDraft {
  return {
    groutNo: reading.groutNo,
    ringNo: reading.ringNo,
    mixRatio,
    groutAmount: reading.groutAmount,
    pressure: reading.pressure,
    initialSetTime: reading.initialSetTime,
    crew,
    designAmount: reading.designAmount,
  }
}

/** 注浆状态流转：越级动作当场拦下。 */
export function transition(groutNo: string, action: '开始注浆' | '确认完成'): RegisterResult<GroutRecord> {
  const rows = listGrouting()
  const record = rows.find((row) => row.groutNo === groutNo)
  if (!record) return { ok: false, reason: `没有找到注浆编号 ${groutNo}` }
  const required = GROUT_ACTION_FROM[action]
  if (record.status !== required) {
    return {
      ok: false,
      reason: `注浆编号 ${groutNo} 当前状态为「${record.status}」，「${action}」只能从「${required}」发起，越级操作已拦下`,
    }
  }
  const target: GroutStatus = action === '开始注浆' ? '注浆中' : '已完成'
  const result = commit((store) => {
    const row = store.grouting.find((item) => item.groutNo === groutNo)
    if (!row) return
    row.status = target
    if (action === '确认完成') row.confirmed = true
    row.lastError = undefined
  })
  if (!result.ok) return { ok: false, reason: result.reason ?? '写库失败，状态未变更' }
  const saved = listGrouting().find((row) => row.groutNo === groutNo)
  return saved
    ? { ok: true, data: saved }
    : { ok: false, reason: '写库后复查未找到该记录，状态变更撤销' }
}

/** 待用批次清单：检验合格、尚未被补浆结论占用。注浆页与浆液拌制页同源读取。 */
export function pendingBatches(): MortarBatch[] {
  return listMortar().filter((batch) => batch.status === '检验合格' && !batch.reservedFor)
}

/** 待补浆记录：已完成注浆确认、注浆量低于设计量、且还没有补浆。历史无设计量的不催补。 */
export function pendingRepairRecords(): GroutRecord[] {
  return listGrouting().filter(
    (row) =>
      row.confirmed &&
      !row.repair &&
      row.designAmount !== null &&
      row.groutAmount + 1e-9 < row.designAmount,
  )
}

/**
 * 安排补浆：注浆记录侧与浆液批次侧在同一次原子提交里落库。
 * - 没走完注浆确认的当场拦下，禁止越级；
 * - 补浆量与初凝时间必须同一份齐全，否则整笔退回；
 * - 超 5% 必须带超量说明，结论记「超量补入」；
 * - 写库失败两边一起撤销。
 */
export function arrangeRepair(draftInput: RepairDraft, operator: string): RegisterResult<{ record: GroutRecord; batch: MortarBatch }> {
  const draft = { ...draftInput, initialSetTime: normalizeTime(draftInput.initialSetTime) }
  const rows = listGrouting()
  const record = rows.find((row) => row.groutNo === draft.groutNo)
  if (!record) return { ok: false, reason: `没有找到注浆编号 ${draft.groutNo}` }
  if (!record.confirmed || record.status !== '已完成') {
    return {
      ok: false,
      reason: `注浆编号 ${draft.groutNo} 尚未走完注浆确认（当前「${record.status}」），未确认的记录不许安排补浆`,
    }
  }
  if (record.repair) {
    return {
      ok: false,
      reason: `注浆编号 ${draft.groutNo} 已补浆（批次 ${record.repair.batchNo}），同一笔补浆不重复登记`,
    }
  }
  if (!Number.isFinite(draft.amount) || draft.amount <= 0) {
    return { ok: false, reason: '补浆量必须大于 0；补浆量缺失时整笔退回，不得先登记后补数' }
  }
  if (!Number.isFinite(draft.pressure) || draft.pressure < 0) {
    return { ok: false, reason: '补浆压力必须是不小于 0 的数值' }
  }
  if (!draft.initialSetTime.trim()) {
    return { ok: false, reason: '补浆初凝时间必填；初凝时间与补浆量要落在同一份记录里，缺一项整笔退回' }
  }

  const batches = listMortar()
  const batch = batches.find((item) => item.batchNo === draft.batchNo)
  if (!batch) return { ok: false, reason: `浆液拌制里没有批次 ${draft.batchNo}` }
  if (batch.status !== '检验合格' || batch.reservedFor) {
    return { ok: false, reason: `批次 ${draft.batchNo} 不在待用清单（当前「${batch.status}」），不能用于补浆` }
  }

  const judgment = judgeRepair(record.designAmount, record.groutAmount, draft.amount)
  let verdict = judgment.verdict
  if (!judgment.allowed && !draft.excessNote?.trim()) {
    return {
      ok: false,
      reason: `本次补入 ${draft.amount}m³ 后总量 ${Number((record.groutAmount + draft.amount).toFixed(3))}m³，超过设计量 ${record.designAmount}m³ 的 5% 上限（${judgment.ceiling}m³）。超量补入必须填写批准人及原因后再提交`,
    }
  }
  if (judgment.allowed) verdict = '补足'

  const repair: RepairRecord = {
    batchNo: draft.batchNo,
    amount: draft.amount,
    pressure: draft.pressure,
    initialSetTime: draft.initialSetTime,
    verdict,
    excessNote: verdict === '超量补入' ? draft.excessNote?.trim() : undefined,
    operator,
    registeredAt: new Date().toISOString(),
  }

  const result = commit((store) => {
    const targetRecord = store.grouting.find((item) => item.groutNo === draft.groutNo)
    const targetBatch = store.mortar.find((item) => item.batchNo === draft.batchNo)
    if (!targetRecord || !targetBatch) return
    targetRecord.repair = repair
    targetRecord.status = '已补浆'
    targetRecord.lastError = undefined
    targetBatch.status = '已使用'
    targetBatch.reservedFor = {
      groutNo: targetRecord.groutNo,
      ringNo: targetRecord.ringNo,
      repairAmount: repair.amount,
      verdict,
      at: repair.registeredAt,
    }
  })
  if (!result.ok) return { ok: false, reason: result.reason ?? '写库失败，补浆登记已整笔退回（批次未占用）' }

  const savedRecord = listGrouting().find((row) => row.groutNo === draft.groutNo)
  const savedBatch = listMortar().find((item) => item.batchNo === draft.batchNo)
  if (!savedRecord?.repair || savedBatch?.status !== '已使用') {
    return { ok: false, reason: '写库后复查发现补浆与批次未同时落库，请重试' }
  }
  return { ok: true, data: { record: savedRecord, batch: savedBatch } }
}

/**
 * 落库后复查：重新从设备取数与登记值核对。
 * 取数失败或不一致时不动登记值、不沿用旧值，只写失败原因，等待重试或订正。
 */
export async function recheckRecord(groutNo: string): Promise<RegisterResult<{ consistent: boolean; outcome: FetchOutcome }>> {
  const outcome = await fetchReading(groutNo)
  if (!outcome.ok) {
    commit((store) => {
      const row = store.grouting.find((item) => item.groutNo === groutNo)
      if (row) row.lastError = `复查取数失败：${outcome.reason}`
    })
    return { ok: false, reason: `复查取数失败：${outcome.reason}` }
  }
  const reading = outcome.reading
  const current = listGrouting().find((row) => row.groutNo === groutNo)
  if (!current) return { ok: false, reason: `复查时未找到注浆编号 ${groutNo}` }

  const diffs: string[] = []
  if (Math.abs(current.groutAmount - reading.groutAmount) > 1e-9) {
    diffs.push(`注浆量 登记${current.groutAmount} / 现场${reading.groutAmount}`)
  }
  if (Math.abs(current.pressure - reading.pressure) > 1e-9) {
    diffs.push(`注浆压力 登记${current.pressure} / 现场${reading.pressure}`)
  }
  if (current.initialSetTime && current.initialSetTime.slice(0, 16) !== reading.initialSetTime.slice(0, 16)) {
    diffs.push(`初凝时间 登记${current.initialSetTime} / 现场${reading.initialSetTime}`)
  }

  const consistent = diffs.length === 0
  commit((store) => {
    const row = store.grouting.find((item) => item.groutNo === groutNo)
    if (!row) return
    row.verified = consistent
    row.lastError = consistent ? undefined : `复查不一致：${diffs.join('；')}，以现场读数为准请订正`
  })
  return { ok: true, data: { consistent, outcome } }
}

/** 开启批量取数登记任务：排队即持久化，已登记编号不重复入队。 */
export function startBatchJob(groutNos: string[]): RegisterResult<BatchCursor> {
  if (getCursor()) {
    return { ok: false, reason: '已有一批取数登记在进行中，请先让它跑完或从断点继续' }
  }
  const known = new Set(listGrouting().map((row) => row.groutNo))
  const queue = groutNos.map((no) => no.trim()).filter(Boolean)
  if (queue.length === 0) return { ok: false, reason: '批量登记至少选择一个注浆编号' }
  const dupInInput = queue.filter((no, i) => queue.indexOf(no) !== i)
  if (dupInInput.length > 0) {
    return { ok: false, reason: `同一批里注浆编号重复：${[...new Set(dupInInput)].join('、')}` }
  }
  // 库里已确认的编号不允许批量再取数顶掉；未确认的可刷新。
  const confirmed = queue.filter((no) => known.has(no) && listGrouting().find((r) => r.groutNo === no)?.confirmed)
  if (confirmed.length > 0) {
    return { ok: false, reason: `这些编号已完成注浆确认，批量取数不得覆盖：${confirmed.join('、')}` }
  }
  const now = new Date().toISOString()
  const cursor: BatchCursor = {
    jobId: `JOB-${Date.now()}`,
    queue,
    done: [],
    startedAt: now,
    updatedAt: now,
  }
  const result = commit((store) => {
    store.cursor = cursor
  })
  if (!result.ok) return { ok: false, reason: result.reason ?? '批量任务建立失败' }
  return { ok: true, data: getCursor() as BatchCursor }
}

export type BatchProgress = {
  cursor: BatchCursor | null
  stopped?: boolean
}

/**
 * 推进批量任务：从队首逐条取数→登记→游标前移，全部在一次步里原子落库。
 * 取数失败：已登记的保留在 done，游标停在失败编号，下次从这里继续（不整批退回）。
 * 写库失败：当步撤销、游标不前移，重试同一条。
 */
export async function advanceBatchJob(
  crew: string,
  options: { maxAttempts?: number; sleep?: (ms: number) => Promise<void> | void } = {},
): Promise<BatchProgress> {
  let cursor = getCursor()
  if (!cursor) return { cursor: null }

  while (cursor && cursor.queue.length > 0) {
    const groutNo = cursor.queue[0]
    const outcome = await fetchReading(groutNo, options)
    if (!outcome.ok) {
      const failed = { groutNo, reason: outcome.reason }
      const stop = commit((store) => {
        if (store.cursor) {
          store.cursor.failed = failed
          store.cursor.updatedAt = new Date().toISOString()
        }
      })
      if (!stop.ok) return { cursor: getCursor(), stopped: true }
      return { cursor: getCursor(), stopped: true }
    }

    const draft = draftFromReading(outcome.reading, crew)
    const registered = registerGrouting(draft)
    if (!registered.ok) {
      const stop = commit((store) => {
        if (store.cursor) {
          store.cursor.failed = { groutNo, reason: registered.reason }
          store.cursor.updatedAt = new Date().toISOString()
        }
      })
      void stop
      return { cursor: getCursor(), stopped: true }
    }

    const moved = commit((store) => {
      if (!store.cursor) return
      store.cursor.done.push(groutNo)
      store.cursor.queue = store.cursor.queue.filter((no) => no !== groutNo)
      store.cursor.failed = undefined
      store.cursor.updatedAt = new Date().toISOString()
    })
    if (!moved.ok) {
      // 登记落了库但游标没动：恢复时 registerGrouting 对未确认记录幂等覆盖，不会重复记账。
      return { cursor: getCursor(), stopped: true }
    }
    cursor = getCursor()
  }

  if (cursor && cursor.queue.length === 0) {
    commit((store) => {
      store.cursor = null
    })
  }
  return { cursor: getCursor() }
}

/** 失败编号重试：清掉失败标记后从断掉那一条继续。 */
export async function resumeBatchJob(
  crew: string,
  options: { maxAttempts?: number; sleep?: (ms: number) => Promise<void> | void } = {},
): Promise<BatchProgress> {
  return advanceBatchJob(crew, options)
}

/** 放弃当前批量任务（已登记的记录保留，不清不回退）。 */
export function discardBatchJob(): RegisterResult<{ kept: string[] }> {
  const cursor = getCursor()
  if (!cursor) return { ok: false, reason: '当前没有进行中的批量任务' }
  const kept = [...cursor.done]
  const result = commit((store) => {
    store.cursor = null
  })
  if (!result.ok) return { ok: false, reason: result.reason ?? '任务状态写库失败' }
  return { ok: true, data: { kept } }
}

/** 浆液批次状态流转（开始拌制 / 提交检验 / 废弃批次），与注浆页同一存储落库。 */
export function transitionMortar(
  batchNo: string,
  action: '开始拌制' | '提交检验' | '废弃批次',
): RegisterResult<MortarBatch> {
  const flow: Record<string, { from: MortarBatch['status']; to: MortarBatch['status'] }> = {
    开始拌制: { from: '待拌制', to: '拌制中' },
    提交检验: { from: '拌制中', to: '检验合格' },
    废弃批次: { from: '拌制中', to: '已废弃' },
  }
  const rule = flow[action]
  const batch = listMortar().find((item) => item.batchNo === batchNo)
  if (!batch) return { ok: false, reason: `没有找到浆液批次 ${batchNo}` }
  if (batch.status !== rule.from) {
    return {
      ok: false,
      reason: `批次 ${batchNo} 当前为「${batch.status}」，「${action}」只能从「${rule.from}」发起，越级操作已拦下`,
    }
  }
  const result = commit((store) => {
    const target = store.mortar.find((item) => item.batchNo === batchNo)
    if (target) target.status = rule.to
  })
  if (!result.ok) return { ok: false, reason: result.reason ?? '写库失败，批次状态未变更' }
  const saved = listMortar().find((item) => item.batchNo === batchNo)
  return saved ? { ok: true, data: saved } : { ok: false, reason: '写库后复查未找到该批次' }
}
