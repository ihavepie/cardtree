<script setup>
import { reactive } from 'vue'
import { store, frequentBookmarks } from '../store.js'
import { openBookmark } from '../ui.js'
import { faviconUrl } from '../utils.js'
import Icon from './Icon.vue'

// 「常用」：按打开次数排的最常打开的网站，和「最近浏览」并排放在书签栏卡片里。
// 打开次数一直在记（recordOpen），之前只有详情抽屉读它 —— 这里让它终于有用。
// 点一下就是"带我去"，所以走前台标签（和点主区书签一致）。
const failed = reactive(new Set())
const loaded = reactive(new Set())
function onLoad(url) { loaded.add(url) }
function onError(url) { failed.add(url) }
</script>

<template>
  <section v-if="frequentBookmarks.length" class="freq-section">
    <div class="section-head">
      <span class="section-label">常用</span>
      <span class="freq-sub">按打开次数</span>
      <span class="spacer"></span>
    </div>
    <div class="freq-grid">
      <div
        v-for="f in frequentBookmarks"
        :key="f.node.id"
        class="recent-item"
        role="button"
        tabindex="0"
        :title="`打开 ${f.node.url}（已打开 ${f.count} 次）`"
        @click="openBookmark(f.node)"
        @keydown.enter.prevent="openBookmark(f.node)"
      >
        <span class="bookmark-favicon">
          <img
            v-if="!failed.has(f.node.url)"
            :class="{ ready: loaded.has(f.node.url) }"
            :src="faviconUrl(f.node.url, 32)"
            alt=""
            @load="onLoad(f.node.url)"
            @error="onError(f.node.url)"
          />
          <Icon v-if="!loaded.has(f.node.url)" name="globe" :size="14" class="favicon-globe" />
        </span>
        <span class="title">{{ f.node.title || f.node.url }}</span>
        <span class="freq-count">{{ f.count }}</span>
      </div>
    </div>
  </section>
</template>
