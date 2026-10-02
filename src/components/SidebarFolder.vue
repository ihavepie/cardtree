<script setup>
import { computed } from 'vue'
import { store, isCollapsed, toggleCollapse, select, isTopSelected, revealNode, getFolderIcon, getFolderIconColor, setSidebarFocus } from '../store.js'
import { FOLDER_ICONS } from '../folder-icons.js'
import Icon from './Icon.vue'
import { overSidebarRow, onDrop, endDrag, invalidFolderTarget } from '../drag.js'
import { menuForNode, dialogNewBookmark } from '../ui.js'

defineOptions({ name: 'SidebarFolder' })

const props = defineProps({
  node: { type: Object, required: true },
  depth: { type: Number, default: 0 },
})

const folders = computed(() => (props.node.children || []).filter((c) => !c.url))
const count = computed(() => (props.node.children || []).length)
const hasKids = computed(() => (props.node.children || []).length > 0)
// 拖拽期间整棵树强制展开（store.dragExpandAll）：否则悬停某行的自动展开会把下面的行推走，
// 你要投的那一行会在等待中漂移。拖完即恢复各自的折叠状态。
const open = computed(() => store.dragExpandAll || !isCollapsed(props.node.id))
const selected = computed(() => isTopSelected(props.node.id))
const iconName = computed(() => {
  const n = getFolderIcon(props.node.id)
  return n && FOLDER_ICONS.includes(n) ? n : 'folder'
})
const iconColor = computed(() => getFolderIconColor(props.node.id))

// 键盘：roving tabindex —— 整棵树只有一行 tabindex=0，其余 -1，由方向键在行间移动
const tabbable = computed(() => store.sidebarFocusId === props.node.id)
// 滚动联动：主区正在看的文件夹，在侧栏里标一条强调条
const spy = computed(() => store.spyId === props.node.id)

// 拖拽中的落点反馈：命中高亮，非法目标（自己/后代）整行变灰
const dropInside = computed(
  () => store.dropTarget?.type === 'inside' && store.dropTarget.folderId === props.node.id,
)
const dropInvalid = computed(() => !!store.dragging && invalidFolderTarget(props.node.id))

function onClick(e) {
  const ctrl = e.ctrlKey || e.metaKey
  const shift = e.shiftKey
  select(props.node.id, { ctrl, shift })
  if (!ctrl && !shift) revealNode(props.node.id)
}

function onToggle(e) {
  e.stopPropagation()
  toggleCollapse(props.node.id)
}

function onContextMenu(e) {
  e.preventDefault()
  e.stopPropagation()
  if (!selected.value) select(props.node.id)
  menuForNode(props.node, e.clientX, e.clientY)
}

function onFocus() {
  if (store.sidebarFocusId !== props.node.id) setSidebarFocus(props.node.id)
}

function onNewBookmark(e) {
  e.stopPropagation()
  dialogNewBookmark(props.node.id)
}

function onMore(e) {
  e.stopPropagation()
  const rect = e.currentTarget.getBoundingClientRect()
  menuForNode(props.node, rect.right, rect.bottom)
}
</script>

<template>
  <div class="sf" :style="{ paddingLeft: (depth * 13) + 'px' }">
    <div
      class="sf-row"
      :class="{ selected, spy, 'drop-inside': dropInside, 'drop-invalid': dropInvalid }"
      :data-depth="depth"
      :data-id="node.id"
      data-droppable
      role="treeitem"
      :aria-level="depth + 1"
      :aria-selected="selected ? 'true' : 'false'"
      :aria-expanded="hasKids ? (open ? 'true' : 'false') : null"
      :tabindex="tabbable ? 0 : -1"
      @click="onClick"
      @focus="onFocus"
      @dragover="overSidebarRow($event, node.id)"
      @drop="onDrop"
      @dragend="endDrag"
      @contextmenu="onContextMenu"
    >
      <button
        v-if="hasKids"
        class="sf-chev"
        type="button"
        tabindex="-1"
        :title="open ? '收起' : '展开'"
        @click.stop="onToggle"
      >
        <Icon :name="open ? 'chevron-down' : 'chevron-right'" :size="14" />
      </button>
      <span v-else class="sf-chev"></span>

      <span class="sf-icon" :style="iconColor ? { color: iconColor } : undefined"><Icon :name="iconName" :size="16" /></span>
      <span class="sf-name">{{ node.title || '未命名' }}</span>

      <!-- 计数与 hover 动作共用一个固定宽度的槽：宽度不变，切换时名字不抖、也不会有文字透到按钮底下 -->
      <span class="sf-slot">
        <span class="sf-count">{{ count }}</span>
        <span class="sf-actions">
          <button
            class="sf-act"
            type="button"
            tabindex="-1"
            title="在此文件夹新建书签"
            @click="onNewBookmark"
          >
            <Icon name="plus" :size="14" />
          </button>
          <button
            class="sf-act"
            type="button"
            tabindex="-1"
            title="更多操作（重命名 / 移动 / 删除…）"
            @click="onMore"
          >
            <Icon name="more" :size="14" />
          </button>
        </span>
      </span>
    </div>

    <div v-if="folders.length" class="sf-body" :class="{ open }">
      <div class="sf-body-inner" role="group">
        <SidebarFolder
          v-for="f in folders"
          :key="f.id"
          :node="f"
          :depth="depth + 1"
        />
      </div>
    </div>
  </div>
</template>
