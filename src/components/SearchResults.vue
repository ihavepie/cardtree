<script setup>
import { computed } from 'vue'
import { store, searchResults, revealNode } from '../store.js'
import { openBookmark } from '../ui.js'
import Icon from './Icon.vue'

const query = computed(() => store.query.trim())

function openBing() {
  if (!query.value) return
  window.open(`https://www.bing.com/search?q=${encodeURIComponent(query.value)}`, '_blank', 'noopener')
}

function onClick(r) {
  if (r.isFolder) revealNode(r.id)
  else openBookmark(r)
}
</script>

<template>
  <div v-if="!searchResults.length" class="empty-hint">
    <div class="big">书签中没有匹配「{{ query }}」</div>
    <button class="btn btn-primary" style="margin-top: 14px" @click="openBing">
      🔍 用 Bing 搜索「{{ query }}」
    </button>
  </div>
  <div v-else class="search-results">
    <div class="section-head">
      <span class="section-label">搜索结果（{{ searchResults.length }}）</span>
    </div>
    <div
      v-for="r in searchResults"
      :key="r.id"
      class="search-result"
      @click="onClick(r)"
    >
      <span class="sr-icon"><Icon :name="r.isFolder ? 'folder' : 'bookmark'" :size="15" /></span>
      <div class="sr-main">
        <div class="sr-title-line">
          <span class="sr-title">{{ r.title }}</span>
          <span v-for="t in r.tags" :key="t" class="tag-chip">{{ t }}</span>
        </div>
        <div v-if="r.desc" class="sr-desc">{{ r.desc }}</div>
      </div>
      <span class="spacer" style="flex:1"></span>
      <span class="sr-path">{{ r.isFolder ? r.path : r.url }}</span>
    </div>
  </div>
</template>
