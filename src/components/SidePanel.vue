<script setup>
import Icon from './Icon.vue'

// 侧栏里的一张小卡片：标题栏 + 自己的滚动内容区。
// 卡片不支持折叠（折叠后分隔条没有高度可分配，会变成"拖了没反应"），
// 也不支持换位（换位那套拖拽条/幽灵块/落点高亮已整体移除，两卡职责本来就固定）。
const props = defineProps({
  panelKey: { type: String, required: true },
  title: { type: String, required: true },
  count: { type: [Number, String], default: null },
  // 高度分配：'fit' = 按分隔条比例给固定高度；'fill' = 吃掉剩余
  sizing: { type: String, default: 'fill' },
})
</script>

<template>
  <section
    class="panel"
    :class="[`panel--${panelKey}`, `panel--${sizing}`]"
  >
    <header class="panel-head">
      <span class="panel-title">{{ title }}</span>
      <span v-if="count !== null && count !== ''" class="panel-count">{{ count }}</span>
      <span class="panel-actions" @click.stop @keydown.stop>
        <slot name="actions" />
      </span>
    </header>

    <div class="panel-body">
      <slot />
    </div>
  </section>
</template>
