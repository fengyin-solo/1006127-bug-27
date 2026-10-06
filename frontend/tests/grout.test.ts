// 补浆领域测试：通过 tests/ts-hooks.mjs 让 Node 直接运行本 TS 文件。
// 运行：node --import ./tests/register-hooks.mjs tests/grout.test.ts
import assert from 'node:assert/strict'

import { installStorage } from './storage-shim.ts'
import {
  resetStore,
  listGrouting,
  listMortar,
  registerGrouting,
  transition,
  arrangeRepair,
  recheckRecord,
  startBatchJob,
  advanceBatchJob,
  resumeBatchJob,
  discardBatchJob,
  pendingBatches,
  pendingRepairRecords,
  groutRows,
  mortarRows,
  groutOverview,
  setFetchFault,
  setWriteFault,
  armInterruption,
  clearInterruption,
  fetchReading,
  knownDeviceNumbers,
} from '@/domain/grout'

// 必须先装好 localStorage 垫片，再触发领域初始化。
const storage = installStorage()
const legacyKey = 'shield-tunnel-construction:entries'

// 构造存量老数据：同一注浆编号重复两条、含占位样例、一条历史记录。
storage.setItem(
  legacyKey,
  JSON.stringify({
    grouting: [
      {
        id: 1,
        status: '注浆中',
        注浆编号: 'GROU-OLD-1',
        对应环号: 'R0002',
        浆液配比: '同步注浆样例1',
        注浆量: '同步注浆样例1',
        注浆压力: '同步注浆样例1',
        初凝时间: '2026-09-01',
        注浆班组: '同步注浆样例1',
        注浆状态: '同步注浆样例1',
      },
      {
        id: 2,
        status: '已完成',
        注浆编号: 'GROU-OLD-1',
        对应环号: 'R0002',
        浆液配比: '120:60:800:420',
        注浆量: '5.1',
        注浆压力: '0.26',
        初凝时间: '2026-09-01 10:00',
        注浆班组: '注浆二班',
        注浆状态: '已完成',
      },
      {
        id: 3,
        status: '待注浆',
        注浆编号: 'GROU-OLD-2',
        对应环号: 'R0001',
        浆液配比: '同步注浆样例3',
        注浆量: '同步注浆样例3',
        注浆压力: '同步注浆样例3',
        初凝时间: '2026-09-03',
        注浆班组: '同步注浆样例3',
        注浆状态: '同步注浆样例3',
      },
    ],
    mortar: [
      {
        id: 1,
        status: '检验合格',
        批次编号: 'MORT-OLD-1',
        水泥用量: '120',
        膨润土用量: '60',
        水灰比: '3.5',
        稠度: '95',
        拌制日期: '2026-09-01',
        批次状态: '检验合格',
      },
    ],
    ring: [{ id: 1, status: '待掘进', 环号: 'RING-1' }],
  }),
)

// 触发首次迁移。
resetStore()

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

// 1. 存量迁移：去重 + 按环次重排入库 + 历史标记。
await test('存量记录按环次重新入库，同一注浆编号重复只留一条', () => {
  const rows = listGrouting()
  const old1 = rows.filter((r) => r.groutNo === 'GROU-OLD-1')
  assert.equal(old1.length, 1, 'GROU-OLD-1 重复两条必须去成一条')
  assert.equal(old1[0].status, '已完成', '冲突时已确认记录优先')
  const old2 = rows.find((r) => r.groutNo === 'GROU-OLD-2')
  assert.ok(old2.id < old1[0].id, '按对应环次升序重排主键')
  assert.equal(old1[0].legacy, true, '存量记录标记为历史记录')
  assert.equal(old1[0].designAmount, null, '历史记录无设计量')
  const legacy = JSON.parse(storage.dump()[legacyKey])
  assert.equal(legacy['grouting'], undefined, '旧通用表里的 grouting 已迁出')
  assert.equal(legacy['mortar'], undefined, '旧通用表里的 mortar 已迁出')
  assert.ok(Array.isArray(legacy['ring']), '其他模块原样保留')
  assert.ok(listMortar().some((b) => b.batchNo === 'MORT-OLD-1'))
})

// 2. 取数：失败不顶替、重试、原因写清。
await test('设备离线时取数失败并写清原因，绝不返回旧读数', async () => {
  setFetchFault('offline')
  const outcome = await fetchReading('GROU-2026-0106')
  assert.equal(outcome.ok, false)
  if (!outcome.ok) {
    assert.match(outcome.reason, /离线/, '失败原因必须写清')
    assert.equal(outcome.attempts, 1, '不可恢复错误快速失败')
  }
  setFetchFault('none')
})

await test('传感器抖动时重试取数成功，不沿用旧值', async () => {
  setFetchFault('flaky')
  const outcome = await fetchReading('GROU-2026-0106')
  assert.equal(outcome.ok, true)
  if (outcome.ok) {
    assert.equal(outcome.attempts, 2, '首发失败、第二次成功')
    assert.equal(outcome.reading.pressure, 0.29)
  }
  setFetchFault('none')
})

// 3. 落库前校验。
await test('缺初凝时间或量非法，登记整笔退回且不留半条', () => {
  const bad = registerGrouting({
    groutNo: 'GROU-NEW-X',
    ringNo: 'R9001',
    mixRatio: 'm',
    groutAmount: 5,
    pressure: 0.3,
    initialSetTime: '',
    crew: 'c',
    designAmount: 5.4,
  })
  assert.equal(bad.ok, false)
  assert.ok(!listGrouting().some((r) => r.groutNo === 'GROU-NEW-X'))
})

// 4. 幂等 + 冲突仲裁。
await test('同一条重复递两次只记一次（幂等）', () => {
  setFetchFault('none')
  const draft = {
    groutNo: 'GROU-2026-0106',
    ringNo: 'R0106',
    mixRatio: 'm',
    groutAmount: 5.38,
    pressure: 0.29,
    initialSetTime: '2026-10-06 10:15',
    crew: '注浆一班',
    designAmount: 5.4,
  }
  const first = registerGrouting(draft)
  assert.equal(first.ok, true)
  const again = registerGrouting(draft)
  assert.equal(again.ok, true)
  if (again.ok) assert.equal(again.data.duplicated, true)
  assert.equal(listGrouting().filter((r) => r.groutNo === draft.groutNo).length, 1)
})

await test('已确认记录与新读数冲突时拒绝，现场确认值为准', () => {
  const clashing = registerGrouting({
    groutNo: 'GROU-2026-0101',
    ringNo: 'R0101',
    mixRatio: 'm',
    groutAmount: 9.99,
    pressure: 0.99,
    initialSetTime: '2026-09-20 08:40',
    crew: '注浆一班',
    designAmount: 5.4,
  })
  assert.equal(clashing.ok, false)
  const after = listGrouting().find((r) => r.groutNo === 'GROU-2026-0101')
  assert.equal(after.groutAmount, 5.42, '已确认值不被覆盖')
})

// 5. 越级拦截。
await test('未走完注浆确认不得安排补浆；越级状态动作当场拦下', () => {
  const blocked = arrangeRepair(
    { groutNo: 'GROU-2026-0104', batchNo: 'MORT-2026-0902', amount: 0.2, pressure: 0.27, initialSetTime: '2026-10-06 13:00' },
    '值班管理员',
  )
  assert.equal(blocked.ok, false)
  assert.match(blocked.reason, /注浆确认/)

  const jump = transition('GROU-2026-0106', '确认完成')
  assert.equal(jump.ok, false)
  assert.match(jump.reason, /越级/)
})

// 6. 补浆原子登记：两侧同源、批次数一致、结论回写。
await test('补浆登记两侧同落，待用批次数两侧一致，结论写入批次', () => {
  const before = pendingBatches().length
  assert.equal(before, groutOverview().pendingBatchCount)

  const result = arrangeRepair(
    {
      groutNo: 'GROU-2026-0105',
      batchNo: 'MORT-2026-0902',
      amount: 0.78,
      pressure: 0.27,
      initialSetTime: '2026-10-06 14:10',
    },
    '值班管理员',
  )
  assert.equal(result.ok, true, result.reason ?? '')
  const rec = listGrouting().find((r) => r.groutNo === 'GROU-2026-0105')
  assert.equal(rec.status, '已补浆')
  assert.equal(rec.repair.amount, 0.78)
  assert.equal(rec.repair.initialSetTime, '2026-10-06 14:10', '补浆量与初凝时间同一份')
  assert.equal(rec.repair.verdict, '补足')
  const batch = listMortar().find((b) => b.batchNo === 'MORT-2026-0902')
  assert.equal(batch.status, '已使用')
  assert.equal(batch.reservedFor.groutNo, 'GROU-2026-0105')
  assert.equal(groutOverview().pendingBatchCount, pendingBatches().length)
  assert.equal(pendingBatches().length, before - 1)
})

// 7. 超量规则。
await test('超量拍板：5% 内放行；超出须批准说明，否则整笔退回', () => {
  const tooMuch = arrangeRepair(
    { groutNo: 'GROU-2026-0108', batchNo: 'MORT-2026-0903', amount: 0.5, pressure: 0.3, initialSetTime: '2026-10-06 15:00' },
    '值班管理员',
  )
  assert.equal(tooMuch.ok, false)
  assert.match(tooMuch.reason, /5%|上限/)
  assert.equal(
    listMortar().find((b) => b.batchNo === 'MORT-2026-0903').status,
    '检验合格',
    '退回后批次仍待用',
  )

  const approved = arrangeRepair(
    {
      groutNo: 'GROU-2026-0108',
      batchNo: 'MORT-2026-0903',
      amount: 0.5,
      pressure: 0.3,
      initialSetTime: '2026-10-06 15:05',
      excessNote: '项目经理王某批准：管片间隙偏大需回填',
    },
    '值班管理员',
  )
  assert.equal(approved.ok, true, approved.reason ?? '')
  const rec = listGrouting().find((r) => r.groutNo === 'GROU-2026-0108')
  assert.equal(rec.repair.verdict, '超量补入')
  assert.match(rec.repair.excessNote ?? '', /项目经理/)
})

await test('历史无设计量记录豁免超量判定，兼容老注浆记录', () => {
  const result = arrangeRepair(
    { groutNo: 'GROU-2026-0102', batchNo: 'MORT-2026-0904', amount: 0.6, pressure: 0.27, initialSetTime: '2026-10-06 15:30' },
    '值班管理员',
  )
  assert.equal(result.ok, true, result.reason ?? '')
  assert.equal(listGrouting().find((r) => r.groutNo === 'GROU-2026-0102').repair.verdict, '补足')
})

// 8. 写库失败就地撤销。
await test('写库失败时整笔撤销（注浆侧与批次侧都不动），故障解除后可重提', () => {
  setWriteFault('always')
  const result = arrangeRepair(
    { groutNo: 'GROU-2026-0103', batchNo: 'MORT-OLD-1', amount: 0.1, pressure: 0.31, initialSetTime: '2026-10-06 16:00' },
    '值班管理员',
  )
  assert.equal(result.ok, false)
  setWriteFault('none')
  const rec = listGrouting().find((r) => r.groutNo === 'GROU-2026-0103')
  assert.equal(rec.repair, undefined, '注浆侧没留半条')
  assert.equal(
    listMortar().find((b) => b.batchNo === 'MORT-OLD-1').status,
    '检验合格',
    '批次侧没被占用',
  )
  const retry = arrangeRepair(
    { groutNo: 'GROU-2026-0103', batchNo: 'MORT-OLD-1', amount: 0.1, pressure: 0.31, initialSetTime: '2026-10-06 16:05' },
    '值班管理员',
  )
  assert.equal(retry.ok, true, retry.reason ?? '')
})

// 9. 落库后复查。
await test('提交后复查：压力对不上时标记不一致，不覆盖登记值、不沿用旧值', async () => {
  const result = await recheckRecord('GROU-2026-0103')
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.data.consistent, false)
  const rec = listGrouting().find((r) => r.groutNo === 'GROU-2026-0103')
  assert.equal(rec.verified, false)
  assert.match(rec.lastError ?? '', /注浆压力/)
  assert.equal(rec.pressure, 0.27, '登记值不被复查覆盖')
})

// 10. 批量断线续传。
await test('批量任务中途断线：已登记保留，从断掉那一条接着走', async () => {
  setFetchFault('none')
  // 第 1 条取数成功后，第 2 条取数时设备离线，确定性模拟中途断线。
  armInterruption(1, 'offline')
  const queued = ['GROU-2026-0109', 'GROU-2026-0110', 'GROU-2026-0111']
  const started = startBatchJob(queued)
  assert.equal(started.ok, true, started.reason ?? '')

  const stopped = await advanceBatchJob('注浆一班')
  assert.equal(stopped.stopped, true)
  assert.ok(stopped.cursor.done.includes('GROU-2026-0109'), '已登记的在 done 里')
  assert.equal(stopped.cursor.failed.groutNo, 'GROU-2026-0110', '停在断线那一条')
  assert.ok(listGrouting().some((r) => r.groutNo === 'GROU-2026-0109'), '已登记记录落库')
  assert.ok(!listGrouting().some((r) => r.groutNo === 'GROU-2026-0110'), '断线后未登记的不残留')

  // 恢复网络：从 0110 继续，0109 不重来。
  clearInterruption()
  setFetchFault('none')
  const done = await resumeBatchJob('注浆一班')
  assert.equal(done.cursor, null, '队列清空')
  for (const no of queued) {
    assert.ok(listGrouting().some((r) => r.groutNo === no), `${no} 已登记`)
  }
  assert.equal(listGrouting().filter((r) => r.groutNo === 'GROU-2026-0109').length, 1, '已登记的不重复')
})

await test('批量任务输入去重、已确认编号不得批量覆盖', () => {
  const dup = startBatchJob(['GROU-2026-0110', 'GROU-2026-0110'])
  assert.equal(dup.ok, false)
  const confirmed = startBatchJob(['GROU-2026-0101'])
  assert.equal(confirmed.ok, false)
  const idle = discardBatchJob()
  assert.equal(idle.ok, false)
})

// 11. 行列同源。
await test('注浆页/浆液页通过同一投影取行，待补浆批次数两侧一致', () => {
  assert.equal(groutRows().length, listGrouting().length)
  assert.equal(mortarRows().length, listMortar().length)
  const overview = groutOverview()
  assert.equal(overview.pendingBatchCount, pendingBatches().length)
  const pending = pendingRepairRecords().map((r) => r.groutNo)
  assert.ok(!pending.includes('GROU-2026-0105'))
  assert.ok(overview.repairDoneCount >= 5)
})

await test('设备读数表暴露的编号可用于批量排队', () => {
  assert.ok(knownDeviceNumbers().includes('GROU-2026-0111'))
})

console.log(`\n${passed} 项领域测试全部通过`)
