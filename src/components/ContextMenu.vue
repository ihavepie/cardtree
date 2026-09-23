<script setup>
import { ref, onMounted, nextTick } from 'vue'
import { store } from '../store.js'
import { closeMenu } from '../ui.js'
import Icon from './Icon.vue'

const menuRef = ref(null)

function clampPos() {
  const el = menuRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const x = Math.max(8, Math.min(store.contextMenu.x, window.innerWidth - r.width - 8))
  const y = Math.max(8, Math.min(store.contextMenu.y, window.innerHeight - r.height - 8))
  el.style.left = x + 'px'
  el.style.top = y + 'px'
}

function run(it) {
  closeMenu()
  if (it.action) it.action()
}

onMounted(() => nextTick(clampPos))
</script>

<template>
  <div class="context-menu" ref="menuRef" role="menu" @contextmenu.prevent>
    <template v-for="(it, i) in store.contextMenu.items" :key="i">
      <div v-if="it.separator" class="context-menu-separator"></div>
      <div
        v-else
        class="context-menu-item"
        :class="{ danger: it.danger, disabled: it.disabled }"
        @click="run(it)"
      >
        <span v-if="it.icon" class="mi-icon"><Icon :name="it.icon" :size="15" /></span>
        <span>{{ it.label }}</span>
      </div>
    </template>
  </div>
</template>
