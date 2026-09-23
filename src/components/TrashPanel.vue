<script setup>
import { store, restoreTrash, deleteForever, clearTrash } from '../store.js'

function fmt(ts) {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

function meta(t) {
  return t.parentTitle ? `原位置：${t.parentTitle}` : '原文件夹已删除'
}
</script>

<template>
  <div class="trash-overlay" @click="store.trashOpen = false"></div>
  <aside class="trash-panel">
    <div class="trash-head">
      <span class="trash-title">🗑️ 回收站</span>
      <span style="color:var(--text-3);font-size:12px">{{ store.trash.length }} 项</span>
      <button v-if="store.trash.length" class="btn" style="height:32px" @click="clearTrash">清空</button>
      <button class="icon-btn" title="关闭" @click="store.trashOpen = false">✕</button>
    </div>

    <div class="trash-list">
      <div v-if="!store.trash.length" class="trash-empty">
        <div style="font-size:30px;margin-bottom:8px">🗑️</div>
        回收站是空的
      </div>

      <div v-for="t in store.trash" :key="t.id" class="trash-item">
        <span class="t-info">
          <div class="t-title">{{ t.url ? '🔖' : '📁' }} {{ t.title }}</div>
          <div class="t-meta">{{ meta(t) }} · {{ fmt(t.deletedAt) }}</div>
        </span>
        <span class="t-actions">
          <button class="btn" style="height:30px;padding:0 10px" @click="restoreTrash(t)">恢复</button>
          <button class="btn btn-danger" style="height:30px;padding:0 10px" @click="deleteForever(t.id)">彻底删除</button>
        </span>
      </div>
    </div>
  </aside>
</template>
