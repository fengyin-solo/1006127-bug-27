<template>
  <section class="page" data-module="mortar">
    <header class="page-head">
      <div>
        <h2>浆液拌制管理</h2>
        <p class="page-desc">
          补浆结论落到本页待用批次清单：检验合格且未被引用的批次才待用；批次数与「同步注浆」页同源，两侧始终对得上。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出浆液拌制清单</button>
      </div>
    </header>

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
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>批次编号</span>
        <input v-model="filters.batchNo" placeholder="按批次编号检索" />
      </label>
      <label class="filter-item">
        <span>浆液类型</span>
        <input v-model="filters.mortarType" placeholder="按浆液类型检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <h3 class="section-title">待用批次清单（检验合格、等待补浆引用）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>批次编号</th>
          <th>浆液类型</th>
          <th>水泥(kg)</th>
          <th>膨润土(kg)</th>
          <th>水灰比</th>
          <th>稠度</th>
          <th>拌制时间</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="batch in pendingList" :key="batch.id">
          <td>{{ batch.batchNo }}</td>
          <td>{{ batch.mortarType }}</td>
          <td>{{ batch.cementKg }}</td>
          <td>{{ batch.bentoniteKg }}</td>
          <td>{{ batch.waterCementRatio }}</td>
          <td>{{ batch.consistency }}</td>
          <td>{{ batch.mixedAt }}</td>
          <td><span class="muted-text">在同步注浆页「安排补浆」时选用</span></td>
        </tr>
        <tr v-if="!pendingList.length">
          <td colspan="8" class="empty-state">当前没有待用批次</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">全部批次</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>补浆结论</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in visibleRows" :key="row.id">
          <td>{{ row.batchNo }}</td>
          <td>{{ row.mortarType }}</td>
          <td>{{ row.cementKg }}</td>
          <td>{{ row.bentoniteKg }}</td>
          <td>{{ row.waterCementRatio }}</td>
          <td>{{ row.consistency }}</td>
          <td>{{ row.mixedAt }}</td>
          <td>
            <template v-if="row.reservedFor">
              → {{ row.reservedFor.groutNo }}（环次 {{ row.reservedFor.ringNo }}）
              <div>补入 {{ row.reservedFor.repairAmount }}m³ · {{ row.reservedFor.verdict }}</div>
            </template>
            <span v-else class="muted-text">—</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="row.status === '待拌制'"
              class="link"
              type="button"
              @click="doAction(row, '开始拌制')"
            >开始拌制</button>
            <button
              v-if="row.status === '拌制中'"
              class="link"
              type="button"
              @click="doAction(row, '提交检验')"
            >提交检验</button>
            <button
              v-if="row.status === '拌制中'"
              class="link danger-link"
              type="button"
              @click="doAction(row, '废弃批次')"
            >废弃批次</button>
            <span v-if="row.status === '检验合格'" class="muted-text">待用中</span>
            <span v-else-if="row.status === '已使用'" class="muted-text">已补浆引用</span>
          </td>
        </tr>
        <tr v-if="!visibleRows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无浆液拌制数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 个批次 · 待用 {{ pendingList.length }} 个，与同步注浆页取自同一份存储</span>
      <span v-if="message" :class="message.ok ? 'ok-text' : 'error-text'">{{ message.text }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, runAction as applyAction } from '@/api/local-service'
import { listMortar, pendingBatches } from '@/domain/grout'
import type { MortarBatch } from '@/domain/grout'

const columns = ['批次编号', '浆液类型', '水泥用量', '膨润土用量', '水灰比', '稠度', '拌制日期']
const statuses = ['待拌制', '拌制中', '检验合格', '已使用', '已废弃']

const rows = ref<MortarBatch[]>([])
const pendingList = ref<MortarBatch[]>([])
const filters = reactive({ batchNo: '', mortarType: '' })
const message = ref<{ ok: boolean; text: string } | null>(null)

const visibleRows = computed(() =>
  rows.value.filter(
    (row) =>
      row.batchNo.includes(filters.batchNo.trim()) &&
      row.mortarType.includes(filters.mortarType.trim()),
  ),
)

const stats = computed(() => [
  { label: '待用批次（与注浆页一致）', value: pendingList.value.length },
  { label: '拌制中', value: rows.value.filter((row) => row.status === '拌制中').length },
  { label: '已被补浆引用', value: rows.value.filter((row) => row.status === '已使用').length },
  { label: '已废弃', value: rows.value.filter((row) => row.status === '已废弃').length },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: rows.value.filter((row) => row.status === status).length })),
)

function reload() {
  rows.value = listMortar()
  pendingList.value = pendingBatches()
}

function resetFilters() {
  filters.batchNo = ''
  filters.mortarType = ''
}

function exportRows() {
  downloadEntries('mortar')
}

function doAction(row: MortarBatch, action: '开始拌制' | '提交检验' | '废弃批次') {
  // 通用动作也走领域服务（local-service 内委派），越级当场拦下、同源落库。
  const result = applyAction('mortar', row.id, action)
  message.value = { ok: result.ok, text: result.message }
  reload()
}

onMounted(reload)
</script>
