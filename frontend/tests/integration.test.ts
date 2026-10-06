// 集成测试：通用服务层（看板/其他页面）与补浆领域同源、动作委派正确。
import assert from 'node:assert/strict'

import { installStorage } from './storage-shim.ts'

const storage = installStorage()
storage.setItem(
  'shield-tunnel-construction:entries',
  JSON.stringify({
    grouting: [
      { id: 1, status: '待注浆', 注浆编号: 'G-I-1', 对应环号: 'R100', 注浆量: '0', 注浆压力: '0', 初凝时间: '', 注浆班组: 'c', 注浆状态: '待注浆' },
    ],
    mortar: [
      { id: 1, status: '待拌制', 批次编号: 'B-I-1', 水泥用量: '1', 膨润土用量: '1', 水灰比: '1', 稠度: '1', 拌制日期: '2026-10-01', 批次状态: '待拌制' },
    ],
    ring: [{ id: 7, status: '待掘进', 环号: 'RING-X' }],
  }),
)

const { resetStore } = await import('@/domain/grout')
resetStore()
const { listEntries, runAction, resetModule, loadOverview, exportEntries } = await import('@/api/local-service')

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

await test('通用列表取的是领域投影，且老表迁移后只剩一份', () => {
  const grouting = listEntries('grouting')
  assert.ok(grouting.items.some((r) => r['注浆编号'] === 'G-I-1'))
  assert.ok(grouting.items.some((r) => String(r['注浆编号']).startsWith('GROU-2026-')))
  const mortar = listEntries('mortar')
  assert.ok(mortar.items.some((r) => r['批次编号'] === 'B-I-1'))
  // 迁移后老 key 中两键被删，不会重复计数。
  const legacy = JSON.parse(storage.dump()['shield-tunnel-construction:entries'])
  assert.equal(legacy['grouting'], undefined)
  assert.equal(legacy['mortar'], undefined)
})

await test('注浆越级动作通过领域服务被拦', () => {
  const row = listEntries('grouting').items.find((r) => r['注浆编号'] === 'G-I-1')
  const jump = runAction('grouting', row.id, '确认完成')
  assert.equal(jump.ok, false)
  assert.match(jump.message, /越级/)
  const ok = runAction('grouting', row.id, '开始注浆')
  assert.equal(ok.ok, true, ok.message)
  const done = runAction('grouting', row.id, '确认完成')
  assert.equal(done.ok, true)
})

await test('安排补浆不能走通用动作，必须走整笔登记面板', () => {
  const row = listEntries('grouting').items.find((r) => r['注浆编号'] === 'G-I-1')
  const blocked = runAction('grouting', row.id, '安排补浆')
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /安排补浆/)
})

await test('浆液批次动作委派领域并被越级规则约束', () => {
  const row = listEntries('mortar').items.find((r) => r['批次编号'] === 'B-I-1')
  const jump = runAction('mortar', row.id, '废弃批次')
  assert.equal(jump.ok, false, '待拌制不能直接废弃')
  assert.equal(runAction('mortar', row.id, '开始拌制').ok, true)
  assert.equal(runAction('mortar', row.id, '废弃批次').ok, true)
})

await test('看板汇总与领域行同源，其他模块（ring）不受影响', () => {
  const overview = loadOverview()
  const groutingCard = overview.modules.find((m) => m.name === '同步注浆')
  const mortarCard = overview.modules.find((m) => m.name === '浆液拌制')
  assert.equal(groutingCard.created, listEntries('grouting').total)
  assert.equal(mortarCard.created, listEntries('mortar').total)
  const ringCard = overview.modules.find((m) => m.name === '掘进环次')
  assert.ok(ringCard.created >= 3)
})

await test('领域重置后通用列表随之重建，不留分叉', () => {
  resetModule('grouting')
  const first = listEntries('grouting').total
  resetModule('grouting')
  assert.equal(listEntries('grouting').total, first)
})

await test('导出 CSV 行列与领域投影一致', () => {
  const csv = exportEntries('grouting').content
  assert.match(csv, /注浆编号/)
  assert.match(csv, /GROU-2026-0105/)
})

console.log(`\n${passed} 项集成测试全部通过`)
