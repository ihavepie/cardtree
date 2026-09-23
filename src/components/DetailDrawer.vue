<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { store, nodeById, topLevelSelection, getMeta, setMeta, clearSelection, pathOf, trashNodes, select, revealNode, renameNode, toast } from '../store.js'
import { openBookmark, copyText, dialogEditBookmark } from '../ui.js'
import { domainOf, fetchPageDescription, faviconUrl } from '../utils.js'
import Icon from './Icon.vue'

const desc = ref('')
const tags = ref('')
const imgError = ref(false)
const fetchingDesc = ref(false)

const editingTitle = ref(false)
const editingUrl = ref(false)
const titleDraft = ref('')
const urlDraft = ref('')
const titleInputRef = ref(null)
const urlInputRef = ref(null)

// 仅当「恰好选中一个书签」时显示右侧抽屉
const node = computed(() => {
  const sel = topLevelSelection()
  if (sel.length !== 1) return null
  const n = nodeById(sel[0])
  return n && n.url ? n : null
})

const domain = computed(() => (node.value ? domainOf(node.value.url) : ''))
const tagList = computed(() => tags.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean))

const addedAt = computed(() => {
  const ts = node.value?.dateAdded
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
})
const parentPath = computed(() => {
  if (!node.value) return '—'
  return pathOf(node.value.id).slice(0, -1).join(' / ') || '—'
})

const stats = computed(() => (node.value ? store.nodeStats[node.value.id] : null))
const openCount = computed(() => stats.value?.count ?? 0)
const lastOpen = computed(() => fmtTime(stats.value?.lastOpenedAt))

const sameDomain = computed(() => {
  if (!node.value) return []
  const dom = domainOf(node.value.url)
  if (!dom) return []
  return store.flatList
    .filter((n) => n.url && n.id !== node.value.id && domainOf(n.url) === dom)
    .slice(0, 5)
})

const randomRelated = computed(() => {
  if (!node.value) return []
  const shown = new Set([node.value.id, ...sameDomain.value.map((n) => n.id)])
  const pool = store.flatList.filter((n) => n.url && !shown.has(n.id))
  const arr = [...pool]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.slice(0, 4)
})

function fmtTime(ts) {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 60e3) return '刚刚'
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前'
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前'
  if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前'
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function jumpTo(id) {
  select(id)
  revealNode(id)
}

watch(
  () => node.value?.id,
  async (id) => {
    imgError.value = false
    if (id) {
      const m = getMeta(id)
      desc.value = m?.desc || ''
      tags.value = (m?.tags || []).join(', ')
    } else {
      desc.value = ''
      tags.value = ''
    }
  },
  { immediate: true },
)

function save() {
  const id = node.value?.id
  if (!id) return
  setMeta(id, { desc: desc.value, tags: tags.value })
  toast('已保存描述与标签')
}

function open() {
  if (node.value) openBookmark(node.value)
}

function edit() {
  if (node.value) dialogEditBookmark(node.value)
}

function copy() {
  if (node.value) copyText(node.value.url)
}

function startEditTitle() {
  if (!node.value) return
  editingUrl.value = false
  titleDraft.value = node.value.title || ''
  editingTitle.value = true
  store.editingNodeId = node.value.id
  nextTick(() => titleInputRef.value?.focus())
}
function commitTitle() {
  if (!node.value || !editingTitle.value) return
  const t = titleDraft.value.trim()
  editingTitle.value = false
  setTimeout(() => { store.editingNodeId = null }, 100)
  if (t && t !== node.value.title) renameNode(node.value.id, t).catch(() => {})
}
function startEditUrl() {
  if (!node.value) return
  editingTitle.value = false
  urlDraft.value = node.value.url || ''
  editingUrl.value = true
  store.editingNodeId = node.value.id
  nextTick(() => urlInputRef.value?.focus())
}
function commitUrl() {
  if (!node.value || !editingUrl.value) return
  const u = urlDraft.value.trim()
  editingUrl.value = false
  setTimeout(() => { store.editingNodeId = null }, 100)
  if (u && u !== node.value.url) renameNode(node.value.id, node.value.title, u).catch(() => {})
}
function cancelEdit() {
  editingTitle.value = false
  editingUrl.value = false
  store.editingNodeId = null
}

async function remove() {
  if (node.value) await trashNodes([node.value.id])
}

async function autoDesc() {
  const url = node.value?.url
  if (!url || fetchingDesc.value) return
  fetchingDesc.value = true
  try {
    const d = await fetchPageDescription(url)
    if (d) {
      desc.value = d
      toast('已获取描述')
    } else {
      toast('未找到网页描述', 'warning')
    }
  } catch (err) {
    console.warn('[cardtree] 获取描述失败', url, err)
    if (err?.name === 'AbortError') {
      toast('获取描述超时', 'warning')
    } else if (err?.message === 'Failed to fetch') {
      toast('无法访问该网页：请在扩展详情里允许「读取网站数据」', 'warning')
    } else {
      toast('获取描述失败：' + (err?.message || '网络错误'), 'warning')
    }
  } finally {
    fetchingDesc.value = false
  }
}
</script>

<template>
  <transition name="drawer">
    <aside v-if="node" class="detail-drawer">
      <div class="dd-head">
        <span class="dd-favicon">
          <img v-if="!imgError" :src="faviconUrl(node.url, 32)" alt="" @error="imgError = true" />
          <Icon v-else name="globe" :size="16" class="favicon-globe" />
        </span>
        <div class="dd-title-box">
          <input
            v-if="editingTitle"
            ref="titleInputRef"
            v-model="titleDraft"
            class="dd-inline-input dd-title-input"
            @keydown.enter="commitTitle"
            @keydown.esc="cancelEdit"
            @blur="commitTitle"
          />
          <div v-else class="dd-title" title="双击修改名称" @dblclick="startEditTitle">{{ node.title || '未命名' }}</div>
          <div class="dd-domain">{{ domain }}</div>
        </div>
        <button class="icon-btn" title="关闭" @click="clearSelection">✕</button>
      </div>

      <input
        v-if="editingUrl"
        ref="urlInputRef"
        v-model="urlDraft"
        class="dd-inline-input"
        @keydown.enter="commitUrl"
        @keydown.esc="cancelEdit"
        @blur="commitUrl"
      />
      <div v-else class="dd-url" tabindex="0" title="单击复制 · 双击修改网址" @click="copy" @dblclick="startEditUrl">
        <span class="dd-url-text">{{ node.url }}</span>
        <Icon name="link" :size="13" class="dd-url-copy" />
      </div>

      <div class="dd-meta">
        <div class="dd-meta-item">
          <span class="dd-meta-label"><Icon name="bookmark" :size="12" /> 添加日期</span>
          <span class="dd-meta-value">{{ addedAt }}</span>
        </div>
        <div class="dd-meta-item">
          <span class="dd-meta-label"><Icon name="folder" :size="12" /> 所在文件夹</span>
          <span class="dd-meta-value">{{ parentPath }}</span>
        </div>
        <div class="dd-meta-item">
          <span class="dd-meta-label"><Icon name="open" :size="12" /> 打开次数</span>
          <span class="dd-meta-value">{{ openCount }}</span>
        </div>
        <div class="dd-meta-item">
          <span class="dd-meta-label"><Icon name="clock" :size="12" /> 最近访问</span>
          <span class="dd-meta-value">{{ lastOpen }}</span>
        </div>
      </div>

      <div class="dd-label-row">
        <label class="dd-label"><Icon name="edit" :size="12" /> 描述</label>
        <button class="dd-auto" :disabled="fetchingDesc" @click="autoDesc">
          <Icon :class="{ spinning: fetchingDesc }" name="refresh" :size="12" />
          {{ fetchingDesc ? '获取中…' : '自动获取' }}
        </button>
      </div>
      <textarea v-model="desc" class="dd-textarea" rows="5" placeholder="一句话说明这个网址"></textarea>

      <div class="dd-label-row">
        <label class="dd-label"><Icon name="tag" :size="12" /> 标签</label>
      </div>
      <input v-model="tags" class="dd-input" placeholder="逗号分隔，如：设计, 灵感" @keydown.enter="save" />
      <div v-if="tagList.length" class="dd-tags">
        <span v-for="t in tagList" :key="t" class="tag-chip">{{ t }}</span>
      </div>

      <div v-if="sameDomain.length || randomRelated.length" class="dd-related">
        <div v-if="sameDomain.length" class="dd-related-group">
          <div class="dd-label-row">
            <label class="dd-label"><Icon name="link" :size="12" /> 同域名书签</label>
            <span class="dd-count">{{ sameDomain.length }}</span>
          </div>
          <div class="dd-related-list">
            <button
              v-for="r in sameDomain"
              :key="r.id"
              class="dd-related-item"
              :title="r.url"
              @click="jumpTo(r.id)"
            >
              <span class="dd-rel-avatar">
                <img class="dd-rel-img" :src="faviconUrl(r.url, 32)" alt="" @error="$event.target.remove()" />
              </span>
              <span class="dd-related-title">{{ r.title }}</span>
            </button>
          </div>
        </div>

        <div v-if="randomRelated.length" class="dd-related-group">
          <div class="dd-label-row">
            <label class="dd-label"><Icon name="shuffle" :size="12" /> 随机发现</label>
          </div>
          <div class="dd-related-list">
            <button
              v-for="r in randomRelated"
              :key="r.id"
              class="dd-related-item"
              :title="r.url"
              @click="jumpTo(r.id)"
            >
              <span class="dd-rel-avatar">
                <img class="dd-rel-img" :src="faviconUrl(r.url, 32)" alt="" @error="$event.target.remove()" />
              </span>
              <span class="dd-related-title">{{ r.title }}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="dd-actions">
        <button class="btn" @click="open"><Icon name="open" :size="14" /> 打开</button>
        <button class="btn" @click="edit"><Icon name="edit" :size="14" /> 编辑</button>
        <button class="btn btn-danger dd-del" title="删除（移入回收站）" @click="remove"><Icon name="trash" :size="15" /></button>
        <span style="flex: 1"></span>
        <button class="btn btn-primary" @click="save"><Icon name="check" :size="14" /> 保存</button>
      </div>
    </aside>
  </transition>
</template>
