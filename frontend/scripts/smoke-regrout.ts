// 冒烟测试：在 node 里跑通补浆取数与登记的关键链路。
// 运行方式见 scripts/run-smoke.mjs（esbuild 打包 @ 别名后执行）。
import assert from 'node:assert/strict'

import {
  listEligibleGrouting,
  listEntries,
  listPendingRegroutBatches,
  listRegroutEntries,
  moduleStats,
  registerRegrout,
  registerRegroutBatch,
  runAction,
} from '@/api/local-service'
import { listRows, saveRows, storageKey } from '@/data/local-store'
import type { RegroutInput } from '@/data/types'

const storage = new Map<string, string>()

function installWindow(raw?: string) {
  const backing = raw === undefined ? storage : new Map([[storageKey(), raw]])
  ;(globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (key: string) => (backing.has(key) ? backing.get(key)! : null),
      setItem: (key: string, value: string) => {
        backing.set(key, value)
      },
      removeItem: (key: string) => {
        backing.delete(key)
      },
    },
  }
}

function input(code: string, volume = '1.2'): RegroutInput {
  return { 注浆编号: code, 补浆量: volume, 注浆压力: '0.3', 初凝时间: '2026-10-06', 补浆班组: '注浆二班' }
}

// —— 1. 损坏存根：按失败处理，不拿旧读数顶替，也不覆盖现场数据 ——
installWindow('{broken json')
assert.throws(() => listRows('grouting'), /读取失败|重试 2 次仍失败/)
assert.equal((globalThis as { window: { localStorage: { getItem: (k: string) => string | null } } })
  .window.localStorage.getItem(storageKey()), '{broken json', '损坏数据不能被示例数据覆盖')
console.log('ok 1 损坏存根按失败处理且不顶替不覆盖')

// —— 2. 首次播种 + 存量按环次重新入库（去重、校正环号）——
installWindow()
const regrout = listRegroutEntries()
assert.equal(regrout.total, 2, '同一注浆编号的重复存量只留一条')
const regr1 = regrout.items.find((row) => row['补浆编号'] === 'REGR-0001')!
assert.equal(regr1['对应环号'], '第103环', '对应环号以源注浆记录为准重新入库')
console.log('ok 2 存量记录去重并按对应环次重新入库')

// —— 3. 两侧待补浆批次数对得上 ——
const pending = listPendingRegroutBatches()
assert.equal(pending.length, 1)
assert.equal(pending[0]['批次编号'], 'MORT-R0003')
assert.equal(pending[0]['对应环号'], '第103环')
const regroutStat = moduleStats('regrout').find((s) => s.label === '待补浆批次')!.value
const groutingStat = moduleStats('grouting').find((s) => s.label === '待补浆记录')!.value
assert.equal(regroutStat, 1)
assert.equal(groutingStat, 1)
console.log('ok 3 补浆侧与浆液拌制侧待补浆批次数一致')

// —— 4. 没走完注浆确认不许安排补浆，越级当场拦下 ——
const blocked = registerRegrout(input('GROU-0001'))
assert.equal(blocked.ok, false)
assert.match(blocked.message, /没走完注浆确认/)
const jumped = runAction('grouting', 1, '安排补浆')
assert.equal(jumped.ok, false)
assert.match(jumped.message, /不能执行/)
assert.equal(listRows('grouting')[0].status, '待注浆', '越级被拦后状态不变')
console.log('ok 4 未确认完成的注浆记录不能安排补浆')

// —— 5. 走完流程后登记：补浆量与初凝时间落在同一条里，三方同事务 ——
assert.equal(runAction('grouting', 1, '开始注浆').ok, true)
assert.equal(runAction('grouting', 1, '确认完成').ok, true)
const done = registerRegrout(input('GROU-0001', '1.5'))
assert.equal(done.ok, true, done.message)
const regrAfter = listRegroutEntries().items.find((row) => row['注浆编号'] === 'GROU-0001')!
assert.equal(regrAfter['补浆量'], '1.5')
assert.equal(regrAfter['初凝时间'], '2026-10-06')
assert.equal(regrAfter['对应环号'], '第101环')
assert.equal(listRows('grouting')[0].status, '已补浆')
const batch = listRows('mortar').find((row) => row['关联注浆编号'] === 'GROU-0001')!
assert.equal(batch.status, '待拌制')
assert.equal(listPendingRegroutBatches().length, 2, '登记后两侧待补浆批次同步增加')
console.log('ok 5 登记一笔落三处，补浆量与初凝时间同条')

// —— 6. 同一注浆编号重复提交只留一条，以已入库为准 ——
const dup = registerRegrout(input('GROU-0001', '9.9'))
assert.equal(dup.ok, false)
assert.equal(dup.duplicated, true)
assert.match(dup.message, /只留一条/)
const still = listRegroutEntries().items.find((row) => row['注浆编号'] === 'GROU-0001')!
assert.equal(still['补浆量'], '1.5', '重复提交不覆盖已入库记录')
console.log('ok 6 重复递两次只记一次，先写为准')

// —— 7. 批量登记：中断后从断掉的那条接着走，已登记的不再重来 ——
assert.equal(runAction('grouting', 2, '确认完成').ok, true) // GROU-0002: 注浆中 -> 已完成
const bad: RegroutInput = { 注浆编号: 'GROU-0002', 补浆量: '', 注浆压力: '0.3', 初凝时间: '2026-10-06', 补浆班组: '一班' }
const batchReport = registerRegroutBatch([input('GROU-0001'), bad, input('GROU-0002', '0.8')])
assert.equal(batchReport.registered, 1, '只有最后一笔新登记成功')
assert.equal(batchReport.duplicated, 1, '第一笔已登记过，自动跳过不再重来')
assert.equal(batchReport.failed, 1)
assert.match(batchReport.results[1].message, /补浆量/)
assert.match(batchReport.results[1].message, /不许拿旧读数顶替/)
const g2 = listRegroutEntries().items.find((row) => row['注浆编号'] === 'GROU-0002')!
assert.equal(g2['补浆量'], '0.8', '断掉的那条重填后接着入库')
console.log('ok 7 批量中断可续，失败原因写清，空读数不顶替')

// —— 8. 超量判定：有基准按 20% 判，历史非数字基准兼容不判 ——
assert.equal(g2.abnormal, false, '历史记录注浆量非数字时不判超量')
const groutingRows = listRows('grouting').map((row) =>
  row['注浆编号'] === 'GROU-0002' ? { ...row, 注浆量: '1.0' } : row,
)
saveRows('grouting', groutingRows)
// 给 GROU-0002 的补浆已被退回场景：直接再验一笔新编号走超量分支
saveRows('grouting', [
  ...listRows('grouting'),
  {
    id: 99,
    status: '已完成',
    pending: false,
    abnormal: false,
    注浆编号: 'GROU-0099',
    对应环号: '第199环',
    浆液配比: '1:1',
    注浆量: '1.0',
    注浆压力: '0.3',
    初凝时间: '2026-10-01',
    注浆班组: '一班',
    注浆状态: '已完成',
  },
])
const over = registerRegrout(input('GROU-0099', '1.3'))
assert.equal(over.ok, true)
assert.match(over.message, /超量/)
const overRow = listRegroutEntries().items.find((row) => row['注浆编号'] === 'GROU-0099')!
assert.equal(overRow.abnormal, true, '超量记录打异常标记')
console.log('ok 8 超量按基准 20% 判定并打标，历史记录兼容')

// —— 9. 写库失败就地撤销，不留半条 ——
saveRows('grouting', [
  ...listRows('grouting'),
  {
    id: 100,
    status: '已完成',
    pending: false,
    abnormal: false,
    注浆编号: 'GROU-0100',
    对应环号: '第200环',
    浆液配比: '1:1',
    注浆量: '2.0',
    注浆压力: '0.3',
    初凝时间: '2026-10-01',
    注浆班组: '一班',
    注浆状态: '已完成',
  },
])
const before = {
  grouting: listRows('grouting').length,
  regrout: listRows('regrout').length,
  mortar: listRows('mortar').length,
}
const localStorageRef = (globalThis as { window: { localStorage: { setItem: (k: string, v: string) => void } } })
  .window.localStorage
const originalSetItem = localStorageRef.setItem
localStorageRef.setItem = () => {
  throw new Error('QuotaExceededError')
}
const failedWrite = registerRegrout(input('GROU-0100', '0.5'))
assert.equal(failedWrite.ok, false)
assert.match(failedWrite.message, /写入失败|QuotaExceededError/)
localStorageRef.setItem = originalSetItem
// 缓存已就地撤销：重新取数后三个模块都不留半条
assert.equal(listRows('regrout').filter((row) => row['注浆编号'] === 'GROU-0100').length, 0, '补浆记录不留半条')
assert.equal(listRows('mortar').filter((row) => row['关联注浆编号'] === 'GROU-0100').length, 0, '待用批次不留半条')
assert.equal(listRows('grouting').find((row) => row['注浆编号'] === 'GROU-0100')!.status, '已完成', '源记录状态被回滚')
assert.equal(listRows('grouting').length, before.grouting)
assert.equal(listRows('regrout').length, before.regrout)
assert.equal(listRows('mortar').length, before.mortar)
console.log('ok 9 写库失败就地撤销，三个模块都不留半条')

// —— 10. 可登记清单与取数入口 ——
const eligible = listEligibleGrouting().map((row) => row['注浆编号'])
assert.ok(eligible.includes('GROU-0100'))
assert.ok(!eligible.includes('GROU-0001'), '已登记过补浆的不再出现在可登记清单')
assert.equal(listEntries('regrout').total, listRegroutEntries().total, '取数两处入口同源')
console.log('ok 10 取数与登记两处入口共用一份')

// —— 11. 补浆状态机：退回允许从待补浆发起，确认补浆不许越级 ——
const pendingRow = listRows('regrout').find((row) => row['注浆编号'] === 'GROU-0001')!
const jumpConfirm = runAction('regrout', Number(pendingRow.id), '确认补浆')
assert.equal(jumpConfirm.ok, false, '待补浆不能直接确认补浆')
assert.match(jumpConfirm.message, /不能执行/)
const returned = runAction('regrout', Number(pendingRow.id), '退回补浆')
assert.equal(returned.ok, true, '待补浆可以退回')
assert.equal(listRows('regrout').find((row) => row['注浆编号'] === 'GROU-0001')!.status, '已退回')
assert.ok(
  listPendingRegroutBatches().every((item) => item.注浆编号 !== 'GROU-0001'),
  '退回后该批次退出待用清单，两侧同步减少',
)
console.log('ok 11 补浆状态机越级拦截、退回放行、待用清单同步')

console.log('\n全部冒烟用例通过')
