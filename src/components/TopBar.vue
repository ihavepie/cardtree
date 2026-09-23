<script setup>
import { computed } from 'vue'
import { store, toggleAllFolders, isAllCollapsed, toggleTheme, cycleLayoutMode, LAYOUT_MODES, toast } from '../store.js'
import { dialogNewBookmark, dialogNewFolder } from '../ui.js'

const trashCount = computed(() => store.trash.length)
const allCollapsed = computed(() => isAllCollapsed())

const layoutIndex = computed(() => Math.max(0, LAYOUT_MODES.findIndex((m) => m.key === store.layoutMode)))
const layoutLabel = computed(() => LAYOUT_MODES[layoutIndex.value].label)
const nextLayoutLabel = computed(() => LAYOUT_MODES[(layoutIndex.value + 1) % LAYOUT_MODES.length].label)
const layoutTitle = computed(() => `布局：${layoutLabel.value}（点击切换为${nextLayoutLabel.value}）`)

function onCycleLayout() {
  const next = cycleLayoutMode()
  toast(`布局：${next.label}`)
}

function defaultParentId() {
  const bar = store.roots.find((r) => (r.title || '').includes('书签栏')) || store.roots[0]
  return bar ? bar.id : null
}

function onNewBookmark() {
  dialogNewBookmark(defaultParentId())
}

function onNewFolder() {
  dialogNewFolder(defaultParentId())
}

function clearSearch() {
  store.query = ''
}

function onSearchEnter() {
  const q = store.query.trim()
  if (!q) return
  window.open(`https://www.bing.com/search?q=${encodeURIComponent(q)}`, '_blank', 'noopener')
}
</script>

<template>
  <header class="topbar">
    <div class="topbar-inner">
      <button
        class="icon-btn sidebar-toggle"
        title="侧边栏"
        @click="store.sidebarOpen = !store.sidebarOpen"
      >
        <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>

      <div class="brand">
        <span class="brand-logo">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
          </svg>
        </span>
        <span class="brand-name">书签板</span>
        <span class="brand-ver">v5.0</span>
      </div>

      <div class="search-box">
        <span class="search-icon">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="M16 16l4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </span>
        <input
          v-model="store.query"
          class="search-input"
          type="text"
          placeholder="搜索名称 / 网址 / 标签 / 描述 · 回车用 Bing"
          autocomplete="off"
          @keydown.escape="clearSearch"
          @keydown.enter="onSearchEnter"
        />
        <button v-if="store.query" class="search-clear" title="清除" @click="clearSearch">✕</button>
      </div>

      <div class="header-actions">
        <button
          class="icon-btn"
          :title="allCollapsed ? '全部展开' : '全部折叠'"
          @click="toggleAllFolders"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M8 9l4-4 4 4M8 15l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button class="btn btn-primary" @click="onNewBookmark">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
          <span class="btn-label">新建书签</span>
        </button>
        <button class="btn btn-new-folder" @click="onNewFolder"><span class="btn-label">新建文件夹</span></button>
        <button class="btn" title="回收站" @click="store.trashOpen = true">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          </svg>
          <span class="btn-label">回收站</span>
          <span v-if="trashCount" class="btn-count">{{ trashCount }}</span>
        </button>
        <button class="icon-btn" :title="layoutTitle" @click="onCycleLayout">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <!-- 单列：整行横条 -->
            <template v-if="store.layoutMode === 'single'">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </template>
            <!-- 横排多列：一行多块 -->
            <template v-else-if="store.layoutMode === 'row'">
              <rect x="3" y="5" width="7.5" height="6" rx="1.6" />
              <rect x="13.5" y="5" width="7.5" height="6" rx="1.6" />
              <rect x="3" y="14" width="7.5" height="6" rx="1.6" />
              <rect x="13.5" y="14" width="7.5" height="6" rx="1.6" />
            </template>
            <!-- 纵排多列：多栏竖条 -->
            <template v-else>
              <path d="M6 4v16M12 4v16M18 4v16" />
            </template>
          </svg>
        </button>
        <button class="icon-btn" title="背景" @click="store.bgPanelOpen = true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="9" cy="9" r="2" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </button>
        <button
          class="icon-btn"
          :title="store.theme === 'light' ? '切换到深色' : '切换到浅色'"
          @click="toggleTheme"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path v-if="store.theme === 'light'" d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
            <template v-else>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </template>
          </svg>
        </button>
      </div>
    </div>
  </header>
</template>
