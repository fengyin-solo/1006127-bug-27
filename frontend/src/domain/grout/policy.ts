import type { GroutStatus, RepairVerdict } from './types'

/**
 * 补浆业务规则常量。
 *
 * 超量谁说了算（规则拍板）：
 * - 补入后总量不得超过「设计注浆量 × (1 + 超量系数)」，本平台取 5% 作为工程允许上限；
 * - 5% 以内判为「补足」，系统直接放行；
 * - 确需超过 5% 的，必须填写超量说明（批准人+原因），结论记为「超量补入」才允许落库；
 * - 没有设计注浆量的历史记录无法核算，豁免超量判定，按「补足」处理且不卡单。
 */
export const EXCESS_RATIO = 0.05

/** 取数默认重试次数（首发 + 重试）。传感器抖动重试可恢复，设备离线则快速失败。 */
export const FETCH_MAX_ATTEMPTS = 3

/** 单次取数重试间隔，仅页面上的异步批量任务用到。 */
export const FETCH_RETRY_DELAY_MS = 300

/** 注浆状态允许的正向流转，越级动作当场拦下。 */
export const GROUT_FLOW: Record<GroutStatus, GroutStatus[]> = {
  待注浆: ['注浆中'],
  注浆中: ['已完成'],
  已完成: ['已补浆'],
  已补浆: [],
}

/** 各动作的起始状态，越出这份映射的操作一律拒绝。 */
export const GROUT_ACTION_FROM: Record<string, GroutStatus> = {
  开始注浆: '待注浆',
  确认完成: '注浆中',
  安排补浆: '已完成',
}

export const REPAIR_VERDICTS: RepairVerdict[] = ['补足', '超量补入']

/** 现场记录常用「YYYY-MM-DD HH:mm」；input[datetime-local] 需要「YYYY-MM-DDTHH:mm」。 */
export function toDateTimeInput(value: string): string {
  return value ? value.replace(' ', 'T').slice(0, 16) : ''
}

/** 展示时把 T 换回空格，与现场纸面记录格式一致。 */
export function toDisplayTime(value: string): string {
  return value ? value.replace('T', ' ') : ''
}

/**
 * 计算补浆上限：超过设计量 5% 的部分必须走超量确认。
 * 历史记录没有设计量时返回 null，表示无法核算、豁免。
 */
export function repairCeiling(designAmount: number | null): number | null {
  if (designAmount === null || Number.isNaN(designAmount)) {
    return null
  }
  return Number((designAmount * (1 + EXCESS_RATIO)).toFixed(3))
}

/** 按规则判定补浆结论；超量时必须有说明。返回 null 表示按规则不允许这样补。 */
export function judgeRepair(
  designAmount: number | null,
  groutAmount: number,
  repairAmount: number,
): { verdict: RepairVerdict; allowed: boolean; ceiling: number | null; shortfall: number } {
  const shortfall =
    designAmount === null ? Number.NaN : Number(Math.max(0, designAmount - groutAmount).toFixed(3))
  const ceiling = repairCeiling(designAmount)
  if (ceiling === null) {
    // 历史记录无设计量：不做超量核算。
    return { verdict: '补足', allowed: true, ceiling: null, shortfall }
  }
  const totalAfter = groutAmount + repairAmount
  if (totalAfter <= ceiling + 1e-9) {
    return { verdict: '补足', allowed: true, ceiling, shortfall }
  }
  // 超 5%：只有带着超量说明（由登记入口保证）才允许，结论记超量补入。
  return { verdict: '超量补入', allowed: false, ceiling, shortfall }
}
