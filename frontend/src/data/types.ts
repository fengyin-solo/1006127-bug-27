/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  /** 动作允许的起始状态：缺省时按状态链取目标状态的前一格；分支动作（如退回）要显式登记。 */
  actionSources?: Record<string, string[]>
  /** 终态：落到这些状态就不算待处理；缺省取状态链最后一格。 */
  terminalStatuses?: string[]
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 补浆登记的一笔输入：补浆量与初凝时间必须同进同出，落在同一条记录里。 */
export type RegroutInput = {
  注浆编号: string
  补浆量: string
  注浆压力: string
  初凝时间: string
  补浆班组: string
}

/** 批量登记时每一笔的结果：成功、重复跳过、失败（带原因），中断后按它从断掉的那条接着走。 */
export type RegroutItemResult = {
  input: RegroutInput
  ok: boolean
  duplicated: boolean
  message: string
}

export type RegroutBatchResult = {
  results: RegroutItemResult[]
  registered: number
  duplicated: number
  failed: number
}

/** 待补浆批次对账项：补浆记录与浆液拌制待用批次一一对应，两侧页面都从这一份取。 */
export type PendingRegroutBatch = {
  补浆编号: string
  注浆编号: string
  对应环号: string
  补浆量: string
  初凝时间: string
  批次编号: string
  批次状态: string
}
