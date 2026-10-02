<script setup>
import { computed, ref, watch, onMounted } from 'vue'
import {
  store, setPanelSplit, ensureSidebarFocus,
  isCollapsed, toggleCollapse, select, revealNode, setSidebarFocus,
} from '../store.js'
import { dialogNewWorkspace, menuForNode } from '../ui.js'
import SidePanel from './SidePanel.vue'
import SidebarFolder from './SidebarFolder.vue'
import WorkspaceList from './WorkspaceList.vue'
import Icon from './Icon.vue'

const sidebarEl = ref(null)

const sidebarStyle = computed(() => ({
  ...(store.sidebarOpen ? { width: store.sidebarWidth + 'px' } : null),
  // 上面那张卡的高度比例，由拖动分隔条决定
  '--panel-split': String(store.panelSplit),
}))

const dragging = computed(() => !!store.dragging)
const dragCount = computed(() => store.dragging?.count || 0)
// 拖拽正悬停在工作区行上：表头把「＋ 新建」换成投放提示（和文件夹卡一套语言）
const overWorkspace = computed(() => store.dropTarget?.type === 'workspace')

// ---- 侧栏树的键盘导航 ----
// 行是递归组件，所以统一在这一层按 DOM 顺序处理方向键。
// 只在**可见**的行之间移动：折叠的子树仍在 DOM 里（靠 0fr 裁掉），不应被焦点走到。
// 注意：不要用 template ref 取这个容器 —— 若把 ref 写在 <template v-for> 里，Vue 会收成数组。
function visibleRows() {
  const list = sidebarEl.value?.querySelector('.sidebar-list')
  if (!list) return []
  return [...list.querySelectorAll('.sf-row')].filter((row) => {
    let p = row.parentElement
    while (p && p !== list) {
      if (p.classList.contains('sf-body') && !p.classList.contains('open')) return false
      p = p.parentElement
    }
    return true
  })
}

function focusRow(row) {
  if (!row) return
  setSidebarFocus(row.dataset.id)
  row.focus()
}

function firstChildRow(row) {
  return row.closest('.sf')?.querySelector('.sf-body-inner > .sf > .sf-row') || null
}

function parentRow(row) {
  const parentSf = row.closest('.sf')?.parentElement?.closest('.sf')
  return parentSf ? parentSf.querySelector(':scope > .sf-row') : null
}

// Shift+F10 / 菜单键：把这一行的右键菜单开出来（键盘也能用到全部行操作）
function menuForRow(id, row) {
  const node = store.nodesMap.get(id)
  if (!node) return
  select(id, {})
  const r = row.getBoundingClientRect()
  menuForNode(node, r.left + 24, r.bottom)
}

function onTreeKeydown(e) {
  const rows = visibleRows()
  const i = rows.indexOf(document.activeElement)
  if (i === -1) return
  const row = rows[i]
  const id = row.dataset.id
  const hasKids = row.getAttribute('aria-expanded') !== null
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); focusRow(rows[i + 1]); break
    case 'ArrowUp': e.preventDefault(); focusRow(rows[i - 1]); break
    case 'Home': e.preventDefault(); focusRow(rows[0]); break
    case 'End': e.preventDefault(); focusRow(rows[rows.length - 1]); break
    case 'ArrowRight':
      e.preventDefault()
      // 有子项：收起 → 展开；已展开 → 进第一个子项
      if (hasKids) {
        if (isCollapsed(id)) toggleCollapse(id)
        else focusRow(firstChildRow(row))
      }
      break
    case 'ArrowLeft':
      e.preventDefault()
      // 已展开 → 收起；否则 → 跳回父级
      if (hasKids && !isCollapsed(id)) toggleCollapse(id)
      else focusRow(parentRow(row))
      break
    case 'Enter':
    case ' ':
      e.preventDefault()
      select(id, {})
      revealNode(id)
      break
    case 'ContextMenu':
      e.preventDefault()
      menuForRow(id, row)
      break
    case 'F10':
      if (e.shiftKey) { e.preventDefault(); menuForRow(id, row) }
      break
    default:
      break
  }
}

// 焦点 id 失效时回落到第一个根文件夹，否则整棵树都没有 tabindex=0，键盘就进不来
onMounted(ensureSidebarFocus)
watch(() => [store.sidebarFocusId, store.roots.length], ensureSidebarFocus)

// ---- 拖动分隔条调高度 ----
function onSplitStart(e) {
  e.preventDefault()
  const el = sidebarEl.value
  if (!el) return
  const total = el.getBoundingClientRect().height
  if (!total) return
  const startY = e.clientY
  const startSplit = store.panelSplit
  document.body.classList.add('is-resizing-panel')
  const move = (ev) => setPanelSplit(startSplit + (ev.clientY - startY) / total)
  const up = () => {
    document.body.classList.remove('is-resizing-panel')
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
</script>

<template>
  <aside
    ref="sidebarEl"
    class="sidebar"
    :class="{ hidden: !store.sidebarOpen, dragging }"
    :style="sidebarStyle"
  >
    <!-- 不再显示工作区数量徽标：表头只留「＋ 新建」（用户：那个数字不要了） -->
    <SidePanel panel-key="workspaces" title="工作区" sizing="fit">
      <template #actions>
        <span v-if="overWorkspace" class="panel-hint">松手加进 {{ dragCount }} 项</span>
        <button
          v-else
          class="panel-act panel-act--text"
          type="button"
          title="新建工作区"
          @click="dialogNewWorkspace()"
        >
          <Icon name="plus" :size="13" />
          <span>新建</span>
        </button>
      </template>
      <WorkspaceList />
    </SidePanel>

    <div
      class="sidebar-splitter active"
      title="拖动调整上下两张卡片的高度"
      @mousedown="onSplitStart"
    ></div>

    <SidePanel panel-key="folders" title="文件夹" sizing="fill">
      <template #actions>
        <span v-if="dragging" class="panel-hint">松手移入 {{ dragCount }}</span>
      </template>
      <div
        class="sidebar-list"
        role="tree"
        aria-label="文件夹"
        @keydown="onTreeKeydown"
      >
        <SidebarFolder
          v-for="r in store.roots"
          :key="r.id"
          :node="r"
          :depth="0"
        />
      </div>
    </SidePanel>
  </aside>
</template>
