import { FETCH_MAX_ATTEMPTS } from './policy'
import type { DeviceReading, FetchOutcome } from './types'

/**
 * 现场取数网关：模拟从注浆记录仪/传感器拉读数。
 * 铁律：取不到就按失败处理并返回明确原因，调用方不得拿上一轮读数顶替。
 *
 * 故障注入（联调/演示用）：
 * - offline：设备断线，重试也恢复不了，快速失败；
 * - flaky：传感器瞬时抖动，首发失败、再试即成功，用来证明重试链路；
 * - corrupt：返回的报文缺字段，按失败处理，不允许当作有效读数。
 */
export type FetchFault = 'none' | 'offline' | 'flaky' | 'corrupt'

type FaultState = { mode: FetchFault; attemptsSeen: Map<string, number> }

const fault: FaultState = { mode: 'none', attemptsSeen: new Map() }

export function setFetchFault(mode: FetchFault): void {
  fault.mode = mode
  fault.attemptsSeen.clear()
}

export function getFetchFault(): FetchFault {
  return fault.mode
}

/**
 * 中断钩子：每完成 hook.before 次成功取数后，把下一次取数打成指定故障。
 * 用来确定性地模拟「批量登记跑到中途断线」，恢复后再从断点继续。
 */
const interruption: { after: number; successes: number; then: FetchFault } = {
  after: Number.POSITIVE_INFINITY,
  successes: 0,
  then: 'offline',
}

export function armInterruption(after: number, then: FetchFault = 'offline'): void {
  interruption.after = after
  interruption.successes = 0
  interruption.then = then
}

export function clearInterruption(): void {
  interruption.after = Number.POSITIVE_INFINITY
  interruption.successes = 0
}

/** 设备侧的真实读数表（真值）。页面登记前必须取到它，而不是沿用缓存。 */
const DEVICE_TABLE: Record<string, DeviceReading> = {
  'GROU-2026-0106': {
    groutNo: 'GROU-2026-0106',
    ringNo: 'R0106',
    groutAmount: 5.38,
    pressure: 0.29,
    initialSetTime: '2026-10-06 10:15',
    designAmount: 5.4,
    fetchedAt: '2026-10-06 10:16',
  },
  'GROU-2026-0109': {
    groutNo: 'GROU-2026-0109',
    ringNo: 'R0109',
    groutAmount: 5.35,
    pressure: 0.28,
    initialSetTime: '2026-10-06 11:02',
    designAmount: 5.4,
    fetchedAt: '2026-10-06 11:03',
  },
  'GROU-2026-0110': {
    groutNo: 'GROU-2026-0110',
    ringNo: 'R0110',
    groutAmount: 4.71,
    pressure: 0.25,
    initialSetTime: '2026-10-06 11:48',
    designAmount: 5.4,
    fetchedAt: '2026-10-06 11:49',
  },
  'GROU-2026-0111': {
    groutNo: 'GROU-2026-0111',
    ringNo: 'R0111',
    groutAmount: 5.4,
    pressure: 0.3,
    initialSetTime: '2026-10-06 12:36',
    designAmount: 5.4,
    fetchedAt: '2026-10-06 12:37',
  },
  // 复查用：与 R0103 登记压力 0.27 故意不一致，现场真值为 0.31。
  'GROU-2026-0103': {
    groutNo: 'GROU-2026-0103',
    ringNo: 'R0103',
    groutAmount: 5.36,
    pressure: 0.31,
    initialSetTime: '2026-09-21 02:35',
    designAmount: 5.4,
    fetchedAt: '2026-10-06 12:40',
  },
}

function attemptOnce(groutNo: string): DeviceReading {
  const seen = fault.attemptsSeen.get(groutNo) ?? 0
  fault.attemptsSeen.set(groutNo, seen + 1)

  // 命中中断点：把本次取数打成离线/抖动，模拟跑到中途断线。
  const atInterruption =
    seen === 0 && interruption.successes >= interruption.after && interruption.then !== 'none'

  if (fault.mode === 'offline' || atInterruption) {
    if (atInterruption) fault.mode = interruption.then
    throw new FetchError('设备离线：注浆记录仪无响应', false)
  }
  if (fault.mode === 'flaky' && seen === 0) {
    throw new FetchError('传感器瞬时抖动：读数报文超时', true)
  }

  const row = DEVICE_TABLE[groutNo]
  if (!row) {
    throw new FetchError(`设备侧查无编号 ${groutNo} 的本轮读数`, false)
  }
  if (fault.mode === 'corrupt') {
    throw new FetchError('读数报文损坏：注浆压力字段缺失', true)
  }
  if (
    typeof row.groutAmount !== 'number' ||
    typeof row.pressure !== 'number' ||
    !row.initialSetTime
  ) {
    throw new FetchError('读数报文不完整：关键字段缺失', true)
  }
  interruption.successes += 1
  return { ...row, fetchedAt: new Date().toISOString() }
}

class FetchError extends Error {
  retriable: boolean
  constructor(message: string, retriable: boolean) {
    super(message)
    this.name = 'FetchError'
    this.retriable = retriable
  }
}

export type FetchOptions = { maxAttempts?: number; sleep?: (ms: number) => Promise<void> | void }

/**
 * 取数：失败重试，重试仍失败写清原因。
 * 任何一次失败都不返回旧值；offline 这类不可恢复错误直接快速失败。
 */
export async function fetchReading(
  groutNo: string,
  options: FetchOptions = {},
): Promise<FetchOutcome> {
  const maxAttempts = options.maxAttempts ?? FETCH_MAX_ATTEMPTS
  const sleep = options.sleep ?? (() => undefined)
  let lastReason = '取数失败'
  let retriable = false

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const reading = attemptOnce(groutNo)
      return { ok: true, reading, attempts: attempt }
    } catch (error) {
      if (error instanceof FetchError) {
        lastReason = error.message
        retriable = error.retriable
        if (!error.retriable) {
          return { ok: false, reason: `${error.message}（不可重试，已停止）`, attempts: attempt, retriable: false }
        }
      } else {
        lastReason = '取数链路异常：未知错误'
        retriable = true
      }
      if (attempt < maxAttempts) {
        await sleep(120 * attempt)
      }
    }
  }
  return {
    ok: false,
    reason: `重试 ${maxAttempts} 次仍失败：${lastReason}`,
    attempts: maxAttempts,
    retriable,
  }
}

/** 已知设备侧有哪些编号（批量登记排队校验用）。 */
export function knownDeviceNumbers(): string[] {
  return Object.keys(DEVICE_TABLE)
}
