<script setup>
import { computed } from 'vue'
import { store, nodeById, setFolderIcon, setFolderIconColor, getFolderIcon, getFolderIconColor } from '../store.js'
import { FOLDER_ICONS } from '../folder-icons.js'
import Icon from './Icon.vue'

const COLORS = [
  '#6366f1', '#3b82f6', '#14b8a6', '#10b981', '#f59e0b',
  '#f97316', '#ef4444', '#ec4899', '#8b5cf6', '#94a3b8',
]

const folder = computed(() =>
  store.iconPickerFolderId ? nodeById(store.iconPickerFolderId) : null,
)
const currentIcon = computed(() =>
  store.iconPickerFolderId ? getFolderIcon(store.iconPickerFolderId) : '',
)
const currentColor = computed(() =>
  store.iconPickerFolderId ? getFolderIconColor(store.iconPickerFolderId) : '',
)

function pick(name) {
  if (store.iconPickerFolderId) setFolderIcon(store.iconPickerFolderId, name)
}

function pickColor(c) {
  if (store.iconPickerFolderId) setFolderIconColor(store.iconPickerFolderId, c)
}

function clearIcon() {
  if (!store.iconPickerFolderId) return
  setFolderIcon(store.iconPickerFolderId, '')
  setFolderIconColor(store.iconPickerFolderId, '')
}

function close() {
  store.iconPickerFolderId = null
}
</script>

<template>
  <div v-if="folder" class="icon-picker-overlay" @mousedown.self="close">
    <div class="icon-picker">
      <div class="icon-picker-head">
        <span>更改图标 · {{ folder.title || '未命名' }}</span>
        <button class="icon-btn" title="关闭" @click="close">✕</button>
      </div>

      <div class="icon-picker-label">图标</div>
      <div class="icon-picker-grid">
        <button
          v-for="n in FOLDER_ICONS"
          :key="n"
          class="icon-opt"
          :class="{ active: currentIcon === n }"
          :title="n"
          @click="pick(n)"
        >
          <Icon :name="n" :size="20" />
        </button>
      </div>

      <div class="icon-picker-label" style="margin-top: 14px">颜色</div>
      <div class="icon-picker-colors">
        <button
          v-for="c in COLORS"
          :key="c"
          class="icon-color-dot"
          :class="{ active: currentColor === c }"
          :style="{ background: c }"
          :title="c"
          @click="pickColor(c)"
        />
        <button
          class="icon-color-default"
          :class="{ active: !currentColor }"
          title="默认（跟随主题）"
          @click="pickColor('')"
        >默认</button>
      </div>

      <div class="icon-picker-foot">
        <button class="btn" @click="clearIcon">清除图标</button>
        <span style="flex: 1"></span>
        <button class="btn btn-primary" @click="close">完成</button>
      </div>
    </div>
  </div>
</template>
