<script setup>
import { computed } from 'vue'
import { store, isCollapsed, toggleCollapse, select, isTopSelected, revealNode, getFolderIcon, getFolderIconColor } from '../store.js'
import { FOLDER_ICONS } from '../folder-icons.js'
import Icon from './Icon.vue'
import { overGrid, onDrop, endDrag } from '../drag.js'
import { menuForNode } from '../ui.js'

defineOptions({ name: 'SidebarFolder' })

const props = defineProps({
  node: { type: Object, required: true },
  depth: { type: Number, default: 0 },
})

const folders = computed(() => (props.node.children || []).filter((c) => !c.url))
const count = computed(() => (props.node.children || []).length)
const hasKids = computed(() => (props.node.children || []).length > 0)
const open = computed(() => !isCollapsed(props.node.id))
const selected = computed(() => isTopSelected(props.node.id))
const iconName = computed(() => {
  const n = getFolderIcon(props.node.id)
  return n && FOLDER_ICONS.includes(n) ? n : 'folder'
})
const iconColor = computed(() => getFolderIconColor(props.node.id))

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
</script>

<template>
  <div class="sf" :style="{ paddingLeft: (depth * 13) + 'px' }">
    <div
      class="sf-row"
      :class="{ selected }"
      :data-depth="depth"
      data-droppable
      @click="onClick"
      @dragover="overGrid($event, node.id)"
      @drop="onDrop"
      @dragend="endDrag"
      @contextmenu="onContextMenu"
    >
      <button
        v-if="hasKids"
        class="sf-chev"
        type="button"
        @click.stop="onToggle"
      >
        <Icon :name="open ? 'chevron-down' : 'chevron-right'" :size="14" />
      </button>
      <span v-else class="sf-chev"></span>

      <span class="sf-icon" :style="iconColor ? { color: iconColor } : undefined"><Icon :name="iconName" :size="16" /></span>
      <span class="sf-name">{{ node.title || '未命名' }}</span>
      <span class="sf-count">{{ count }}</span>
    </div>

    <div v-if="folders.length" class="sf-body" :class="{ open }">
      <div class="sf-body-inner">
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
