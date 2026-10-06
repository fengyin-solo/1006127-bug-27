/**
 * 同步注浆 / 补浆领域类型。
 * 注浆页与浆液拌制页共用这一份模型，页面之间不再各存一份行数据。
 */

/** 注浆主流程状态：未走完「注浆确认」前不得安排补浆。 */
export type GroutStatus = '待注浆' | '注浆中' | '已完成' | '已补浆'

/** 补浆结论：写入所使用的浆液批次上，并决定批次在「待用清单」里的去留。 */
export type RepairVerdict = '补足' | '超量补入'

/** 一次补浆登记：补浆量与初凝时间必须落在同一份里，缺一项整笔退回。 */
export type RepairRecord = {
  /** 批次编号，引用浆液拌制里的待用批次。 */
  batchNo: string
  /** 补浆量（m³）。 */
  amount: number
  /** 补浆压力（MPa），取数链路带回的现场读数，登记时一并落库。 */
  pressure: number
  /** 补浆初凝时间（与补浆量同一份记录）。 */
  initialSetTime: string
  verdict: RepairVerdict
  /** 超量补入时必填的说明（谁批准、为什么超）。 */
  excessNote?: string
  operator: string
  registeredAt: string
}

/**
 * 一条注浆记录（含可能存在的补浆登记）。
 * confirmed 表示「注浆确认」是否完成；没有它，补浆动作当场拦下。
 */
export type GroutRecord = {
  /** 入库主键：存量迁移后按对应环次重排，保持稳定。 */
  id: number
  groutNo: string
  ringNo: string
  mixRatio: string
  /** 本轮实际注浆量（m³）。 */
  groutAmount: number
  pressure: number
  initialSetTime: string
  crew: string
  /** 设计注浆量（m³）；历史老记录可能没有，取数/超量校验对其豁免。 */
  designAmount: number | null
  status: GroutStatus
  confirmed: boolean
  /** 落库后复查的现场读数是否与登记一致；未复查为 null。 */
  verified: boolean | null
  /** 最近一次失败原因（取数失败、写库失败、复查不一致等），成功后清空。 */
  lastError?: string
  /** 历史迁移记录标记：没有设计量、字段来源参差时为 true，超量判定豁免。 */
  legacy?: boolean
  repair?: RepairRecord
}

/** 浆液拌制批次。结论回写到本结构，两页通过同一存储读取。 */
export type MortarBatch = {
  id: number
  batchNo: string
  mortarType: string
  cementKg: number
  bentoniteKg: number
  waterCementRatio: number
  consistency: number
  mixedAt: string
  /** 检验合格即进入「待用」；被补浆结论引用后转为已使用。 */
  status: '待拌制' | '拌制中' | '检验合格' | '已使用' | '已废弃'
  /** 该批次服务的补浆结论；待用批次清单只看结论为空的合格批次。 */
  reservedFor?: {
    groutNo: string
    ringNo: string
    repairAmount: number
    verdict: RepairVerdict
    at: string
  }
}

/** 现场取数网关返回的读数。 */
export type DeviceReading = {
  groutNo: string
  ringNo: string
  groutAmount: number
  pressure: number
  initialSetTime: string
  designAmount: number | null
  fetchedAt: string
}

/** 取数失败时必须带明确原因，绝不允许用旧读数顶替。 */
export type FetchOutcome =
  | { ok: true; reading: DeviceReading; attempts: number }
  | { ok: false; reason: string; attempts: number; retriable: boolean }

/** 登记/流转结果：失败必须写清原因，成功可附带提示（如幂等命中）。 */
export type RegisterResult<T = undefined> =
  | { ok: true; data: T; notice?: string }
  | { ok: false; reason: string }

/** 批量登记（中途可断线）的游标：已登记的不重来，只从断掉那一条接着走。 */
export type BatchCursor = {
  jobId: string
  /** 排队中的注浆编号（尚未取数登记）。 */
  queue: string[]
  /** 本轮已成功登记的注浆编号，断线恢复后直接跳过。 */
  done: string[]
  /** 取数/写库失败而停住的编号及原因。 */
  failed?: { groutNo: string; reason: string }
  startedAt: string
  updatedAt: string
}

/** 领域存储整体快照：一个 key 原子落库，避免半条写入。 */
export type GroutStore = {
  version: number
  grouting: GroutRecord[]
  mortar: MortarBatch[]
  cursor: BatchCursor | null
}
