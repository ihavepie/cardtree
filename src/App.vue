<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { store, clearSelection, isCollapsed, toggleCollapse, select, isSelected, loadVideoBlob, setSidebarWidth, folderColsCss } from './store.js'
import { overGrid, onDrop, endDrag } from './drag.js'
import { closeMenu, menuForEmpty, openSelected, deleteSelected, renameSelected } from './ui.js'
import { marqueeMouseDown, marqueeMouseMove, marqueeMouseUp, consumeMarqueeClick } from './marquee.js'

import TopBar from './components/TopBar.vue'
import RecentSection from './components/RecentSection.vue'
import SearchResults from './components/SearchResults.vue'
import BookmarkGrid from './components/BookmarkGrid.vue'
import CascadeNode from './components/CascadeNode.vue'
import Sidebar from './components/Sidebar.vue'
import BackgroundPanel from './components/BackgroundPanel.vue'
import TrashPanel from './components/TrashPanel.vue'
import ContextMenu from './components/ContextMenu.vue'
import AppDialog from './components/AppDialog.vue'
import DetailDrawer from './components/DetailDrawer.vue'
import IconPicker from './components/IconPicker.vue'
import Memo from './components/Memo.vue'

const searching = computed(() => store.query.trim().length > 0)

const marqueeStyle = computed(() => {
  const m = store.marquee
  if (!m) return null
  const left = Math.min(m.x1, m.x2)
  const top = Math.min(m.y1, m.y2)
  return {
    left: left + 'px',
    top: top + 'px',
    width: Math.abs(m.x2 - m.x1) + 'px',
    height: Math.abs(m.y2 - m.y1) + 'px',
  }
})

const bgStyle = computed(() => {
  const bg = store.bg
  if (!bg || bg.type !== 'custom') return null
  const item = store.customBackgrounds.find((i) => i.id === bg.id)
  if (!item || item.type !== 'image') return null
  return {
    backgroundImage: `url(${item.dataUrl})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
  }
})

const bgVideoUrl = ref('')

watch(
  () => store.bg,
  async (bg) => {
    if (bgVideoUrl.value) {
      URL.revokeObjectURL(bgVideoUrl.value)
      bgVideoUrl.value = ''
    }
    if (bg && bg.type === 'custom') {
      const item = store.customBackgrounds.find((i) => i.id === bg.id)
      if (item && item.type === 'video' && item.videoId) {
        const blob = await loadVideoBlob(item.videoId)
        if (blob) bgVideoUrl.value = URL.createObjectURL(blob)
      }
    }
  },
  { immediate: true },
)

// 顶层分区：书签栏/其他书签始终显示（即使为空）；其余（如移动设备书签）仅在有内容时显示
const visibleRoots = computed(() =>
  store.roots.filter((r) => {
    const hasKids = (r.children || []).length > 0
    const t = r.title || ''
    return hasKids || t.includes('书签栏') || t.includes('其他书签')
  }),
)

function onEmptyContext(e, parentId) {
  e.preventDefault()
  menuForEmpty(e.clientX, e.clientY, parentId)
}

function onKeydown(e) {
  if (e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return
  if (e.key === 'Escape') {
    store.dialog = null
    closeMenu()
    clearSelection()
    return
  }
  if (store.dialog || store.contextMenu) return
  if (e.key === 'Enter') {
    openSelected()
    e.preventDefault()
  } else if (e.key === 'F2') {
    renameSelected()
    e.preventDefault()
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelected()
    e.preventDefault()
  }
}

function onGlobalMouse(e) {
  if (store.contextMenu && !e.target.closest('.context-menu')) closeMenu()
}

function onGlobalClick(e) {
  if (consumeMarqueeClick()) return
  if (store.editingNodeId) return
  const t = e.target
  if (t.closest('.bookmark-item, .cascade-heading, .sf-row, .section-head, .context-menu, .modal, .trash-panel, .bg-panel, .detail-drawer')) return
  clearSelection()
}

function onResizeStart(e) {
  e.preventDefault()
  e.stopPropagation()
  const startX = e.clientX
  const startW = store.sidebarWidth
  document.body.classList.add('is-resizing-sidebar')
  const move = (ev) => setSidebarWidth(startW + (ev.clientX - startX))
  const up = () => {
    document.body.classList.remove('is-resizing-sidebar')
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

// —— 视觉特效：光标柔光 + 点击涟漪 ——
let glowEl = null
let glowRaf = null
let fxGx = window.innerWidth / 2
let fxGy = window.innerHeight / 2
let fxTx = fxGx
let fxTy = fxGy
const fxCleanups = []

function initEffects() {
  glowEl = document.createElement('div')
  glowEl.className = 'cursor-glow'
  document.body.appendChild(glowEl)

  const onMove = (e) => { fxTx = e.clientX; fxTy = e.clientY }
  window.addEventListener('mousemove', onMove)
  fxCleanups.push(() => window.removeEventListener('mousemove', onMove))

  const loop = () => {
    fxGx += (fxTx - fxGx) * 0.12
    fxGy += (fxTy - fxGy) * 0.12
    if (glowEl) glowEl.style.transform = `translate(${fxGx - 250}px, ${fxGy - 250}px)`
    glowRaf = requestAnimationFrame(loop)
  }
  loop()
  fxCleanups.push(() => cancelAnimationFrame(glowRaf))

  const onClick = (e) => {
    if (e.target.closest('button, input, a, textarea, select, label')) return
    const r = document.createElement('span')
    r.className = 'click-ripple'
    r.style.left = e.clientX + 'px'
    r.style.top = e.clientY + 'px'
    document.body.appendChild(r)
    setTimeout(() => r.remove(), 650)
  }
  window.addEventListener('click', onClick)
  fxCleanups.push(() => window.removeEventListener('click', onClick))
}

function disposeEffects() {
  fxCleanups.forEach((fn) => fn())
  fxCleanups.length = 0
  if (glowEl) { glowEl.remove(); glowEl = null }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('mousedown', onGlobalMouse, true)
  window.addEventListener('click', onGlobalClick)
  window.addEventListener('mousedown', marqueeMouseDown)
  window.addEventListener('mousemove', marqueeMouseMove)
  window.addEventListener('mouseup', marqueeMouseUp)
  initEffects()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('mousedown', onGlobalMouse, true)
  window.removeEventListener('click', onGlobalClick)
  window.removeEventListener('mousedown', marqueeMouseDown)
  window.removeEventListener('mousemove', marqueeMouseMove)
  window.removeEventListener('mouseup', marqueeMouseUp)
  disposeEffects()
})
</script>

<template>
  <div
    class="app"
    :class="[
      'layout-' + store.layoutMode,
      'layout-cols-' + (store.folderCols === 'auto' ? 'auto' : 'fixed'),
      { 'app-loading': store.loading },
    ]"
    :style="{ '--folder-cols': folderColsCss() }"
  >
    <div class="bg" :style="bgStyle"></div>
    <video
      v-if="bgVideoUrl"
      class="bg-video"
      :src="bgVideoUrl"
      autoplay
      loop
      muted
      playsinline
    ></video>
    <div class="bg-blobs"></div>

    <TopBar />

    <div class="content">
      <Sidebar />
      <div v-if="store.sidebarOpen" class="sidebar-resizer" title="拖拽调整侧边栏宽度" @mousedown="onResizeStart"></div>

      <main class="main">
      <div class="main-inner">
        <div v-if="store.loading" class="loading">加载书签中…</div>

        <SearchResults v-else-if="searching" />

        <template v-else>
          <section
            v-for="root in visibleRoots"
            :key="root.id"
            class="root-section"
          >
            <div
              class="root-card"
              data-droppable
              @dragover="overGrid($event, root.id)"
              @drop="onDrop"
              @dragend="endDrag"
              :class="{ 'drop-inside': store.dropTarget?.type === 'inside' && store.dropTarget.folderId === root.id, selected: isSelected(root.id) }"
              @contextmenu="onEmptyContext($event, root.id)"
            >
              <RecentSection v-if="store.recent.length" />
              <template v-if="(root.children || []).length">
                <BookmarkGrid
                  v-if="(root.children || []).filter((c) => c.url).length"
                  :parent-id="root.id"
                  :nodes="root.children.filter((c) => c.url)"
                />
                <div
                  v-if="(root.children || []).filter((c) => !c.url).length"
                  class="cascade-children"
                >
                  <CascadeNode
                    v-for="child in root.children.filter((c) => !c.url)"
                    :key="child.id"
                    :node="child"
                  />
                </div>
              </template>
              <div v-else class="empty-hint">
                <div class="big">这里还没有书签</div>
                <div class="sub">右键空白处新建书签或文件夹</div>
              </div>
            </div>
          </section>
        </template>
      </div>
      </main>
    </div>

    <!-- 全局插入指示线 -->
    <div
      v-if="store.dropLine"
      class="drop-line"
      :class="store.dropLine.orient"
      :style="{
        left: store.dropLine.x + 'px',
        top: store.dropLine.y + 'px',
        width: store.dropLine.w + 'px',
        height: store.dropLine.h + 'px',
      }"
    ></div>

    <!-- 框选矩形 -->
    <div v-if="store.marquee" class="marquee" :style="marqueeStyle"></div>

    <TrashPanel v-if="store.trashOpen" />
    <BackgroundPanel v-if="store.bgPanelOpen" />
    <ContextMenu v-if="store.contextMenu" />
    <AppDialog v-if="store.dialog" />
    <DetailDrawer />
    <IconPicker />
    <Memo />

    <div v-if="store.toast" class="toast" :class="{ warning: store.toast.type === 'warning' }">
      {{ store.toast.msg }}
    </div>
  </div>
</template>
