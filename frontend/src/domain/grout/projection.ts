import { listGrouting, listMortar } from './repository'
import { pendingBatches, pendingRepairRecords } from './service'
import type { EntryRow } from '@/data/types'
import type { GroutRecord, MortarBatch } from './types'

/**
 * 领域数据 → 通用行结构的唯一投影出口。
 * 注浆页、浆液拌制页、看板/导出等其他页面都从这里取行，保证行列同源、不分两份。
 */

export function groutToRow(record: GroutRecord): EntryRow {
  return {
    id: record.id,
    status: record.status,
    pending: !record.confirmed || (!record.repair && record.status === '已完成'),
    abnormal: record.verified === false || Boolean(record.lastError),
    注浆编号: record.groutNo,
    对应环号: record.ringNo,
    浆液配比: record.mixRatio,
    注浆量: record.groutAmount,
    注浆压力: record.pressure,
    初凝时间: record.initialSetTime || '—',
    注浆班组: record.crew,
    注浆状态: record.legacy && record.designAmount === null ? `${record.status}（历史）` : record.status,
  }
}

export function mortarToRow(batch: MortarBatch): EntryRow {
  return {
    id: batch.id,
    status: batch.status,
    pending: batch.status === '检验合格' && !batch.reservedFor,
    abnormal: batch.status === '已废弃',
    批次编号: batch.batchNo,
    浆液类型: batch.mortarType,
    水泥用量: batch.cementKg,
    膨润土用量: batch.bentoniteKg,
    水灰比: batch.waterCementRatio,
    稠度: batch.consistency,
    拌制日期: batch.mixedAt,
    批次状态: batch.reservedFor
      ? `已使用 → ${batch.reservedFor.groutNo}（${batch.reservedFor.verdict} ${batch.reservedFor.repairAmount}m³）`
      : batch.status,
  }
}

export function groutRows(): EntryRow[] {
  return listGrouting().map(groutToRow)
}

export function mortarRows(): EntryRow[] {
  return listMortar().map(mortarToRow)
}

export type GroutOverview = {
  totalAmount: number
  averagePressure: number
  pendingRepairCount: number
  pendingBatchCount: number
  repairDoneCount: number
}

/** 两页共用的待补浆批次数：两侧永远取同一个函数，数量必须对得上。 */
export function groutOverview(): GroutOverview {
  const records = listGrouting()
  const withAmount = records.filter((row) => row.groutAmount > 0)
  const totalAmount = Number(records.reduce((sum, row) => sum + row.groutAmount, 0).toFixed(2))
  const averagePressure =
    withAmount.length === 0
      ? 0
      : Number((withAmount.reduce((sum, row) => sum + row.pressure, 0) / withAmount.length).toFixed(2))
  return {
    totalAmount,
    averagePressure,
    pendingRepairCount: pendingRepairRecords().length,
    pendingBatchCount: pendingBatches().length,
    repairDoneCount: records.filter((row) => Boolean(row.repair)).length,
  }
}
