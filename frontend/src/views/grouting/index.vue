<template>
  <section class="page" data-module="grouting">
    <header class="page-head">
      <div>
        <h2>同步注浆管理</h2>
        <p class="page-desc">
          取数失败按失败处理并重试，绝不拿旧读数顶替；补浆必须完成注浆确认，补浆量与初凝时间整笔同登、写不成就整笔退回。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openRegister">取数 / 登记注浆记录</button>
        <button class="btn" type="button" @click="exportRows">导出同步注浆清单</button>
      </div>
    </header>

    <!-- 联调面板：模拟现场取数与写库故障，验证失败链路兜底。 -->
    <div class="fault-panel">
      <span class="fault-title">现场链路演练：</span>
      <label>取数
        <select v-model="fetchFaultMode" @change="applyFetchFault">
          <option value="none">正常</option>
          <option value="flaky">首包抖动（重试可恢复）</option>
          <option value="offline">设备离线（重试仍失败）</option>
          <option value="corrupt">报文损坏（缺压力）</option>
        </select>
      </label>
      <label>写库
        <select v-model="writeFaultMode" @change="applyWriteFault">
          <option value="none">正常</option>
          <option value="once">下一次写失败</option>
          <option value="always">持续写失败</option>
        </select>
      </label>
      <button class="btn ghost" type="button" @click="runGlobalRecheck('manual')">落库后复查本页</button>
      <span class="fault-hint">复查重新从设备取数核对，中断或失败时提示原因，不沿用页面旧值。</span>
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item warn">复查异常：{{ abnormalCount }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>注浆编号</span>
        <input v-model="filters.groutNo" placeholder="按注浆编号检索" />
      </label>
      <label class="filter-item">
        <span>对应环号</span>
        <input v-model="filters.ringNo" placeholder="按环号检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <!-- 未完成的批量取数登记任务：已登记的不重来，只从断掉那一条接着走。 -->
    <div v-if="cursor" class="job-panel">
      <div class="job-head">
        <strong>批量取数登记 {{ cursor.jobId }}</strong>
        <span v-if="cursor.failed" class="error-text">
          停在 {{ cursor.failed.groutNo }}：{{ cursor.failed.reason }}
        </span>
        <span v-else>剩余 {{ cursor.queue.length }} 条待取数</span>
      </div>
      <div class="job-progress">
        <span class="job-done">已登记：{{ cursor.done.join('、') || '无' }}</span>
        <span>待处理：{{ cursor.queue.join('、') }}</span>
      </div>
      <div class="job-actions">
        <button class="btn primary" type="button" :disabled="jobBusy" @click="continueJob">
          {{ jobBusy ? '正在取数登记…' : cursor.failed ? '从断掉这一条重试' : '继续' }}
        </button>
        <button class="btn" type="button" :disabled="jobBusy" @click="abortJob">
          终止任务（已登记记录保留）
        </button>
      </div>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>设计量/结论</th>
          <th>复查</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in visibleRows" :key="row.id" :class="{ 'row-abnormal': row.verified === false }">
          <td>{{ row.groutNo }}</td>
          <td>{{ row.ringNo }}</td>
          <td class="cell-clip" :title="row.mixRatio">{{ row.mixRatio }}</td>
          <td>{{ row.groutAmount }}</td>
          <td>{{ row.pressure }}</td>
          <td>{{ toDisplayTime(row.initialSetTime) || '—' }}</td>
          <td>{{ row.crew }}</td>
          <td>
            <span v-if="row.designAmount === null">历史无设计量</span>
            <span v-else>{{ row.designAmount }}</span>
            <div v-if="row.repair" class="repair-conclusion">
              补浆 {{ row.repair.amount }}m³ · {{ row.repair.verdict }} · {{ row.repair.batchNo }}
            </div>
          </td>
          <td>
            <span v-if="row.verified === true" class="ok-text">一致</span>
            <span v-else-if="row.verified === false" class="error-text">不一致</span>
            <span v-else class="muted-text">未复查</span>
          </td>
          <td>
            {{ row.status }}
            <span v-if="row.legacy" class="tag">历史</span>
          </td>
          <td class="row-actions">
            <button
              v-if="row.status === '待注浆'"
              class="link"
              type="button"
              @click="doTransition(row, '开始注浆')"
            >开始注浆</button>
            <button
              v-if="row.status === '注浆中'"
              class="link"
              type="button"
              @click="doTransition(row, '确认完成')"
            >注浆确认</button>
            <button
              v-if="row.status === '已完成'"
              class="link"
              type="button"
              @click="openRepair(row)"
            >安排补浆</button>
            <button class="link ghost-link" type="button" @click="recheckOne(row)">复查</button>
          </td>
        </tr>
        <tr v-if="!visibleRows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无同步注浆数据，可先取数登记</td>
        </tr>
      </tbody>
    </table>

    <div v-for="(msg, i) in rowErrors" :key="i" class="error-banner">
      {{ msg.groutNo }}：{{ msg.text }}
    </div>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 条注浆记录 · 数据与「浆液拌制」同源，待补浆批次数两侧一致</span>
      <span v-if="globalMessage" :class="globalMessage.ok ? 'ok-text' : 'error-text'">
        {{ globalMessage.text }}
      </span>
    </footer>

    <!-- 取数 / 登记：两个入口共用同一份校验与落库逻辑 -->
    <div v-if="registerOpen" class="modal-mask" @click.self="registerOpen = false">
      <div class="modal">
        <h3>取数 / 登记注浆记录</h3>
        <div class="tab-row">
          <button
            type="button"
            :class="['tab', registerTab === 'single' ? 'active' : '']"
            @click="registerTab = 'single'"
          >单条取数登记</button>
          <button
            type="button"
            :class="['tab', registerTab === 'batch' ? 'active' : '']"
            @click="registerTab = 'batch'"
          >批量取数登记（断线续传）</button>
        </div>

        <div v-if="registerTab === 'single'">
          <div class="form-row">
            <label>注浆编号
              <input v-model="singleForm.groutNo" placeholder="如 GROU-2026-0106（设备侧有本轮读数）" />
            </label>
            <button class="btn" type="button" :disabled="singleBusy" @click="pullSingle">
              {{ singleBusy ? '取数中…' : '现场取数' }}
            </button>
          </div>
          <p v-if="singleFetchMsg" :class="singleFetchOk ? 'ok-text' : 'error-text'">{{ singleFetchMsg }}</p>
          <fieldset class="draft-grid" :disabled="!singleDraft">
            <label>对应环号<input v-model="singleForm.ringNo" /></label>
            <label>注浆量（m³）<input v-model.number="singleForm.groutAmount" type="number" step="0.01" /></label>
            <label>注浆压力（MPa）<input v-model.number="singleForm.pressure" type="number" step="0.01" /></label>
            <label>初凝时间<input v-model="singleForm.initialSetTime" type="datetime-local" /></label>
            <label>设计注浆量（m³，历史记录留空）
              <input v-model.number="singleForm.designAmount" type="number" step="0.01" placeholder="留空=历史记录" />
            </label>
            <label>注浆班组<input v-model="singleForm.crew" /></label>
            <label class="span-2">浆液配比<input v-model="singleForm.mixRatio" /></label>
          </fieldset>
          <div class="modal-actions">
            <button class="btn ghost" type="button" @click="registerOpen = false">取消</button>
            <button class="btn primary" type="button" :disabled="singleBusy" @click="submitSingle">
              落库登记（落库前再校验一遍）
            </button>
          </div>
        </div>

        <div v-else>
          <p class="muted-text">
            设备侧当前可取编号：{{ deviceNumbers.join('、') }}。中途断线会停在失败那一条，
            已登记的不重来；恢复后从断点继续。
          </p>
          <label class="span-2">批量注浆编号（逗号或换行分隔）
            <textarea v-model="batchInput" rows="3" placeholder="GROU-2026-0109, GROU-2026-0110"></textarea>
          </label>
          <label class="inline-check">
            <input v-model="armOffline" type="checkbox" />
            演练：第 1 条成功后模拟设备断线
          </label>
          <div class="modal-actions">
            <button class="btn ghost" type="button" @click="registerOpen = false">关闭</button>
            <button class="btn primary" type="button" :disabled="jobBusy" @click="startJob">
              建立批量任务并开始
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 安排补浆 -->
    <div v-if="repairTarget" class="modal-mask" @click.self="repairTarget = null">
      <div class="modal">
        <h3>安排补浆 · {{ repairTarget.groutNo }}（{{ repairTarget.ringNo }}）</h3>
        <p class="muted-text">
          已注 {{ repairTarget.groutAmount }}m³ / 设计
          {{ repairTarget.designAmount === null ? '无（历史记录豁免超量判定）' : `${repairTarget.designAmount}m³` }}
        </p>
        <div class="draft-grid">
          <label>待用浆液批次
            <select v-model="repairForm.batchNo">
              <option value="" disabled>请选择检验合格的待用批次</option>
              <option v-for="batch in pendingBatchList" :key="batch.batchNo" :value="batch.batchNo">
                {{ batch.batchNo }} · {{ batch.mortarType }} · {{ batch.mixedAt }}
              </option>
            </select>
          </label>
          <label>补浆量（m³）<input v-model.number="repairForm.amount" type="number" step="0.01" /></label>
          <label>补浆压力（MPa）<input v-model.number="repairForm.pressure" type="number" step="0.01" /></label>
          <label>初凝时间（与补浆量同一份）<input v-model="repairForm.initialSetTime" type="datetime-local" /></label>
          <label v-if="repairVerdictHint.over" class="span-2">
            超量说明（批准人+原因，必填）
            <textarea v-model="repairForm.excessNote" rows="2" placeholder="如：项目经理王某批准，管片间隙偏大需回填"></textarea>
          </label>
        </div>
        <p v-if="repairVerdictHint.text" :class="repairVerdictHint.over ? 'warn-text' : 'ok-text'">
          {{ repairVerdictHint.text }}
        </p>
        <p v-if="repairError" class="error-text">{{ repairError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="repairTarget = null">取消</button>
          <button class="btn primary" type="button" @click="submitRepair">整笔提交（两侧同落，失败整退）</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  arrangeRepair,
  advanceBatchJob,
  armInterruption,
  clearInterruption,
  discardBatchJob,
  draftFromReading,
  fetchReading,
  getCursor,
  groutOverview,
  judgeRepair,
  knownDeviceNumbers,
  listGrouting,
  pendingBatches,
  recheckRecord,
  registerGrouting,
  resumeBatchJob,
  setFetchFault,
  setWriteFault,
  startBatchJob,
  toDateTimeInput,
  toDisplayTime,
  transition,
} from '@/domain/grout'
import { downloadEntries } from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { GroutRecord, MortarBatch } from '@/domain/grout'

const session = useSessionStore()

const columns = ['注浆编号', '对应环号', '浆液配比', '注浆量', '注浆压力', '初凝时间', '注浆班组']
const statuses = ['待注浆', '注浆中', '已完成', '已补浆']

const rows = ref<GroutRecord[]>([])
const filters = reactive({ groutNo: '', ringNo: '' })
const globalMessage = ref<{ ok: boolean; text: string } | null>(null)
const rowErrors = ref<{ groutNo: string; text: string }[]>([])

const fetchFaultMode = ref('none')
const writeFaultMode = ref('none')

const visibleRows = computed(() =>
  rows.value.filter(
    (row) =>
      row.groutNo.includes(filters.groutNo.trim()) &&
      row.ringNo.includes(filters.ringNo.trim()),
  ),
)

const stats = computed(() => {
  const overview = groutOverview()
  return [
    { label: '注浆总量（m³）', value: overview.totalAmount },
    { label: '平均注浆压力（MPa）', value: overview.averagePressure },
    { label: '待补浆记录', value: overview.pendingRepairCount },
    { label: '待用浆液批次（两侧一致）', value: overview.pendingBatchCount },
    { label: '已补浆', value: overview.repairDoneCount },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: rows.value.filter((row) => row.status === status).length })),
)
const abnormalCount = computed(() => rows.value.filter((row) => row.verified === false || row.lastError).length)
const cursor = ref(getCursor())
const pendingBatchList = ref<MortarBatch[]>([])

function reload() {
  rows.value = listGrouting()
  cursor.value = getCursor()
  pendingBatchList.value = pendingBatches()
  rowErrors.value = rows.value
    .filter((row) => row.lastError)
    .map((row) => ({ groutNo: row.groutNo, text: row.lastError as string }))
}

function resetFilters() {
  filters.groutNo = ''
  filters.ringNo = ''
}

function exportRows() {
  downloadEntries('grouting')
}

function flash(ok: boolean, text: string) {
  globalMessage.value = { ok, text }
  window.setTimeout(() => {
    globalMessage.value = null
  }, 5000)
}

function applyFetchFault() {
  setFetchFault(fetchFaultMode.value as Parameters<typeof setFetchFault>[0])
  if (fetchFaultMode.value === 'none') clearInterruption()
  flash(true, `取数故障模拟已切换为：${fetchFaultMode.value}`)
}

function applyWriteFault() {
  setWriteFault(writeFaultMode.value as Parameters<typeof setWriteFault>[0])
  flash(true, `写库故障模拟已切换为：${writeFaultMode.value}`)
}

// ---------- 单条取数 / 登记 ----------
const registerOpen = ref(false)
const registerTab = ref<'single' | 'batch'>('single')
const singleBusy = ref(false)
const singleFetchMsg = ref('')
const singleFetchOk = ref(false)
const singleDraft = ref(false)
const deviceNumbers = knownDeviceNumbers()

const emptySingle = () => ({
  groutNo: '',
  ringNo: '',
  mixRatio: '水泥:膨润土:砂:水=120:60:800:420',
  groutAmount: 0,
  pressure: 0,
  initialSetTime: '',
  crew: '注浆一班',
  designAmount: null as number | null,
})
const singleForm = reactive(emptySingle())

function openRegister() {
  registerOpen.value = true
  registerTab.value = 'single'
  singleFetchMsg.value = ''
  singleDraft.value = false
  Object.assign(singleForm, emptySingle())
}

async function pullSingle() {
  singleBusy.value = true
  singleFetchMsg.value = ''
  singleFetchOk.value = false
  const groutNo = singleForm.groutNo.trim()
  if (!groutNo) {
    singleFetchMsg.value = '请先填写注浆编号再取数'
    singleBusy.value = false
    return
  }
  const outcome = await fetchReading(groutNo)
  singleBusy.value = false
  if (!outcome.ok) {
    // 取不到就是失败：表单保持空白，绝不用上一轮读数填充。
    singleFetchMsg.value = `取数失败：${outcome.reason}（尝试 ${outcome.attempts} 次）`
    singleFetchOk.value = false
    singleDraft.value = false
    return
  }
  const draft = draftFromReading(outcome.reading)
  Object.assign(singleForm, draft)
  singleDraft.value = true
  singleFetchOk.value = true
  singleFetchMsg.value = `取数成功（第 ${outcome.attempts} 次尝试），已填入现场读数，请核对后落库`
}

function submitSingle() {
  const draft = {
    groutNo: singleForm.groutNo.trim(),
    ringNo: singleForm.ringNo.trim(),
    mixRatio: singleForm.mixRatio.trim(),
    groutAmount: Number(singleForm.groutAmount),
    pressure: Number(singleForm.pressure),
    initialSetTime: singleForm.initialSetTime.trim(),
    crew: singleForm.crew.trim(),
    designAmount:
      singleForm.designAmount === null || Number.isNaN(singleForm.designAmount)
        ? null
        : Number(singleForm.designAmount),
  }
  const result = registerGrouting(draft)
  if (!result.ok) {
    flash(false, `登记退回：${result.reason}`)
    return
  }
  flash(true, result.notice ?? '注浆记录已落库，建议落库后复查现场读数')
  registerOpen.value = false
  reload()
}

// ---------- 批量取数登记：断线续传 ----------
const jobBusy = ref(false)
const batchInput = ref(knownDeviceNumbers().filter((no) => ['GROU-2026-0109', 'GROU-2026-0110', 'GROU-2026-0111'].includes(no)).join(', '))
const armOffline = ref(false)

function parseBatch(): string[] {
  return batchInput.value
    .split(/[\s,，\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

async function startJob() {
  if (armOffline.value) {
    setFetchFault('none')
    armInterruption(1, 'offline')
  } else {
    clearInterruption()
  }
  const started = startBatchJob(parseBatch())
  if (!started.ok) {
    flash(false, started.reason)
    return
  }
  registerOpen.value = false
  await runJob()
}

async function runJob() {
  jobBusy.value = true
  const progress = cursor.value?.failed
    ? await resumeBatchJob(session.operator === '' ? '值班管理员' : session.operator)
    : await advanceBatchJob(session.operator === '' ? '值班管理员' : session.operator)
  jobBusy.value = false
  cursor.value = progress.cursor
  reload()
  if (!progress.cursor) {
    flash(true, '批量取数登记全部完成')
  } else if (progress.cursor.failed) {
    flash(false, `批量任务停在 ${progress.cursor.failed.groutNo}：${progress.cursor.failed.reason}；已登记 ${progress.cursor.done.length} 条保留，恢复后从断点继续`)
  }
}

async function continueJob() {
  clearInterruption()
  setFetchFault('none')
  await runJob()
}

function abortJob() {
  const result = discardBatchJob()
  if (!result.ok) {
    flash(false, result.reason)
    return
  }
  flash(true, `任务已终止，已登记的 ${result.data.kept.length} 条保留不回退`)
  reload()
}

// ---------- 状态流转 ----------
function doTransition(row: GroutRecord, action: '开始注浆' | '确认完成') {
  const result = transition(row.groutNo, action)
  if (!result.ok) {
    flash(false, result.reason)
    return
  }
  flash(true, `${row.groutNo} 已${action}，当前状态「${result.data.status}」`)
  reload()
}

// ---------- 补浆 ----------
const repairTarget = ref<GroutRecord | null>(null)
const repairError = ref('')
const repairForm = reactive({ batchNo: '', amount: 0, pressure: 0, initialSetTime: '', excessNote: '' })

const repairVerdictHint = computed(() => {
  if (!repairTarget.value) return { over: false, text: '' }
  const amount = Number(repairForm.amount)
  if (!Number.isFinite(amount) || amount <= 0) return { over: false, text: '' }
  const judgment = judgeRepair(repairTarget.value.designAmount, repairTarget.value.groutAmount, amount)
  if (judgment.ceiling === null) {
    return { over: false, text: '历史记录无设计量，本次补浆豁免超量判定，按补足处理' }
  }
  if (judgment.allowed) {
    return { over: false, text: `补入后总量 ${(repairTarget.value.groutAmount + amount).toFixed(3)}m³，在 5% 上限 ${judgment.ceiling}m³ 内，结论：补足` }
  }
  return {
    over: true,
    text: `补入后总量 ${(repairTarget.value.groutAmount + amount).toFixed(3)}m³，超过 5% 上限 ${judgment.ceiling}m³；须填写超量说明，结论记「超量补入」`,
  }
})

function openRepair(row: GroutRecord) {
  repairTarget.value = row
  repairError.value = ''
  repairForm.batchNo = pendingBatches()[0]?.batchNo ?? ''
  repairForm.amount = row.designAmount === null ? 0 : Number((row.designAmount - row.groutAmount).toFixed(2))
  repairForm.pressure = Number((row.pressure + 0.01).toFixed(2))
  repairForm.initialSetTime = toDateTimeInput(row.repair?.initialSetTime ?? '')
  repairForm.excessNote = ''
}

function submitRepair() {
  if (!repairTarget.value) return
  const result = arrangeRepair(
    {
      groutNo: repairTarget.value.groutNo,
      batchNo: repairForm.batchNo,
      amount: Number(repairForm.amount),
      pressure: Number(repairForm.pressure),
      initialSetTime: repairForm.initialSetTime.trim(),
      excessNote: repairForm.excessNote.trim() || undefined,
    },
    session.operator,
  )
  if (!result.ok) {
    repairError.value = result.reason
    return
  }
  flash(true, `${repairTarget.value.groutNo} 补浆已登记（${result.data.record.repair?.verdict}），批次 ${result.data.batch.batchNo} 结论已回写`)
  repairTarget.value = null
  reload()
}

// ---------- 落库后复查 ----------
async function recheckOne(row: GroutRecord) {
  const result = await recheckRecord(row.groutNo)
  reload()
  if (!result.ok) {
    flash(false, result.reason)
    return
  }
  flash(result.data.consistent, result.data.consistent ? `${row.groutNo} 复查一致` : `${row.groutNo} 复查不一致，已按现场读数标出原因`)
}

async function runGlobalRecheck(scope: 'auto' | 'manual' = 'manual') {
  const known = new Set(knownDeviceNumbers())
  const candidates = rows.value.filter(
    (row) => row.groutAmount > 0 && (scope === 'manual' ? known.has(row.groutNo) : known.has(row.groutNo) && row.verified === null),
  )
  let failed = 0
  for (const row of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const result = await recheckRecord(row.groutNo)
    if (!result.ok || (result.ok && !result.data.consistent)) failed += 1
  }
  reload()
  if (scope === 'manual') {
    flash(failed === 0, `复查完成，共 ${candidates.length} 条${failed ? `，${failed} 条取数失败或与现场不符（未覆盖旧值）` : '，全部一致'}`)
  }
}

onMounted(() => {
  reload()
  // 提交完再进页面：对已登记且设备侧有读数、尚未复查的记录重新取数核对；失败提示而不是沿用旧值。
  runGlobalRecheck('auto')
})
</script>
