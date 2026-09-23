<script setup>
import { computed } from 'vue'
import { store } from '../store.js'
import SidebarFolder from './SidebarFolder.vue'

const sidebarStyle = computed(() =>
  store.sidebarOpen ? { width: store.sidebarWidth + 'px' } : null,
)
</script>

<template>
  <aside class="sidebar" :class="{ hidden: !store.sidebarOpen }" :style="sidebarStyle">
    <div class="sidebar-head">
      <span class="sidebar-title">文件夹</span>
    </div>
    <div class="sidebar-list">
      <SidebarFolder
        v-for="r in store.roots"
        :key="r.id"
        :node="r"
        :depth="0"
      />
    </div>
  </aside>
</template>
