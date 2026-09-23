<script setup>
import BookmarkItem from './BookmarkItem.vue'

defineProps({
  parentId: { type: String, required: true },
  nodes: { type: Array, required: true },
})
</script>

<template>
  <div class="bookmark-grid">
    <BookmarkItem
      v-for="n in nodes"
      :key="n.id"
      :node="n"
      :parent-id="parentId"
    />
  </div>
</template>
