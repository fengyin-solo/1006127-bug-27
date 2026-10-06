<template>
  <div class="dialog-mask" @click.self="cancel">
    <section class="dialog-panel">
      <header class="dialog-head">
        <h3>登记补浆记录</h3>
        <p class="dialog-desc">
          补浆量与初凝时间落在同一条记录里，写不成就整笔退回；同一注浆编号重复提交只留一条。
          中途断掉后重新提交，已登记的会自动跳过，从断掉的那条接着走。
        </p>
      </header>

      <table class="data-table dialog-table">
        <thead>
          <tr>
            <th>注浆编号</th>
            <th>补浆量(m³)</th>
            <th>注浆压力(MPa)</th>
            <th>初凝时间</th>
            <th>补浆班组</th>
            <th>结果</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(line, index) in lines" :key="index">
            <td>
              <select v-model="line.input.注浆编号" :disabled="line.state === 'ok'">
                <option value="" disabled>选择已完成注浆记录</option>
                <option v-for="item in eligible" :key="String(item.id)" :value="String(item['注浆编号'])">
                  {{ item['注浆编号'] }}（{{ item['对应环号'] }}）
                </option>
                <option
                  v-if="line.input.注浆编号 && !eligible.some((item) => String(item['注浆编号']) === line.input.注浆编号)"
                  :value="line.input.注浆编号"
                >
                  {{ line.input.注浆编号 }}
                </option>
              </select>
            </td>
            <td><input v-model="line.input.补浆量" :disabled="line.state === 'ok'" placeholder="如 1.2" /></td>
            <td><input v-model="line.input.注浆压力" :disabled="line.state === 'ok'" placeholder="如 0.3" /></td>
            <td><input v-model="line.input.初凝时间" type="date" :disabled="line.state === 'ok'" /></td>
            <td><input v-model="line.input.补浆班组" :disabled="line.state === 'ok'" placeholder="如 注浆二班" /></td>
            <td>
              <span v-if="line.state === 'ok'" class="ok-text">{{ line.message }}</span>
              <span v-else-if="line.state === 'failed'" class="error-text">{{ line.message }}</span>
              <span v-else class="muted-text">待提交</span>
            </td>
            <td>
              <button v-if="lines.length > 1 && line.state !== 'ok'" class="link" type="button" @click="removeLine(index)">
                删除
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <footer class="dialog-foot">
        <button class="btn ghost" type="button" @click="addLine">再加一条</button>
        <span class="muted-text">可安排补浆的注浆记录 {{ eligible.length }} 条</span>
        <span class="dialog-actions">
          <button class="btn" type="button" @click="cancel">取消</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="submit">
            {{ submitting ? '提交中…' : '提交登记' }}
          </button>
        </span>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { listEligibleGrouting, registerRegroutBatch } from '@/api/local-service'
import type { EntryRow, RegroutInput } from '@/data/types'

type LineState = 'editing' | 'ok' | 'failed'

type Line = {
  input: RegroutInput
  state: LineState
  message: string
}

const props = defineProps<{ prefillCode?: string }>()
const emit = defineEmits<{ (e: 'close', registered: boolean): void }>()

const eligible = ref<EntryRow[]>([])
const lines = ref<Line[]>([])
const submitting = ref(false)
const anyRegistered = ref(false)

function blankLine(code = ''): Line {
  return {
    input: { 注浆编号: code, 补浆量: '', 注浆压力: '', 初凝时间: '', 补浆班组: '' },
    state: 'editing',
    message: '',
  }
}

function refreshEligible() {
  eligible.value = listEligibleGrouting()
}

function addLine() {
  lines.value.push(blankLine())
}

function removeLine(index: number) {
  lines.value.splice(index, 1)
}

function cancel() {
  emit('close', anyRegistered.value)
}

function submit() {
  submitting.value = true
  try {
    const pending = lines.value.filter((line) => line.state !== 'ok')
    if (pending.length === 0) {
      emit('close', anyRegistered.value)
      return
    }
    const report = registerRegroutBatch(pending.map((line) => ({ ...line.input })))
    report.results.forEach((result, index) => {
      const line = pending[index]
      if (result.ok) {
        line.state = 'ok'
        line.message = result.message
      } else if (result.duplicated) {
        // 已登记过的不再重来：视为已处理，不再算失败。
        line.state = 'ok'
        line.message = '已登记过，自动跳过'
      } else {
        line.state = 'failed'
        line.message = result.message
      }
    })
    if (report.registered > 0) {
      anyRegistered.value = true
      // 提交完再取一次数复查：已登记的从可选清单里消失，不沿用旧值。
      refreshEligible()
    }
    if (report.failed === 0) {
      emit('close', true)
    }
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  refreshEligible()
  lines.value = [blankLine(props.prefillCode ?? '')]
})
</script>

<style scoped>
.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 30;
}
.dialog-panel {
  background: #fff;
  border-radius: 10px;
  padding: 16px 18px;
  width: min(960px, 92vw);
  max-height: 86vh;
  overflow: auto;
}
.dialog-head h3 {
  margin: 0 0 6px;
}
.dialog-desc {
  color: var(--muted);
  font-size: 12px;
  margin: 0 0 12px;
}
.dialog-table input,
.dialog-table select {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 13px;
}
.dialog-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}
.dialog-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.ok-text {
  color: #067647;
  font-size: 12px;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
</style>
