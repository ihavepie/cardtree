<script setup>
import { computed } from 'vue'
import { store, isCollapsed, toggleCollapse, select, isTopSelected, topLevelSelection } from '../store.js'
import { startDrag, overFolder, onDrop, endDrag } from '../drag.js'
import { menuForNode } from '../ui.js'
import BookmarkGrid from './BookmarkGrid.vue'
import Icon from './Icon.vue'

const props = defineProps({
  node: { type: Object, required: true },
})

const collapsed = computed(() => isCollapsed(props.node.id))
const bookmarks = computed(() => (props.node.children || []).filter((c) => c.url))
const folders = computed(() => (props.node.children || []).filter((c) => !c.url))
const count = computed(() => (props.node.children || []).length)
const isDropInside = computed(
  () =>
    store.dropTarget?.type === 'inside' &&
    store.dropTarget.folderId === props.node.id,
)
const selected = computed(() => isTopSelected(props.node.id))

function onHeadingClick(e) {
  select(props.node.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
}

function onHeadingDblClick() {
  toggleCollapse(props.node.id)
}

function onContextMenu(e) {
  e.preventDefault()
  e.stopPropagation()
  menuForNode(props.node, e.clientX, e.clientY)
}

function onDragStart(e) {
  if (!store.selection.has(props.node.id)) select(props.node.id)
  startDrag(e, topLevelSelection())
}
</script>

<template>
  <div class="cascade-node" :class="{ 'is-collapsed': collapsed }" :data-id="node.id">
    <div
      class="cascade-card"
      data-droppable
      :class="{ 'drop-inside': isDropInside, focused: store.focusId === node.id, selected }"
      @dragover="overFolder($event, node.id)"
      @drop="onDrop"
      @dragend="endDrag"
      @contextmenu="onContextMenu"
    >
      <div
        class="cascade-heading"
        draggable="true"
        @dragstart="onDragStart"
        @click="onHeadingClick"
        @dblclick="onHeadingDblClick"
      >
        <button
          class="cascade-toggle"
          type="button"
          draggable="false"
          title="折叠 / 展开"
          @click.stop="toggleCollapse(node.id)"
        >
          <span class="chev"><Icon :name="collapsed ? 'chevron-right' : 'chevron-down'" :size="14" /></span>
        </button>
        <span class="cascade-title">
          <svg class="folder-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h3.6l1.8 1.8H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
          </svg>
          <span class="cascade-title-text">{{ node.title || '未命名' }}</span>
        </span>
        <span class="cascade-dash"></span>
        <span class="cascade-badge">{{ count }}</span>
        <span class="cascade-handle" title="拖拽整理"><Icon name="grip" :size="14" /></span>
      </div>

      <div class="cascade-body">
        <div class="cascade-body-inner">
          <BookmarkGrid v-if="bookmarks.length" :parent-id="node.id" :nodes="bookmarks" />
          <div v-if="folders.length" class="cascade-children">
            <CascadeNode v-for="f in folders" :key="f.id" :node="f" />
          </div>
          <div v-if="!bookmarks.length && !folders.length" class="empty-hint">
            <span class="sub">空文件夹</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
