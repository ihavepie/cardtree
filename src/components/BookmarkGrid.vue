<script setup>
import { computed } from 'vue'
import { store, isGridExpanded, toggleGridExpanded, PREVIEW_COUNT } from '../store.js'
import BookmarkItem from './BookmarkItem.vue'

const props = defineProps({
  parentId: { type: String, required: true },
  nodes: { type: Array, required: true },
})

// 默认只显示前 PREVIEW_COUNT 个，避免文件夹一多就把卡片拉得很长；
// 超出部分收成一条「展开全部 N 个」，展开状态按文件夹记住。
const expanded = computed(() => isGridExpanded(props.parentId))
const hiddenCount = computed(() => Math.max(0, props.nodes.length - PREVIEW_COUNT))
const visible = computed(() =>
  expanded.value || !hiddenCount.value ? props.nodes : props.nodes.slice(0, PREVIEW_COUNT),
)
</script>

<template>
  <div class="bookmark-grid">
    <BookmarkItem
      v-for="n in visible"
      :key="n.id"
      :node="n"
      :parent-id="parentId"
    />
    <button
      v-if="hiddenCount"
      class="grid-more"
      type="button"
      :title="expanded ? '收起，只显示前 ' + PREVIEW_COUNT + ' 个' : '展开显示全部 ' + nodes.length + ' 个'"
      @click.stop="toggleGridExpanded(parentId)"
    >
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path v-if="expanded" d="M6 15l6-6 6 6" />
        <path v-else d="M6 9l6 6 6-6" />
      </svg>
      <span>{{ expanded ? '收起' : `展开全部 ${nodes.length} 个` }}</span>
    </button>
  </div>
</template>
