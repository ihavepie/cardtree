<script setup>
import { computed } from 'vue'
import { store } from '../store.js'

// 卡片里的第三个小标题：「文件夹」。
// 注意它现在**只是标题**，下面直接就是网址网格 + 文件夹卡片 —— 它给那一块起名。
// （曾经这里还列过一排"点一下跳过去"的文件夹胶囊，用户要求去掉：和下面那排文件夹卡片重复了。
//   跳转能力没丢：侧栏收起时主区顶部那条看板索引条里仍然有文件夹胶囊。）
const props = defineProps({
  root: { type: Object, required: true },
})

const hasContent = computed(() => (props.root.children || []).length > 0)
</script>

<template>
  <section v-if="hasContent" class="folder-section">
    <div class="section-head">
      <span class="section-label">文件夹</span>
      <span class="spacer"></span>
    </div>
  </section>
</template>
