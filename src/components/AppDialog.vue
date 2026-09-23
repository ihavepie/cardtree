<script setup>
import { reactive, ref, onMounted, nextTick } from 'vue'
import { store, toast } from '../store.js'
import { closeDialog } from '../ui.js'
import Icon from './Icon.vue'

const values = reactive({})
const firstInput = ref(null)
const submitting = ref(false)

onMounted(() => {
  const d = store.dialog
  for (const f of d.fields || []) {
    values[f.key] = f.value ?? ''
    if (f.type === 'folder') {
      const first = (f.options || []).find((o) => !o.disabled)
      if (first) values[f.key] = first.id
    }
  }
  nextTick(() => firstInput.value && firstInput.value.focus())
})

async function submit() {
  const d = store.dialog
  for (const f of d.fields || []) {
    if (f.required && !String(values[f.key] ?? '').trim()) {
      toast(`请填写「${f.label}」`, 'warning')
      return
    }
  }
  submitting.value = true
  try {
    await d.onSubmit(values)
    closeDialog()
  } catch (e) {
    /* 校验失败保持弹窗 */
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="modal-overlay" @mousedown.self="closeDialog">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">{{ store.dialog.title }}</div>
      <div class="modal-body">
        <div v-for="f in store.dialog.fields" :key="f.key" class="field">
          <label class="field-label">{{ f.label }}</label>

          <input
            v-if="f.type === 'text' || f.type === 'url'"
            v-model="values[f.key]"
            class="field-input"
            :type="f.type === 'url' ? 'url' : 'text'"
            :placeholder="f.placeholder"
            :ref="(el) => { if (!firstInput) firstInput = el }"
            @keydown.enter="submit"
          />

          <div v-else-if="f.type === 'folder'" class="folder-list">
            <div
              v-for="opt in f.options"
              :key="opt.id"
              class="folder-item"
              :class="{ selected: values[f.key] === opt.id, disabled: opt.disabled }"
              :style="opt.disabled ? 'opacity:.4;pointer-events:none' : ''"
              @click="values[f.key] = opt.id"
            >
              <span class="fold-indent">{{ '　'.repeat(opt.indent) }}</span>
              <span class="fold-label"><Icon name="folder" :size="14" /> {{ opt.label }}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="closeDialog">取消</button>
        <button class="btn btn-primary" :disabled="submitting" @click="submit">
          {{ store.dialog.submitLabel || '确定' }}
        </button>
      </div>
    </div>
  </div>
</template>
