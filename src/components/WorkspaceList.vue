<script setup>
import { computed, reactive } from 'vue'
import {
  store, selectedBookmarkNodes, addSelectionToWorkspace, removeFromWorkspace,
  toggleWorkspaceExpand, openWorkspace, openWorkspaceItem, workspaceItemsOf, toast,
} from '../store.js'
import { overWorkspaceRow, onDrop } from '../drag.js'
import { menuForWorkspace, dialogNewWorkspace } from '../ui.js'
import { faviconUrl } from '../utils.js'
import Icon from './Icon.vue'

const selected = computed(() => selectedBookmarkNodes())
const selectedCount = computed(() => selected.value.length)

// 拖拽落点：当前正被悬停的那个工作区（用于行高亮 + 表头提示）
const dropWsId = computed(() => (store.dropTarget?.type === 'workspace' ? store.dropTarget.wsId : null))
const dropWsName = computed(() => store.workspaces.find((w) => w.id === dropWsId.value)?.name || '')

// 组内每个标签页的图标：先铺地球图标打底，真实图标加载成功后再淡入替换。
// 不用「img 失败才切地球」那种写法 —— 加载中/拿不到时会先露出一块空位。
const failed = reactive(new Set())
const loaded = reactive(new Set())
function onIconLoad(url) { loaded.add(url) }
function onIconError(url) { failed.add(url) }

function isExpanded(id) { return store.wsExpanded.has(id) }

function onToggle(ws) {
  if (!ws.items.length) return toast('这个工作区还是空的：先选中书签，再点它右边的「＋」', 'warning')
  toggleWorkspaceExpand(ws.id)
}

function onOpenAll(ws, e) {
  e.stopPropagation()
  openWorkspace(ws.id)
}

// 「＋」把当前选中的书签加进来（反馈文案在 store 里，和"拖进来"共用一套）
function onAdd(ws, e) {
  e.stopPropagation()
  addSelectionToWorkspace(ws.id)
}

// 行 = 拖拽落点：dragover 时高亮并接管落点，drop 时把书签/文件夹登记进这一组
function onRowOver(ws, e) {
  overWorkspaceRow(e, ws.id)
}

function onMore(ws, e) {
  e.stopPropagation()
  const rect = e.currentTarget.getBoundingClientRect()
  menuForWorkspace(ws, rect.right, rect.bottom)
}

// 右键也能出同一个菜单（和文件夹行保持一致的习惯）
function onContextMenu(ws, e) {
  e.preventDefault()
  e.stopPropagation()
  menuForWorkspace(ws, e.clientX, e.clientY)
}

function onRemove(ws, item, e) {
  e.stopPropagation()
  // 传整个条目（而不是 item.url）：书签改过网址时按 id 也能移除，见 store.removeFromWorkspace
  if (removeFromWorkspace(ws.id, item)) toast(`已从「${ws.name}」移除`)
}

// 条目按 id 取**当前**书签（改名/改址会跟着变）；书签被删则退回保存时的快照
function itemsOf(ws) {
  return workspaceItemsOf(ws)
}
</script>

<template>
  <div v-if="!store.workspaces.length" class="ws-empty">
    <span class="ws-empty-icon"><Icon name="layers" :size="14" /></span>
    把常一起打开的网站攒成一组，<br />点一下就能全部打开。
    <button class="link-btn" type="button" @click="dialogNewWorkspace()">＋ 新建工作区</button>
  </div>

  <div v-for="ws in store.workspaces" :key="ws.id" class="ws-item">
    <div
      class="ws-row"
      :class="{ open: isExpanded(ws.id), empty: !ws.items.length, 'drop-inside': dropWsId === ws.id }"
      role="button"
      tabindex="0"
      data-droppable
      :title="ws.items.length
        ? (isExpanded(ws.id) ? `收起「${ws.name}」的标签页` : `展开「${ws.name}」看 ${ws.items.length} 个标签页`)
        : `「${ws.name}」还是空的`"
      @click="onToggle(ws)"
      @keydown.enter.prevent="onToggle(ws)"
      @keydown.space.prevent="onToggle(ws)"
      @contextmenu="onContextMenu(ws, $event)"
      @dragover="onRowOver(ws, $event)"
      @drop="onDrop"
    >
      <span class="ws-chev">
        <Icon :name="isExpanded(ws.id) ? 'chevron-down' : 'chevron-right'" :size="14" />
      </span>
      <span class="ws-icon"><Icon :name="ws.icon" :size="16" /></span>
      <span class="ws-name">{{ ws.name }}</span>

      <span class="ws-slot">
        <span class="ws-count" :class="{ zero: !ws.items.length }">{{ ws.items.length }}</span>
        <span class="ws-actions">
          <button
            class="ws-act"
            type="button"
            :title="ws.items.length ? `全部打开（${ws.items.length} 个后台标签）` : '这个工作区还是空的'"
            @click="onOpenAll(ws, $event)"
          >
            <Icon name="external" :size="14" />
          </button>
          <button
            class="ws-act"
            type="button"
            :title="selectedCount ? `把选中的 ${selectedCount} 个书签加进来（选中文件夹会连里面的书签一起加）` : '先在主区选中书签或文件夹，再加进来'"
            @click="onAdd(ws, $event)"
          >
            <Icon name="plus" :size="14" />
          </button>
          <button class="ws-act" type="button" title="更多操作" @click="onMore(ws, $event)">
            <Icon name="more" :size="14" />
          </button>
        </span>
      </span>
    </div>

    <!-- 展开后逐个列出组内的标签页：单击某一个 = 只开这一个 -->
    <div class="ws-body" :class="{ open: isExpanded(ws.id) }">
      <div class="ws-body-inner">
        <p v-if="!itemsOf(ws).length" class="ws-tab-empty">还没有标签页</p>
        <div
          v-for="it in itemsOf(ws)"
          :key="it.key"
          class="ws-tab"
          :class="{ missing: it.missing }"
          role="button"
          tabindex="0"
          :title="it.missing ? `原书签已删除，用的是保存时的链接：${it.url}` : `在新标签页（后台）打开 ${it.url}`"
          @click="openWorkspaceItem(it)"
          @keydown.enter.prevent="openWorkspaceItem(it)"
        >
          <span class="ws-tab-fav">
            <img
              v-if="!failed.has(it.url)"
              :class="{ ready: loaded.has(it.url) }"
              :src="faviconUrl(it.url, 32)"
              alt=""
              @load="onIconLoad(it.url)"
              @error="onIconError(it.url)"
            />
            <Icon v-if="!loaded.has(it.url)" name="globe" :size="12" class="ws-tab-globe" />
          </span>
          <span class="ws-tab-name">{{ it.title }}</span>
          <span v-if="it.missing" class="ws-tab-gone" title="原书签已删除，用的是保存时的链接">已删除</span>
          <button
            class="ws-tab-x"
            type="button"
            title="从这个工作区移除（不会删书签）"
            @click="onRemove(ws, it, $event)"
          >✕</button>
        </div>
      </div>
    </div>
  </div>
</template>
