<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { store, clearSelection, isCollapsed, toggleCollapse, select, isSelected, loadVideoBlob, setSidebarWidth, filteredRoots, tagIndex, setTagFilter, clearTagFilter, revealNode } from './store.js'
import { overGrid, onDrop, endDrag } from './drag.js'
import { closeMenu, menuForEmpty, openSelected, deleteSelected, renameSelected } from './ui.js'
import { marqueeMouseDown, marqueeMouseMove, marqueeMouseUp, consumeMarqueeClick } from './marquee.js'

import TopBar from './components/TopBar.vue'
import RecentSection from './components/RecentSection.vue'
import FrequentSection from './components/FrequentSection.vue'
import FolderSection from './components/FolderSection.vue'
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

// ---- 滚动联动（scroll spy）：主区滚到哪，侧栏就高亮哪个文件夹 ----
// 取"已经越过顶部基准线的最后一个文件夹节点" —— 嵌套时自然取到最内层那一个。
const mainEl = ref(null)
let spyTimer = 0
let spyLast = 0

function updateSpy() {
  const main = mainEl.value
  if (!main) return
  if (searching.value || !store.sidebarOpen) {
    if (store.spyId) store.spyId = null
    return
  }
  // 基准线：主区可见区域顶部再往下一点（越过吸顶的工具条），落在它上面的算"已滚过"
  const base = main.getBoundingClientRect().top + 110
  let cur = null
  for (const el of main.querySelectorAll('.cascade-node[data-id]')) {
    const top = el.getBoundingClientRect().top
    if (top <= base) cur = el.dataset.id
    else break
  }
  if (store.spyId !== cur) store.spyId = cur
}

// 用「时间戳节流 + setTimeout 兜底」而不是 requestAnimationFrame：
// rAF 在有头/无头环境下的行为不一致（无头下可能一直不触发），滚动联动会彻底不工作。
// 80ms 一次足够跟手，且末尾一定会有一次更新。
const SPY_INTERVAL = 80
function onMainScroll() {
  const since = Date.now() - spyLast
  if (since >= SPY_INTERVAL) { spyLast = Date.now(); updateSpy(); return }
  if (spyTimer) return
  spyTimer = setTimeout(() => { spyTimer = 0; spyLast = Date.now(); updateSpy() }, SPY_INTERVAL - since)
}

function scheduleSpy() {
  if (spyTimer) { clearTimeout(spyTimer); spyTimer = 0 }
  spyLast = 0
  onMainScroll()
}

watch([() => store.query, () => store.roots], scheduleSpy)

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
// 有标签筛选时改用「筛选后的树」，并只保留还有内容的卡片
const sourceRoots = computed(() => (store.tagFilter ? filteredRoots.value : store.roots))

const visibleRoots = computed(() =>
  sourceRoots.value.filter((r) => {
    const hasKids = (r.children || []).length > 0
    if (store.tagFilter) return hasKids
    const t = r.title || ''
    return hasKids || t.includes('书签栏') || t.includes('其他书签')
  }),
)

// 看板索引条：顶层文件夹（跟着筛选结果走，点击跳转并高亮）
const indexFolders = computed(() => {
  const out = []
  for (const r of sourceRoots.value) {
    for (const c of r.children || []) if (!c.url) out.push(c)
  }
  return out
})

// 看板索引条：与侧边栏分工，不重复 —— 侧边栏开着时它只做标签筛选；
// 侧边栏收起时才接管「顶层文件夹跳转」（层级与管理始终归侧边栏）
const showFolderChips = computed(() => !store.sidebarOpen && indexFolders.value.length > 1)

const showIndex = computed(() => !searching.value && (showFolderChips.value || tagIndex.value.length > 0))

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
  if (t.closest('.bookmark-item, .cascade-heading, .sf-row, .ws-item, .panel-head, .section-head, .context-menu, .modal, .trash-panel, .bg-panel, .detail-drawer')) return
  clearSelection()
}

// 带动作的提示（例如工作区一键开一组后的「撤销」）：先收起提示，再执行
function runToastAction() {
  const action = store.toast?.action
  store.toast = null
  if (action && typeof action.run === 'function') action.run()
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
  mainEl.value?.addEventListener('scroll', onMainScroll, { passive: true })
  nextTick(scheduleSpy)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('mousedown', onGlobalMouse, true)
  window.removeEventListener('click', onGlobalClick)
  window.removeEventListener('mousedown', marqueeMouseDown)
  window.removeEventListener('mousemove', marqueeMouseMove)
  window.removeEventListener('mouseup', marqueeMouseUp)
  mainEl.value?.removeEventListener('scroll', onMainScroll)
  if (spyTimer) clearTimeout(spyTimer)
  disposeEffects()
})
</script>

<template>
  <div
    class="app"
    :class="['layout-' + store.layoutMode, { 'app-loading': store.loading }]"
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

      <main ref="mainEl" class="main">
      <!-- 看板索引条：文件夹跳转 + 标签筛选。放在 .main-inner 之外，避免破坏其 auto-fit 网格
           （索引条一旦跨列，auto-fit 的空轨道就不再折叠，根卡片会被压成一条轨道） -->
      <nav v-if="showIndex" class="board-index">
        <div v-if="showFolderChips" class="idx-group">
          <span class="idx-label">文件夹</span>
          <div class="idx-chips">
            <button
              v-for="f in indexFolders"
              :key="f.id"
              class="idx-chip"
              type="button"
              :title="`跳转到「${f.title || '未命名'}」（侧边栏收起时才显示，层级管理用侧边栏）`"
              @click="revealNode(f.id)"
            >
              {{ f.title || '未命名' }}<span class="idx-count">{{ (f.children || []).length }}</span>
            </button>
          </div>
        </div>
        <span v-if="showFolderChips && tagIndex.length" class="idx-sep"></span>
        <div v-if="tagIndex.length" class="idx-group">
          <span class="idx-label">标签</span>
          <div class="idx-chips">
            <button
              v-for="t in tagIndex"
              :key="t.tag"
              class="idx-chip"
              :class="{ active: store.tagFilter === t.tag }"
              type="button"
              :title="store.tagFilter === t.tag ? '取消筛选' : `只看带「${t.tag}」的书签`"
              @click="setTagFilter(t.tag)"
            >
              {{ t.tag }}<span class="idx-count">{{ t.count }}</span>
            </button>
            <button v-if="store.tagFilter" class="idx-clear" type="button" @click="clearTagFilter">清除筛选</button>
          </div>
        </div>

      </nav>

      <div class="main-inner">
        <div v-if="store.loading" class="loading">加载书签中…</div>

        <SearchResults v-else-if="searching" />

        <template v-else>
          <div v-if="store.tagFilter && !visibleRoots.length" class="empty-hint board-filter-empty">
            <div class="big">没有带「{{ store.tagFilter }}」标签的书签</div>
            <div class="sub">换个标签，或<button class="link-btn" type="button" @click="clearTagFilter">清除筛选</button></div>
          </div>

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
              <FrequentSection />
              <!-- 「文件夹」小标题：给下面这块（网址网格 + 文件夹卡片）起名，本身不再列跳转胶囊 -->
              <FolderSection :root="root" />
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

    <div v-if="store.toast" class="toast" :class="{ warning: store.toast.type === 'warning', 'has-action': !!store.toast.action }">
      <span class="toast-msg">{{ store.toast.msg }}</span>
      <button
        v-if="store.toast.action"
        class="toast-action"
        type="button"
        @click="runToastAction"
      >{{ store.toast.action.label }}</button>
    </div>
  </div>
</template>
