// 响应式全局 store：书签树、折叠态、选中、最近、回收站、搜索、拖拽状态、持久化。

import { reactive, computed, watch, nextTick } from 'vue'
import { bm, subscribe, isExtension } from './bookmarks.js'
import { debounce, isFolder, clamp } from './utils.js'

// ---------------------------------------------------------------- 持久化适配
function storageGet(key, fallback) {
  if (isExtension) {
    return new Promise((res) => {
      try {
        chrome.storage.local.get(key, (r) => res(r[key] ?? fallback))
      } catch {
        res(fallback)
      }
    })
  }
  try {
    const raw = localStorage.getItem('cardtree:' + key)
    return Promise.resolve(raw ? JSON.parse(raw) : fallback)
  } catch {
    return Promise.resolve(fallback)
  }
}

function toPlain(v) {
  if (v === undefined) return undefined
  // chrome.storage.local 序列化 Vue 响应式 Proxy 数组时会丢失数组身份（变成 {0:…}），
  // 必须先转成纯 JSON 数据再写入。
  return JSON.parse(JSON.stringify(v))
}

function storageSet(key, value) {
  if (isExtension) {
    try {
      chrome.storage.local.set({ [key]: toPlain(value) })
    } catch { /* ignore */ }
  } else {
    try {
      localStorage.setItem('cardtree:' + key, JSON.stringify(value))
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- 首帧同步预置
// chrome.storage 是异步 IPC：等它回来时首帧已经画过了 —— 侧边栏宽度会从默认 230 跳到上次的
// 值（刷新时"弹一下"），深色主题也会先闪一下白。
// 这里把影响首帧的几个 UI 偏好同时镜像到 localStorage（可同步读），初始化时先用它，
// 随后由 init() 与 chrome.storage 对齐；只是把"上次的值"提前一帧拿到，不是新的数据源。
// 注意：只镜像这几个小字段，背景图 / 便签等大对象不要镜像进来。
const SYNC_PREF_PREFIX = 'cardtree:sync:'

function syncReadPref(key, fallback) {
  try {
    const raw = localStorage.getItem(SYNC_PREF_PREFIX + key)
    return raw == null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

function syncWritePref(key, value) {
  try {
    localStorage.setItem(SYNC_PREF_PREFIX + key, JSON.stringify(value))
  } catch { /* ignore */ }
}

function syncReadSidebarWidth() {
  const w = syncReadPref('sidebarWidth', 230)
  return typeof w === 'number' ? Math.round(Math.min(520, Math.max(150, w))) : 230
}

function syncReadLayoutMode() {
  return syncReadPref('layoutMode', 'stack') === 'columns' ? 'columns' : 'stack'
}

function syncReadTheme() {
  return syncReadPref('theme', 'light') === 'dark' ? 'dark' : 'light'
}

// ---------------------------------------------------------------- 状态
export const store = reactive({
  loading: true,
  roots: [],               // 顶层文件夹（书签栏/其他书签/…），children 为嵌套节点对象
  nodesMap: new Map(),     // id -> node（注入 parentId）
  flatList: [],            // 展示顺序的扁平列表（用于范围选择）

  collapsed: new Set(),    // 折叠文件夹 id
  expandedGrids: new Set(), // 已「展开全部」的书签网格（所属文件夹 id）
  selection: new Set(),    // 选中节点 id
  anchorId: null,          // Shift 范围选择锚点

  recent: [],              // 最近打开
  trash: [],               // 回收站（软删除快照）
  trashOpen: false,
  sidebarOpen: true,       // 侧边栏是否展开
  sidebarWidth: syncReadSidebarWidth(), // 侧边栏宽度（可拖拽拉伸）·初值取自同步镜像，避免刷新跳一下
  bg: null,                // 背景：null | {type:'custom', id} | {type:'animated'}
  bgPanelOpen: false,      // 背景设置面板
  customBackgrounds: [],   // 自定义背景栏位：[{id, name, type:'image'|'color'|'gradient', ...}]
  theme: syncReadTheme(),  // 主题：light | dark ·初值取自同步镜像，避免刷新先白后黑
  layoutMode: syncReadLayoutMode(), // 文件夹排列：stack 纵排 | columns 并排（网址始终横排并排）
  nodeMeta: {},            // 书签元数据：{ [bookmarkId]: { desc: string, tags: string[] } }
  nodeStats: {},           // 书签访问统计：{ [bookmarkId]: { count: number, lastOpenedAt: number } }

  query: '',
  tagFilter: '',           // 看板标签栏当前选中的标签（空 = 不筛选；不持久化，刷新即清）

  // 拖拽
  dragging: null,          // { kind, ids, titles, urls, count }
  dropTarget: null,        // { type, folderId?, parentId?, refId?, index }
  dropLine: null,          // { x, y, w, h }
  marquee: null,           // 框选：{ x1, y1, x2, y2 }

  // UI
  contextMenu: null,       // { x, y, items }
  dialog: null,            // { title, submitLabel, fields, onSubmit }
  toast: null,             // { msg, type }
  focusId: null,           // 搜索定位
  focusToken: 0,
  iconPickerFolderId: null, // 正在改图标的文件夹 id（非空则显示图标选择器）
  editingNodeId: null,      // 正在编辑（改名/改url）的书签 id，非空时点击空白不清空选中
  memos: [],                // 备忘录便签：[{id,title,body(markdown),color,pinned,done,x,y,createdAt,updatedAt}]
  memoStrokes: [],          // 软木板笔迹：[{points:[{x,y}], color, size}]
  memoState: { mode: 'ball', ballPos: null, panelPos: null }, // 备忘录形态/位置
})

// ---------------------------------------------------------------- 加载
function rebuildIndex() {
  const map = new Map()
  const flat = []
  const walk = (node, parentId) => {
    node.parentId = parentId
    map.set(node.id, node)
    const kids = node.children || []
    // 展示顺序：先书签，后文件夹（递归）
    for (const b of kids.filter((c) => c.url)) {
      b.parentId = node.id
      map.set(b.id, b)
      flat.push(b)
    }
    for (const f of kids.filter((c) => !c.url)) {
      flat.push(f)
      walk(f, node.id)
    }
  }
  for (const r of store.roots) walk(r, null)
  store.nodesMap = map
  store.flatList = flat
}

export async function load() {
  try {
    const roots = await bm.getRoots()
    // 记录每个节点在真实书签树里的父级。
    // load() 会把「其他书签 / 移动设备书签」的内容平铺进书签栏（只为显示），
    // 于是 rebuildIndex 会把它们的 parentId 也改写成书签栏；realParentId 保留真实归属，
    // 供 moveTo() 判断「谁真的属于这个文件夹」，否则一次排序就会把别的收藏夹条目搬进书签栏。
    const tagRealParents = (nodes, parentId) => {
      for (const n of nodes || []) {
        n.realParentId = parentId
        tagRealParents(n.children, n.id)
      }
    }
    tagRealParents(roots, null)

    // 只保留「书签栏」作为顶层；其他书签/移动设备书签的内容平铺进书签栏
    const bar = roots.find((r) => (r.title || '').includes('书签栏'))
    if (bar) {
      const others = roots.filter((r) => r !== bar && (r.children || []).length > 0)
      const extra = []
      for (const o of others) extra.push(...(o.children || []))
      bar.children = [...(bar.children || []), ...extra]
      store.roots = [bar]
    } else {
      store.roots = roots
    }
    rebuildIndex()
  } catch (e) {
    console.error('[cardtree] load failed', e)
  } finally {
    store.loading = false
  }
}

const debouncedReload = debounce(load, 160)

// ---------------------------------------------------------------- 查询
export function nodeById(id) {
  return store.nodesMap.get(id) || null
}

export function childrenIds(id) {
  const n = nodeById(id)
  return n && n.children ? n.children.map((c) => c.id) : []
}

/**
 * 真实归属该文件夹的子节点 id（排除为显示而平铺进来的其他收藏夹条目）。
 * 排序 / 落点计算必须用它，否则 applyOrder 会把平铺进来的条目也搬到该文件夹里。
 */
export function realChildrenIds(id) {
  return childrenIds(id).filter((cid) => {
    const n = nodeById(cid)
    return !n || n.realParentId === undefined || n.realParentId === id
  })
}

// ---------------------------------------------------------------- 书签元数据（描述/标签）
export function getMeta(id) {
  return store.nodeMeta[id] || null
}

export function setMeta(id, { desc = '', tags = [] } = {}) {
  const cleanDesc = String(desc || '').trim()
  const cleanTags = (Array.isArray(tags) ? tags : String(tags || '').split(/[,，]/))
    .map((t) => String(t).trim())
    .filter(Boolean)
  if (cleanDesc || cleanTags.length) store.nodeMeta[id] = { desc: cleanDesc, tags: cleanTags }
  else delete store.nodeMeta[id]
}

// 文件夹自定义图标（线条 SVG 名称）与颜色
export function getFolderIcon(id) {
  return (store.nodeMeta[id] && store.nodeMeta[id].icon) || ''
}

export function getFolderIconColor(id) {
  return (store.nodeMeta[id] && store.nodeMeta[id].iconColor) || ''
}

function syncFolderMeta(id, m) {
  const has = !!(m.desc || (m.tags && m.tags.length) || m.icon || m.iconColor)
  if (has) store.nodeMeta[id] = m
  else delete store.nodeMeta[id]
}

export function setFolderIcon(id, icon) {
  const m = store.nodeMeta[id] || {}
  m.icon = icon || ''
  syncFolderMeta(id, m)
}

export function setFolderIconColor(id, color) {
  const m = store.nodeMeta[id] || {}
  if (color) m.iconColor = color
  else delete m.iconColor
  syncFolderMeta(id, m)
}

// ---------------------------------------------------------------- 备忘录
export function addMemo(memo) {
  const item = {
    id: 'm-' + Date.now().toString(36),
    title: '',
    body: '',
    color: '',
    pinned: false,
    done: false,
    priority: 0,       // 0=无, 1=高, 2=中, 3=低
    tags: [],          // 标签：[string]
    children: [],      // 子任务：[{id, title, done}]
    x: 60,
    y: 60,
    z: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...memo,
  }
  store.memos.unshift(item)
  return item
}

export function addStroke(stroke) {
  store.memoStrokes.push(stroke)
}

export function undoStroke() {
  store.memoStrokes.pop()
}

export function clearStrokes() {
  store.memoStrokes = []
}

export function updateMemo(id, patch) {
  const m = store.memos.find((x) => x.id === id)
  if (m) Object.assign(m, patch, { updatedAt: Date.now() })
}

export function deleteMemo(id) {
  store.memos = store.memos.filter((x) => x.id !== id)
}

// 子任务
export function addSubtask(memoId, title) {
  const m = store.memos.find((x) => x.id === memoId)
  if (!m) return
  const t = String(title || '').trim()
  if (!t) return
  m.children = [...(m.children || []), { id: 's-' + Date.now().toString(36), title: t, done: false }]
  m.updatedAt = Date.now()
}
export function toggleSubtask(memoId, subtaskId) {
  const m = store.memos.find((x) => x.id === memoId)
  if (!m) return
  m.children = (m.children || []).map((s) => (s.id === subtaskId ? { ...s, done: !s.done } : s))
  m.updatedAt = Date.now()
}
export function deleteSubtask(memoId, subtaskId) {
  const m = store.memos.find((x) => x.id === memoId)
  if (!m) return
  m.children = (m.children || []).filter((s) => s.id !== subtaskId)
  m.updatedAt = Date.now()
}

export function toggleMemoPin(id) {
  const m = store.memos.find((x) => x.id === id)
  if (m) m.pinned = !m.pinned
}

export function setMemoState(patch) {
  store.memoState = { ...store.memoState, ...patch }
}

export function isCollapsed(id) {
  return store.collapsed.has(id)
}

// —— 书签网格「展开全部」——
// 每个文件夹的直接书签默认只显示前 PREVIEW_COUNT 个，避免卡片无限变长；点开才全铺。
export const PREVIEW_COUNT = 8

export function isGridExpanded(id) {
  return store.expandedGrids.has(id)
}

export function toggleGridExpanded(id) {
  if (store.expandedGrids.has(id)) store.expandedGrids.delete(id)
  else store.expandedGrids.add(id)
}

export function toggleCollapse(id) {
  if (store.collapsed.has(id)) store.collapsed.delete(id)
  else store.collapsed.add(id)
}

// 递归展开/折叠：作用于该文件夹及其所有后代子文件夹
export function toggleCollapseRecursive(id) {
  const node = nodeById(id)
  if (!node) return
  const subs = []
  const collect = (n) => {
    for (const c of n.children || []) {
      if (!c.url) {
        subs.push(c.id)
        collect(c)
      }
    }
  }
  collect(node)
  const collapsed = store.collapsed.has(id)
  for (const s of [id, ...subs]) {
    if (collapsed) store.collapsed.delete(s)
    else store.collapsed.add(s)
  }
}

export function allSubFolderIds() {
  const out = []
  const collect = (node) => {
    for (const child of node.children || []) {
      if (!child.url) {
        out.push(child.id)
        collect(child)
      }
    }
  }
  for (const r of store.roots) collect(r)
  return out
}

export function isAllCollapsed() {
  const all = allSubFolderIds()
  return all.length > 0 && all.every((id) => store.collapsed.has(id))
}

export function collapseAll() {
  store.collapsed = new Set(allSubFolderIds())
}

export function expandAll() {
  store.collapsed = new Set()
}

export function toggleAllFolders() {
  store.collapsed = isAllCollapsed() ? new Set() : new Set(allSubFolderIds())
}

export function expandTo(id) {
  let n = nodeById(id)
  while (n && n.parentId) {
    store.collapsed.delete(n.parentId)
    n = nodeById(n.parentId)
  }
}

export function pathOf(id) {
  const parts = []
  let n = nodeById(id)
  while (n) {
    parts.unshift(n.title || '未命名')
    n = n.parentId ? nodeById(n.parentId) : null
  }
  return parts
}

export function isDescendant(ancestorId, id) {
  let n = nodeById(id)
  while (n) {
    if (!n.parentId) return false
    if (n.parentId === ancestorId) return true
    n = nodeById(n.parentId)
  }
  return false
}

// ---------------------------------------------------------------- 选中
export function isSelected(id) {
  return store.selection.has(id)
}

export function topLevelSelection() {
  return [...store.selection].filter((id) => {
    const node = nodeById(id)
    return node && node.parentId ? !store.selection.has(node.parentId) : true
  })
}

// 是否「顶层选中」（视觉高亮只用它，子文件夹/后代不单独高亮）
export function isTopSelected(id) {
  if (!store.selection.has(id)) return false
  const node = nodeById(id)
  return node && node.parentId ? !store.selection.has(node.parentId) : true
}

export function selectedNodes() {
  return topLevelSelection().map(nodeById).filter(Boolean)
}

export function clearSelection() {
  store.selection.clear()
  store.anchorId = null
}

// 用一批 id 直接替换当前选中（用于框选）
export function selectAll(ids) {
  store.selection.clear()
  for (const id of ids) store.selection.add(id)
  store.anchorId = ids[0] || null
}

function subtreeIds(node) {
  const out = [node.id]
  for (const c of node.children || []) out.push(...subtreeIds(c))
  return out
}

function nodeIds(id) {
  const node = nodeById(id)
  return node && !node.url ? subtreeIds(node) : [id]
}

export function select(id, { ctrl = false, shift = false } = {}) {
  if (shift && store.anchorId) {
    const idxs = new Map(store.flatList.map((n, i) => [n.id, i]))
    const a = idxs.get(store.anchorId)
    const b = idxs.get(id)
    if (a != null && b != null) {
      store.selection.clear()
      const [lo, hi] = a < b ? [a, b] : [b, a]
      for (let i = lo; i <= hi; i++) {
        const n = store.flatList[i]
        if (n.url) store.selection.add(n.id)
        else for (const sid of subtreeIds(n)) store.selection.add(sid)
      }
      return
    }
  }
  if (ctrl) {
    const adding = !store.selection.has(id)
    for (const sid of nodeIds(id)) {
      if (adding) store.selection.add(sid)
      else store.selection.delete(sid)
    }
    store.anchorId = id
    return
  }
  store.selection.clear()
  for (const sid of nodeIds(id)) store.selection.add(sid)
  store.anchorId = id
}

// ---------------------------------------------------------------- CRUD
export async function createBookmark({ parentId, title, url, index }) {
  return await bm.create(parentId, { title, url }, index)
}

export async function createFolder({ parentId, title, index }) {
  await bm.create(parentId, { title }, index)
}

export async function renameNode(id, title, url) {
  const changes = { title }
  if (url !== undefined) changes.url = url
  await bm.update(id, changes)
}

// ---------------------------------------------------------------- 移动 / 排序
/**
 * 把 ids 移动到 parentId，并排到第 index 位（相对不含 ids 的兄弟序列）。
 * index 为 undefined 时追加到末尾。
 */
export async function moveTo(ids, parentId, index) {
  if (!ids.length || !parentId) return
  const set = new Set(ids)
  // 只用「真实属于该文件夹」的节点算顺序：平铺进来的其他收藏夹条目不能被回写，
  // 否则 applyOrder 会真的把它们搬进这个文件夹（数据事故）。
  const current = realChildrenIds(parentId)
  const existing = current.filter((id) => !set.has(id))
  const idx = clamp(index ?? existing.length, 0, existing.length)

  for (const id of ids) {
    const node = nodeById(id)
    if (!node) continue
    // 按真实归属判断是否需要真的移动：拖到书签栏根卡片时，平铺条目会真正归入书签栏
    const realParent = node.realParentId === undefined ? node.parentId : node.realParentId
    if (realParent !== parentId) await bm.move(id, { parentId })
  }
  const full = [...existing.slice(0, idx), ...ids, ...existing.slice(idx)]
  await bm.applyOrder(parentId, full)
}

// ---------------------------------------------------------------- 回收站
function cloneTree(n) {
  return {
    id: n.id,
    title: n.title,
    url: n.url,
    children: (n.children || []).map(cloneTree),
  }
}

async function trashOne(id) {
  const node = nodeById(id)
  if (!node) return
  const parent = node.parentId ? nodeById(node.parentId) : null
  const item = {
    id: node.id,
    title: node.title,
    url: node.url,
    children: node.children ? node.children.map(cloneTree) : undefined,
    parentId: node.parentId,
    parentTitle: parent ? parent.title : '',
    deletedAt: Date.now(),
  }
  await bm.removeTree(id)
  for (const sid of subtreeIds(node)) delete store.nodeMeta[sid]
  store.trash.unshift(item)
}

export async function trashNodes(ids) {
  for (const id of ids) await trashOne(id)
  clearSelection()
}

export async function restoreTrash(item) {
  let parentId = item.parentId && nodeById(item.parentId) ? item.parentId : null
  if (!parentId) {
    const bar = store.roots.find((r) => (r.title || '').includes('书签栏')) || store.roots[0]
    parentId = bar ? bar.id : null
  }
  if (!parentId) return

  const recreate = async (pid, it) => {
    if (it.url) {
      await bm.create(pid, { title: it.title, url: it.url })
    } else {
      const folder = await bm.create(pid, { title: it.title })
      for (const c of it.children || []) await recreate(folder.id, c)
    }
  }
  await recreate(parentId, item)
  store.trash = store.trash.filter((t) => t.id !== item.id)
}

export function deleteForever(id) {
  store.trash = store.trash.filter((t) => t.id !== id)
}

export function clearTrash() {
  store.trash = []
}

// ---------------------------------------------------------------- 最近打开
export function recordOpen(node) {
  if (!node || !node.url) return
  store.recent = [
    { id: node.id, title: node.title, url: node.url, openedAt: Date.now() },
    ...store.recent.filter((r) => r.url !== node.url),
  ].slice(0, 10)
  const prev = store.nodeStats[node.id] || { count: 0 }
  store.nodeStats[node.id] = { count: prev.count + 1, lastOpenedAt: Date.now() }
}

export function clearRecent() {
  store.recent = []
}

// ---------------------------------------------------------------- 搜索
export const searchResults = computed(() => {  const q = store.query.trim().toLowerCase()
  if (!q) return []
  const out = []
  const walk = (node, path) => {
    const title = (node.title || '').toLowerCase()
    const url = (node.url || '').toLowerCase()
    const meta = store.nodeMeta[node.id]
    const desc = ((meta && meta.desc) || '').toLowerCase()
    const tags = ((meta && meta.tags) || []).map((t) => String(t).toLowerCase())
    const hit = title.includes(q) || url.includes(q) || desc.includes(q) || tags.some((t) => t.includes(q))
    const myPath = [...path, node.title || '未命名']
    if (hit) {
      out.push({
        id: node.id,
        title: node.title,
        url: node.url,
        isFolder: isFolder(node),
        path: path.join(' / '),
        desc: (meta && meta.desc) || '',
        tags: (meta && meta.tags) || [],
      })
    }
    for (const c of node.children || []) walk(c, myPath)
  }
  for (const r of store.roots) walk(r, [])
  return out
})

// ---------------------------------------------------------------- 看板索引：标签聚合与筛选
/** 所有书签的标签聚合：[{ tag, count }]，按数量降序（同数量按名称） */
export const tagIndex = computed(() => {
  const counts = new Map()
  const walk = (n) => {
    if (n.url) {
      const tags = (store.nodeMeta[n.id] && store.nodeMeta[n.id].tags) || []
      for (const t of tags) {
        const key = String(t).trim()
        if (key) counts.set(key, (counts.get(key) || 0) + 1)
      }
    }
    for (const c of n.children || []) walk(c)
  }
  for (const r of store.roots) walk(r)
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'))
})

/** 点标签：选中；再点同一个 = 取消 */
export function setTagFilter(tag) {
  store.tagFilter = store.tagFilter === tag ? '' : tag
  if (store.tagFilter) expandMatchedFolders()
}

export function clearTagFilter() {
  store.tagFilter = ''
}

/** 筛选时自动展开命中的文件夹：否则默认折叠状态下"筛了标签却看不到东西" */
function expandMatchedFolders() {
  const walk = (node) => {
    if (isFolder(node) && store.collapsed.has(node.id)) store.collapsed.delete(node.id)
    for (const c of node.children || []) walk(c)
  }
  for (const r of filteredRoots.value) walk(r)
}

/**
 * 按标签筛选后的树：保留文件夹结构，只留带该标签的书签，空文件夹 / 空分组去掉。
 * 组件拿到的还是同一种树，所以渲染 / 拖拽逻辑不用改。
 */
export const filteredRoots = computed(() => {
  const tag = store.tagFilter
  if (!tag) return store.roots
  const hit = (n) => {
    const tags = (store.nodeMeta[n.id] && store.nodeMeta[n.id].tags) || []
    return tags.some((t) => String(t).trim() === tag)
  }
  const prune = (node) => {
    const kids = []
    for (const c of node.children || []) {
      if (c.url) {
        if (hit(c)) kids.push(c)
      } else {
        const sub = prune(c)
        if (sub) kids.push(sub)
      }
    }
    if (!kids.length) return null
    return { ...node, children: kids }
  }
  return store.roots.map((r) => prune(r)).filter(Boolean)
})

export function revealNode(id) {
  expandTo(id)
  store.collapsed.delete(id) // 展开目标文件夹本身，让内容可见
  store.focusId = id
  store.focusToken++
  nextTick(() => {
    const el = document.querySelector(`.main [data-id="${id}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}

// 只滚动定位 + 高亮，不改变折叠状态（配合 toggle 使用）
export function scrollToNode(id) {
  store.focusId = id
  store.focusToken++
  nextTick(() => {
    const el = document.querySelector(`.main [data-id="${id}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}

// ---------------------------------------------------------------- 提示
export function toast(msg, type = 'info') {
  store.toast = { msg, type }
  if (window.__toastTimer) clearTimeout(window.__toastTimer)
  window.__toastTimer = setTimeout(() => (store.toast = null), 2200)
}

// ---------------------------------------------------------------- 背景
export function setBg(bg) {
  store.bg = bg
  store.bgPanelOpen = false
}

// IndexedDB 视频 blob 存储（容量大，支持较大视频）
const IDB_NAME = 'cardtree-videos'
const IDB_STORE = 'videos'

function openVideoDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveVideoBlob(blob) {
  const db = await openVideoDb()
  const id = 'vid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(blob, id)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  return id
}

export async function loadVideoBlob(id) {
  const db = await openVideoDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get(id)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function deleteVideoBlob(id) {
  const db = await openVideoDb()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).delete(id)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

// 自定义背景栏位：{id, name, type:'image'|'video'|'color'|'gradient'|'flow', dataUrl?, videoId?, color?, from?, to?, angle?, speed?}
export function addBackground(name, type, data = {}) {
  const item = { id: 'bg-' + Date.now(), name, type, ...data }
  store.customBackgrounds.unshift(item)
  return item
}

export function removeBackground(id) {
  const item = store.customBackgrounds.find((i) => i.id === id)
  if (item && item.type === 'video' && item.videoId) {
    deleteVideoBlob(item.videoId).catch(() => {})
  }
  store.customBackgrounds = store.customBackgrounds.filter((i) => i.id !== id)
  if (store.bg && store.bg.type === 'custom' && store.bg.id === id) store.bg = null
}

export function randomBg() {
  const list = store.customBackgrounds
  if (!list.length) return
  const item = list[Math.floor(Math.random() * list.length)]
  store.bg = { type: 'custom', id: item.id }
}

export function clearBg() {
  store.bg = null
  store.bgPanelOpen = false
}

export function toggleTheme() {
  store.theme = store.theme === 'light' ? 'dark' : 'light'
}

// —— 文件夹排列模式（顶栏按钮单击切换，选择存 chrome.storage）——
// 只管「文件夹」怎么排：一条条往下堆 / 横向并排铺开（栏数按容器宽度自动）。
// 网址（书签）始终保持横排并排。
export const LAYOUT_MODES = [
  { key: 'stack', label: '纵排' },
  { key: 'columns', label: '并排' },
]

export function isLayoutMode(mode) {
  return LAYOUT_MODES.some((m) => m.key === mode)
}

export function setLayoutMode(mode) {
  if (isLayoutMode(mode)) store.layoutMode = mode
}

/** 切到下一档，返回新的档位对象（供顶栏提示用） */
export function cycleLayoutMode() {
  const i = LAYOUT_MODES.findIndex((m) => m.key === store.layoutMode)
  const next = LAYOUT_MODES[(i + 1) % LAYOUT_MODES.length]
  store.layoutMode = next.key
  return next
}

export function setSidebarWidth(w) {
  store.sidebarWidth = Math.round(Math.min(520, Math.max(150, w)))
}

export function applyTheme(t) {
  document.body.dataset.theme = t
}

// ---------------------------------------------------------------- 初始化
// 测试/调试：mock 模式下暴露到 window
if (!isExtension) {
  window.__store = store
  window.__bm = bm
}

export async function init() {
  let initCollapsed = false
  try {
    const [c, r, t, done, bg, theme, customBackgrounds, nodeMeta, nodeStats, sidebarWidth, memos, memoState, memoStrokes, layoutMode, expandedGrids] = await Promise.all([
      storageGet('collapsed', []),
      storageGet('recent', []),
      storageGet('trash', []),
      storageGet('initCollapsed', false),
      storageGet('bg', null),
      storageGet('theme', 'light'),
      storageGet('customBackgrounds', []),
      storageGet('nodeMeta', {}),
      storageGet('nodeStats', {}),
      storageGet('sidebarWidth', 230),
      storageGet('memos', []),
      storageGet('memoState', null),
      storageGet('memoStrokes', []),
      storageGet('layoutMode', 'stack'),
      storageGet('expandedGrids', []),
    ])
    const toArray = (v) => {
      if (Array.isArray(v)) return v
      // 兼容旧数据：chrome.storage 把数组存成了 {0:…} 形态时还原为数组
      if (v && typeof v === 'object') return Object.values(v)
      return []
    }
    store.collapsed = new Set(Array.isArray(c) ? c : [])
    store.expandedGrids = new Set(Array.isArray(expandedGrids) ? expandedGrids : [])
    store.recent = toArray(r)
    store.trash = toArray(t)
    store.bg = bg || null
    store.theme = theme === 'dark' ? 'dark' : 'light'
    store.layoutMode = isLayoutMode(layoutMode) ? layoutMode : 'stack'
    // 只保留图片/视频背景，过滤掉旧的纯色/渐变/动态类型
    store.customBackgrounds = toArray(customBackgrounds).filter((b) => b.type === 'image' || b.type === 'video')
    // 若当前背景指向已移除的类型，则回到默认
    if (store.bg?.type === 'custom' && !store.customBackgrounds.some((b) => b.id === store.bg.id)) {
      store.bg = null
    }
    store.nodeMeta = (nodeMeta && typeof nodeMeta === 'object' && !Array.isArray(nodeMeta)) ? nodeMeta : {}
    store.nodeStats = (nodeStats && typeof nodeStats === 'object' && !Array.isArray(nodeStats)) ? nodeStats : {}
    store.sidebarWidth = typeof sidebarWidth === 'number' ? sidebarWidth : 230
    store.memos = toArray(memos)
    store.memoStrokes = toArray(memoStrokes)
    store.memoState = (memoState && typeof memoState === 'object' && !Array.isArray(memoState))
      ? { mode: 'ball', ballPos: null, panelPos: null, ...memoState }
      : { mode: 'ball', ballPos: null, panelPos: null }
    // 权威值就位后回写同步镜像（下一次刷新首帧就能直接用；首次启用该机制时也靠这里补上）
    syncWritePref('sidebarWidth', store.sidebarWidth)
    syncWritePref('theme', store.theme)
    syncWritePref('layoutMode', store.layoutMode)
    applyTheme(store.theme)
    initCollapsed = !!done
  } catch { /* ignore */ }

  await load()
  subscribe(() => debouncedReload())

  watch(
    () => Array.from(store.collapsed),
    (v) => storageSet('collapsed', v),
  )
  watch(
    () => Array.from(store.expandedGrids),
    (v) => storageSet('expandedGrids', v),
  )
  watch(() => store.recent, (v) => storageSet('recent', v), { deep: true })
  watch(() => store.trash, (v) => storageSet('trash', v), { deep: true })
  watch(() => store.bg, (v) => storageSet('bg', v))
  watch(() => store.customBackgrounds, (v) => storageSet('customBackgrounds', v), { deep: true })
  watch(() => store.nodeMeta, (v) => storageSet('nodeMeta', v), { deep: true })
  watch(() => store.nodeStats, (v) => storageSet('nodeStats', v), { deep: true })
  watch(() => store.sidebarWidth, (v) => {
    storageSet('sidebarWidth', v)
    syncWritePref('sidebarWidth', v)
  })
  watch(() => store.memos, debounce((v) => storageSet('memos', v), 300), { deep: true })
  watch(() => store.memoStrokes, debounce((v) => storageSet('memoStrokes', v), 300), { deep: true })
  watch(() => store.memoState, debounce((v) => storageSet('memoState', v), 300), { deep: true })
  watch(() => store.theme, (v) => {
    storageSet('theme', v)
    syncWritePref('theme', v)
    applyTheme(v)
  })
  watch(() => store.layoutMode, (v) => {
    storageSet('layoutMode', v)
    syncWritePref('layoutMode', v)
  })

  // 首次使用：默认折叠所有子文件夹，让卡片树更紧凑（之后记住用户手动展开/折叠）
  if (!initCollapsed) {
    store.collapsed = new Set(allSubFolderIds())
    storageSet('initCollapsed', true)
  }
}
