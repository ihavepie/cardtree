<script setup>
import { reactive } from 'vue'
import { store, clearRecent } from '../store.js'
import { faviconUrl } from '../utils.js'
import Icon from './Icon.vue'

// 「书签栏」卡片内的一个分组：标题 + 条目 + 清除
const errors = reactive(new Set())

function openItem(r) {
  if (r.url) window.open(r.url, '_blank', 'noopener')
}

function onErr(url) {
  errors.add(url)
}
</script>

<template>
  <section class="recent-section">
    <div class="section-head">
      <span class="section-label">最近浏览</span>
      <span class="spacer"></span>
      <button class="link-btn" @click="clearRecent">清除</button>
    </div>
    <div class="recent-grid">
      <div
        v-for="r in store.recent"
        :key="r.url"
        class="recent-item"
        :title="r.url"
        @click="openItem(r)"
      >
        <span class="bookmark-favicon">
          <img v-if="!errors.has(r.url)" :src="faviconUrl(r.url, 32)" alt="" @error="onErr(r.url)" />
          <Icon v-else name="globe" :size="14" class="favicon-globe" />
        </span>
        <span class="title">{{ r.title }}</span>
      </div>
    </div>
  </section>
</template>
