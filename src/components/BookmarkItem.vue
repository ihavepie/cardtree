<script setup>
import { computed, ref, watch } from 'vue'
import { store, isTopSelected, select, topLevelSelection } from '../store.js'
import { startDrag, overBookmark, onDrop, endDrag } from '../drag.js'
import { openBookmark, menuForNode } from '../ui.js'
import { faviconUrl, elTitle } from '../utils.js'
import Icon from './Icon.vue'

const props = defineProps({
  node: { type: Object, required: true },
  parentId: { type: String, required: true },
})

const imgError = ref(false)
watch(() => props.node.url, () => { imgError.value = false })
const selected = computed(() => isTopSelected(props.node.id))
const focused = computed(() => store.focusId === props.node.id)

function onClick(e) {
  select(props.node.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
}

function onDblClick(e) {
  e.preventDefault()
  openBookmark(props.node)
}

function onContextMenu(e) {
  e.preventDefault()
  e.stopPropagation()
  if (!selected.value) select(props.node.id)
  menuForNode(props.node, e.clientX, e.clientY)
}

function onDragStart(e) {
  if (!selected.value) select(props.node.id)
  startDrag(e, topLevelSelection())
}
</script>

<template>
  <div
    class="bookmark-item"
    :class="{ selected, focused }"
    :data-id="node.id"
    :title="elTitle(node.title, node.url)"
    draggable="true"
    data-droppable
    @click="onClick"
    @dblclick="onDblClick"
    @contextmenu="onContextMenu"
    @dragstart="onDragStart"
    @dragover.stop="overBookmark($event, { parentId, refId: node.id })"
    @drop.stop="onDrop"
    @dragend="endDrag"
  >
    <span class="bookmark-favicon">
      <img v-if="!imgError" class="fav-img" :src="faviconUrl(node.url, 32)" alt="" @error="imgError = true" />
      <Icon v-else name="globe" :size="14" class="favicon-globe" />
    </span>
    <span class="bookmark-title">{{ node.title }}</span>
  </div>
</template>
