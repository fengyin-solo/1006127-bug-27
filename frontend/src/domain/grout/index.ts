/** 补浆领域统一出口：页面与通用服务只从这里取能力，避免各写一份取数/登记逻辑。 */
export * from './types'
export {
  EXCESS_RATIO,
  FETCH_MAX_ATTEMPTS,
  FETCH_RETRY_DELAY_MS,
  GROUT_FLOW,
  GROUT_ACTION_FROM,
  REPAIR_VERDICTS,
  repairCeiling,
  judgeRepair,
  toDateTimeInput,
  toDisplayTime,
} from './policy'
export {
  getStore,
  resetStore,
  listGrouting,
  listMortar,
  getCursor,
  setWriteFault,
  getWriteFault,
} from './repository'
export {
  setFetchFault,
  getFetchFault,
  fetchReading,
  knownDeviceNumbers,
  armInterruption,
  clearInterruption,
} from './device-gateway'
export type { FetchFault } from './device-gateway'
export {
  validateDraft,
  registerGrouting,
  draftFromReading,
  transition,
  pendingBatches,
  pendingRepairRecords,
  arrangeRepair,
  recheckRecord,
  startBatchJob,
  advanceBatchJob,
  resumeBatchJob,
  discardBatchJob,
  transitionMortar,
} from './service'
export type { GroutDraft, RepairDraft, BatchProgress } from './service'
export {
  groutRows,
  mortarRows,
  groutToRow,
  mortarToRow,
  groutOverview,
} from './projection'
export type { GroutOverview } from './projection'
