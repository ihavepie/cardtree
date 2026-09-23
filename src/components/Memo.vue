<script setup>
import { ref, computed } from 'vue'
import draggable from 'vuedraggable'
import {
  store, addMemo, updateMemo, deleteMemo, setMemoState,
  addSubtask, toggleSubtask, deleteSubtask,
} from '../store.js'
import Icon from './Icon.vue'

const mode = computed(() => store.memoState.mode)

// —— 优先级 ——
const PRIORITIES = [
  { v: 0, label: '无优先级', color: '#cbd5e1' },
  { v: 1, label: '高', color: '#ef4444' },
  { v: 2, label: '中', color: '#f59e0b' },
  { v: 3, label: '低', color: '#3b82f6' },
]
function priorityOf(m) {
  return PRIORITIES.find((p) => p.v === (m.priority || 0)) || PRIORITIES[0]
}
function cyclePriority(m) {
  updateMemo(m.id, { priority: ((m.priority || 0) + 1) % 4 })
}

// —— 状态 ——
const newTitle = ref('')
const query = ref('')
const filter = ref('all') // all | active | done
const expandedId = ref(null)
const subDraft = ref('')

// —— 统计 ——
const totalCount = computed(() => store.memos.length)
const doneCount = computed(() => store.memos.filter((m) => m.done).length)
const activeCount = computed(() => totalCount.value - doneCount.value)
const progress = computed(() =>
  totalCount.value ? Math.round((doneCount.value / totalCount.value) * 100) : 0,
)

// —— 过滤 / 搜索 ——
function matches(m, q) {
  if (!q) return true
  const hay = [
    m.title,
    m.body,
    ...(m.tags || []),
    ...(m.children || []).map((c) => c.title),
  ].join(' ').toLowerCase()
  return hay.includes(q.toLowerCase())
}
const visibleMemos = computed(() =>
  store.memos.filter((m) => {
    if (filter.value === 'active' && m.done) return false
    if (filter.value === 'done' && !m.done) return false
    return matches(m, query.value)
  }),
)
const draggableEnabled = computed(() => filter.value === 'all' && !query.value.trim())

function quickAdd() {
  const t = newTitle.value.trim()
  if (!t) return
  addMemo({ title: t })
  newTitle.value = ''
}

function toggleDone(m) {
  const nextDone = !m.done
  updateMemo(m.id, { done: nextDone })
  if (nextDone) {
    const idx = store.memos.findIndex((x) => x.id === m.id)
    if (idx >= 0 && idx < store.memos.length - 1) {
      const [it] = store.memos.splice(idx, 1)
      store.memos.push(it)
    }
  }
}

function toggleExpand(m) {
  expandedId.value = expandedId.value === m.id ? null : m.id
  if (expandedId.value === m.id) {
    subDraft.value = ''
  }
}

function onTagsInput(m, e) {
  m.tags = e.target.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
  updateMemo(m.id, { tags: m.tags })
}

function saveBody(m) {
  updateMemo(m.id, { body: m.body })
}

function addSub(m) {
  if (!subDraft.value.trim()) return
  addSubtask(m.id, subDraft.value)
  subDraft.value = ''
}

// —— 拖拽 ——
function defaultBall() {
  return { x: window.innerWidth - 84, y: window.innerHeight - 200 }
}
function defaultPanel() {
  return { x: Math.max(16, window.innerWidth - 440), y: Math.max(80, window.innerHeight - 620) }
}
const ballStyle = computed(() => {
  const p = store.memoState.ballPos || defaultBall()
  return { left: p.x + 'px', top: p.y + 'px' }
})
const panelStyle = computed(() => {
  const p = store.memoState.panelPos || defaultPanel()
  return { left: p.x + 'px', top: p.y + 'px' }
})

function beginDrag(e, { start, move, click, end }) {
  e.preventDefault()
  e.stopPropagation()
  const sx = e.clientX
  const sy = e.clientY
  let moved = false
  const snap = start()
  const onMove = (ev) => {
    const dx = ev.clientX - sx
    const dy = ev.clientY - sy
    if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) moved = true
    if (moved) move(snap, dx, dy)
  }
  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    if (!moved && click) click()
    if (end) end(moved)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

const BALL_SIZE = 56
function snapBallToEdge() {
  const p = store.memoState.ballPos || defaultBall()
  const cx = p.x + BALL_SIZE / 2
  const snapLeft = cx < window.innerWidth / 2
  const x = snapLeft ? 12 : window.innerWidth - BALL_SIZE - 12
  setMemoState({ ballPos: { x, y: p.y } })
}

function dragBall(e) {
  const el = e.currentTarget
  el.style.transition = 'none' // 拖拽时禁用过渡，跟随鼠标
  beginDrag(e, {
    start: () => ({ ...(store.memoState.ballPos || defaultBall()) }),
    move: (s, dx, dy) => setMemoState({ ballPos: { x: s.x + dx, y: s.y + dy } }),
    click: () => setMemoState({ mode: 'panel' }),
    end: (moved) => {
      el.style.transition = '' // 恢复过渡，吸附动画生效
      if (moved) snapBallToEdge()
    },
  })
}
function dragPanel(e) {
  beginDrag(e, {
    start: () => ({ ...(store.memoState.panelPos || defaultPanel()) }),
    move: (s, dx, dy) => setMemoState({ panelPos: { x: s.x + dx, y: s.y + dy } }),
  })
}
</script>

<template>
  <!-- 悬浮球 -->
  <div v-if="mode === 'ball'" class="memo-ball" :style="ballStyle" title="待办" @mousedown="dragBall">
    <Icon name="list" :size="22" />
    <span v-if="activeCount" class="memo-ball-badge">{{ activeCount }}</span>
  </div>

  <!-- 待办面板 -->
  <div v-if="mode === 'panel'" class="memo-panel" :style="panelStyle">
    <div class="memo-panel-head" @mousedown="dragPanel">
      <span>待办</span>
      <span class="memo-todo-count">{{ activeCount }} 待办</span>
      <button class="icon-btn" title="收起" @click="setMemoState({ mode: 'ball' })"><Icon name="minimize" :size="15" /></button>
    </div>

    <!-- 搜索 + 过滤 -->
    <div class="memo-toolbar">
      <input v-model="query" class="memo-todo-input" placeholder="搜索标题 / 备注 / 标签…" />
      <div class="memo-filter-tabs">
        <button :class="{ active: filter === 'all' }" @click="filter = 'all'">全部</button>
        <button :class="{ active: filter === 'active' }" @click="filter = 'active'">进行中</button>
        <button :class="{ active: filter === 'done' }" @click="filter = 'done'">已完成</button>
      </div>
    </div>

    <!-- 进度统计 -->
    <div class="memo-progress">
      <div class="memo-progress-bar">
        <div class="memo-progress-fill" :style="{ width: progress + '%' }"></div>
      </div>
      <span class="memo-progress-text">{{ doneCount }}/{{ totalCount }} · {{ progress }}%</span>
    </div>

    <!-- 待办列表（可拖拽排序） -->
    <div class="memo-todo-list">
      <draggable
        v-model="store.memos"
        item-key="id"
        :disabled="!draggableEnabled"
        handle=".memo-drag-handle"
        ghost-class="memo-ghost"
        animation="180"
      >
        <template #item="{ element: m }">
          <div
            v-show="visibleMemos.includes(m)"
            class="memo-todo-item"
            :class="{ done: m.done, expanded: expandedId === m.id }"
          >
            <div class="memo-todo-row">
              <span class="memo-drag-handle" title="拖拽排序"><Icon name="grip" :size="15" /></span>
              <button class="memo-check" @click="toggleDone(m)">
                <Icon v-if="m.done" name="check" :size="13" />
              </button>
              <button
                class="memo-priority-dot"
                :style="{ background: priorityOf(m).color }"
                :title="'优先级：' + priorityOf(m).label + '（点击切换）'"
                @click.stop="cyclePriority(m)"
              ></button>
              <span class="memo-todo-title" @click="toggleExpand(m)">{{ m.title || '（无标题）' }}</span>

              <template v-if="m.tags && m.tags.length">
                <span v-for="t in m.tags" :key="t" class="memo-tag-chip">{{ t }}</span>
              </template>

              <span v-if="m.children && m.children.length" class="memo-sub-count" title="子任务进度">
                {{ m.children.filter((c) => c.done).length }}/{{ m.children.length }}
              </span>

              <Icon v-if="m.body" name="note" :size="13" class="memo-note-flag" title="有备注" />

              <button
                class="memo-expand-btn"
                :title="expandedId === m.id ? '收起' : '展开'"
                @click="toggleExpand(m)"
              >
                <Icon :name="expandedId === m.id ? 'chevron-down' : 'chevron-right'" :size="15" />
              </button>
              <button class="memo-del" title="删除" @click="deleteMemo(m.id)"><Icon name="trash" :size="13" /></button>
            </div>

            <!-- 展开区：备注 + 标签 + 子任务 -->
            <div v-if="expandedId === m.id" class="memo-todo-detail">
              <textarea
                v-model="m.body"
                class="memo-detail-body"
                placeholder="备注 / 描述（支持多行）…"
                @blur="saveBody(m)"
              ></textarea>

              <div class="memo-detail-row">
                <Icon name="tag" :size="14" />
                <input
                  :value="(m.tags || []).join(', ')"
                  class="memo-todo-input"
                  placeholder="标签，逗号分隔"
                  @input="onTagsInput(m, $event)"
                />
              </div>

              <div class="memo-subs">
                <div v-for="s in m.children" :key="s.id" class="memo-sub-item" :class="{ done: s.done }">
                  <button class="memo-sub-check" @click="toggleSubtask(m.id, s.id)">
                    <Icon v-if="s.done" name="check" :size="12" />
                  </button>
                  <span class="memo-sub-title" @click="toggleSubtask(m.id, s.id)">{{ s.title }}</span>
                  <button class="memo-sub-del" title="删除子任务" @click="deleteSubtask(m.id, s.id)"><Icon name="trash" :size="12" /></button>
                </div>
                <div class="memo-sub-add">
                  <input
                    v-model="subDraft"
                    class="memo-todo-input"
                    placeholder="添加子任务，回车确认"
                    @keydown.enter="addSub(m)"
                  />
                  <button class="memo-todo-add-btn" @click="addSub(m)">＋</button>
                </div>
              </div>
            </div>
          </div>
        </template>
      </draggable>

      <div v-if="!store.memos.length" class="memo-empty">还没有待办，在下面输入添加</div>
      <div v-else-if="!visibleMemos.length" class="memo-empty">没有匹配的待办</div>
    </div>

    <!-- 添加区 -->
    <div class="memo-todo-add">
      <input v-model="newTitle" class="memo-todo-input" placeholder="添加待办，回车确认" @keydown.enter="quickAdd" />
      <button class="memo-todo-add-btn" @click="quickAdd">＋</button>
    </div>
  </div>
</template>
