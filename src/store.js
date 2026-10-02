// 响应式全局 store：书签树、折叠态、选中、最近、回收站、搜索、拖拽状态、持久化。

import { reactive, computed, watch, nextTick } from 'vue'
import { bm, subscribe, isExtension } from './bookmarks.js'
import { debounce, isFolder, clamp, uid } from './utils.js'

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
  workspaces: [],          // 工作区：[{ id, name, icon, items: [{title, url}] }] —— 一键打开一组网站
  wsExpanded: new Set(),   // 已展开（看得到组内每个标签页）的工作区 id
  panelSplit: 0.33,                            // 两张卡都展开时，上面那张的高度上限（占侧栏可用高度）
  sidebarOpen: true,       // 侧边栏是否展开
  sidebarWidth: syncReadSidebarWidth(), // 侧边栏宽度（可拖拽拉伸）·初值取自同步镜像，避免刷新跳一下
  dragExpandAll: false,    // 拖拽期间：临时把侧栏整棵树展开，落点不再随悬停展开而漂移（拖完还原）
  sidebarFocusId: null,    // 侧栏文件夹树里当前拥有 Tab 焦点的行（roving tabindex）
  spyId: null,             // 滚动联动：主区当前正在看的那个文件夹 id
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
// url → 书签节点（同一网址收藏了多次时取第一个）。老工作区数据只有 {title,url}，
// 认领 id / 判断"书签是不是真被删了"都要靠它。
let flatByUrl = new Map()

function rebuildIndex() {
  const map = new Map()
  const byUrl = new Map()
  const flat = []
  const walk = (node, parentId) => {
    node.parentId = parentId
    map.set(node.id, node)
    const kids = node.children || []
    // 展示顺序：先书签，后文件夹（递归）
    for (const b of kids.filter((c) => c.url)) {
      b.parentId = node.id
      map.set(b.id, b)
      if (!byUrl.has(b.url)) byUrl.set(b.url, b)
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
  flatByUrl = byUrl
  // 每次树变了都补一次：老数据补 id、快照刷新成当前标题
  backfillWorkspaceIds()
  refreshWorkspaceSnapshots()
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

// ---------------------------------------------------------------- 工作区（一键打开一组网站）
// 零权限版：组里存的是 {title, url} 快照，不是 bookmarkId ——
// 工作区的语义是"我要开的这几个站"，不该因为你之后整理/删掉那个书签就跟着散架。
const WS_ICONS = ['briefcase', 'zap', 'globe', 'star', 'book', 'code', 'coffee', 'chart']

function collectBookmarks(node, out, seen) {
  for (const c of node.children || []) {
    if (c.url) {
      if (!seen.has(c.id)) { seen.add(c.id); out.push(c) }
    } else {
      collectBookmarks(c, out, seen)
    }
  }
}

/**
 * 把一批 id 展开成"能打开的书签"：书签直接用，文件夹递归收集里面的书签，按 id 去重。
 * 选中项入口和拖拽落点入口共用（拖文件夹进工作区 = 把里面的书签都加进去）。
 */
export function bookmarkNodesOf(ids) {
  const out = []
  const seen = new Set()
  for (const id of ids || []) {
    const n = nodeById(id)
    if (!n) continue
    if (n.url) {
      if (!seen.has(n.id)) { seen.add(n.id); out.push(n) }
    } else {
      collectBookmarks(n, out, seen)
    }
  }
  return out
}

/**
 * 当前选中能打开的书签。
 * 选中**文件夹**时递归收集里面的书签 —— 以前只收 `n.url` 的节点，
 * 选一个装着 20 个书签的文件夹会得到"没选中书签"，用户完全不知道为什么。
 */
export function selectedBookmarkNodes() {
  return bookmarkNodesOf(topLevelSelection())
}

/**
 * 组里的条目：存 `{ id, title, url }`，其中 url/title 是**快照兜底**。
 * 渲染与打开时优先用 id 去书签树里取**当前**的标题与网址：
 *   - 书签改了名 / 改了网址 → 工作区跟着变（以前永远是旧标题）
 *   - 书签被删了 → 退回快照，工作区不散架（这是当初存快照的初衷）
 * 取不到 id 的老条目按 url 再认一次，避免"书签明明还在，却被打上「已删除」"。
 */
export function workspaceItemsOf(ws) {
  return (ws.items || []).map((it, i) => {
    let live = it.id ? nodeById(it.id) : null
    if ((!live || !live.url) && it.url) live = flatByUrl.get(it.url) || null
    if (live && !live.url) live = null
    return {
      key: it.id || it.url || String(i),
      id: (live && live.id) || it.id || null,
      title: (live && live.title) || it.title || it.url || '',
      url: (live && live.url) || it.url || '',
      storedUrl: it.url || '',
      // 只有"确实找不到这个书签"才算已删除；没有 id 的老条目按 url 找得到就是活的
      missing: !live,
    }
  })
}

/** 往工作区里塞书签（按 url 去重）；建组和"加入选中项"共用这一条逻辑 */
function mergeIntoWorkspace(ws, nodes) {
  const seen = new Set((ws.items || []).map((i) => i.url))
  let added = 0
  for (const n of nodes) {
    if (!n || !n.url || seen.has(n.url)) continue
    seen.add(n.url)
    ws.items.push({ id: n.id, title: n.title || n.url, url: n.url })
    added++
  }
  return added
}

/**
 * 刷新组里条目的快照：凡是有 id 且书签还存在的，把 title/url 更新成当前值。
 * 这样"改名后又删掉"也不会退回最初的旧名字（快照只在加入时写过一次，会过期）。
 * 挂在每次 load() 之后，所以连"在浏览器自带书签管理器里改名"也会跟上。
 */
function refreshWorkspaceSnapshots() {
  let changed = false
  for (const ws of store.workspaces) {
    for (const it of ws.items || []) {
      if (!it.id) continue
      const n = nodeById(it.id)
      if (!n || !n.url) continue
      const t = n.title || n.url
      if (it.title !== t || it.url !== n.url) { it.title = t; it.url = n.url; changed = true }
    }
  }
  if (changed) store.workspaces = [...store.workspaces]
}

/** 老数据没有 id：按 url 反查一次补上，之后就跟着书签改名了 */
function backfillWorkspaceIds() {
  let changed = false
  for (const ws of store.workspaces) {
    for (const it of ws.items || []) {
      if (it.id && nodeById(it.id)) continue
      const n = it.url ? flatByUrl.get(it.url) : null
      if (n) { it.id = n.id; changed = true }
    }
  }
  if (changed) store.workspaces = [...store.workspaces]
}

export function createWorkspace(name, nodes = []) {
  const ws = {
    id: uid('ws'),
    name: String(name || '').trim() || '新工作区',
    icon: WS_ICONS[store.workspaces.length % WS_ICONS.length],
    items: [],
  }
  mergeIntoWorkspace(ws, nodes)
  store.workspaces = [...store.workspaces, ws]
  return ws
}

export function renameWorkspace(id, name) {
  const ws = store.workspaces.find((w) => w.id === id)
  if (!ws) return false
  ws.name = String(name || '').trim() || ws.name
  store.workspaces = [...store.workspaces]
  return true
}

export function deleteWorkspace(id) {
  const n = store.workspaces.length
  store.workspaces = store.workspaces.filter((w) => w.id !== id)
  store.wsExpanded.delete(id)
  return store.workspaces.length !== n
}

/** 展开 / 收起某个工作区（展开后能看到组内每一个标签页，逐个打开） */
export function toggleWorkspaceExpand(id) {
  if (store.wsExpanded.has(id)) store.wsExpanded.delete(id)
  else store.wsExpanded.add(id)
}

// ---- 卡片布局：只剩高度分配（上下顺序固定：工作区在上、文件夹在下）----
// 曾经的"拖标题栏/拖拽条换位"已整体移除：面板交换的收益不值那套机制
// （拖拽条 + 幽灵块 + 落点高亮 + 顺序持久化），两卡职责本来就固定 ——
// 上面是"我要打开的"，下面是"我要整理的"。
const SPLIT_MIN = 0.15
const SPLIT_MAX = 0.8

/** 上面那张卡的高度上限（占侧栏可用高度的比例） */
export function setPanelSplit(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return
  store.panelSplit = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, n))
}

/** 规范化分栏比例（存储里可能是旧数据 / 被手改过） */
function normalizePanelLayout(rawSplit) {
  const sp = Number(rawSplit)
  store.panelSplit = Number.isFinite(sp) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, sp)) : 0.33
}

/** 把当前选中的书签加进工作区（按 url 去重），返回新增条数；-1 表示没选中东西 */
/**
 * 把一批节点加进工作区：落库 + 顺手展开 + 统一反馈。
 * **「＋」按钮和"把书签/文件夹拖到工作区行上"两条路径共用这一条**，文案也共用。
 * ids 里可以是文件夹（递归收集里面的书签）。
 * 返回加进去的条数：-1 = 这批里没有可打开的书签；0 = 都已经在组里了。
 */
export function addNodesToWorkspace(id, ids, { emptyHint } = {}) {
  const ws = store.workspaces.find((w) => w.id === id)
  if (!ws) return -1
  const nodes = bookmarkNodesOf(ids)
  if (!nodes.length) {
    if (emptyHint) toast(emptyHint, 'warning')
    return -1
  }
  const added = mergeIntoWorkspace(ws, nodes)
  store.workspaces = [...store.workspaces]
  if (!added) {
    toast(`「${ws.name}」里已经有这些书签了`, 'warning')
    return 0
  }
  // 加完顺手展开，让你确认加对了
  if (!store.wsExpanded.has(ws.id)) store.wsExpanded.add(ws.id)
  toast(`已加进「${ws.name}」：${added} 项（共 ${ws.items.length} 项）`)
  return added
}

export function addSelectionToWorkspace(id) {
  return addNodesToWorkspace(id, topLevelSelection(), {
    emptyHint: '先选中要加进来的书签，再点「＋」',
  })
}

/**
 * 从工作区里移除一项。
 * 以前只按 url 匹配、而传进来的是**当前** url：书签改过网址（或条目只有快照）时
 * 「✕」点了没反应 —— 看着就是"移除功能坏了"。现在 id / 当前 url / 快照 url 命中任一即可，
 * 所以既不会误删，也不会点不动。target 可以是 workspaceItemsOf() 的条目，也可以直接给 url 字符串。
 */
export function removeFromWorkspace(id, target) {
  const ws = store.workspaces.find((w) => w.id === id)
  if (!ws) return false
  const t = typeof target === 'string' ? { url: target } : (target || {})
  const before = ws.items.length
  ws.items = ws.items.filter((i) => {
    if (t.id && i.id && i.id === t.id) return false
    if (t.url && i.url === t.url) return false
    if (t.storedUrl && i.url === t.storedUrl) return false
    return true
  })
  store.workspaces = [...store.workspaces]
  return ws.items.length !== before
}

// chrome.tabs.create / remove 属于基础能力，**不需要 `tabs` 权限**
// （`tabs` 权限是为了读取 url / title 这类敏感字段）。所以工作区不用扩权就能一键开一组。
function createTab(url) {
  return new Promise((resolve) => {
    let settled = false
    const done = (t) => { if (!settled) { settled = true; resolve(t || null) } }
    try {
      const ret = chrome.tabs.create({ url, active: false }, done)
      if (ret && typeof ret.then === 'function') ret.then(done, () => done(null))
      setTimeout(() => done(null), 2000)   // 兜底：别把撤销提示卡在这
    } catch {
      done(null)
    }
  })
}

/** 打开整组：扩展环境走后标签逐个 create，非扩展环境回退 window.open。
 *  返回 { ids, opened, failed }：以前只要有一个成功就报"已打开 N 个"，
 *  全部失败时也照报，用户会以为开了其实没开。 */
async function openUrls(urls) {
  const hasTabs = typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create
  if (!hasTabs) {
    let opened = 0
    urls.forEach((u) => { try { window.open(u, '_blank', 'noopener'); opened++ } catch { /* ignore */ } })
    return { ids: [], opened, failed: urls.length - opened }
  }
  const ids = []
  for (const url of urls) {
    const tab = await createTab(url)
    if (tab && tab.id != null) ids.push(tab.id)
  }
  return { ids, opened: ids.length, failed: urls.length - ids.length }
}

export async function openWorkspace(id) {
  const ws = store.workspaces.find((w) => w.id === id)
  if (!ws) return
  const items = workspaceItemsOf(ws)
  if (!items.length) {
    toast('这个工作区还是空的：先选中书签，再点它右边的「＋」', 'warning')
    return
  }
  const { ids, opened, failed } = await openUrls(items.map((i) => i.url))
  const n = items.length
  if (!opened) {
    toast(`「${ws.name}」的 ${n} 个网站都没打开成功`, 'warning')
    return
  }
  const msg = failed
    ? `「${ws.name}」打开了 ${opened}/${n} 个（${failed} 个失败）`
    : `已打开「${ws.name}」的 ${n} 个网站`
  if (ids.length) {
    // 一次开一堆标签是有副作用的动作，所以必须给后悔的机会
    toast(msg, failed ? 'warning' : 'info', {
      label: '撤销',
      run: () => {
        try { chrome.tabs.remove(ids) } catch { /* ignore */ }
        toast('已关闭刚打开的标签')
      },
    })
  } else {
    toast(msg, failed ? 'warning' : 'info')
  }
}

/** 打开组内的单个标签页（后台）。单击某个具体标签页的语义就是"我要这一个"，不该顺带开全部 */
export async function openWorkspaceItem(item) {
  if (!item || !item.url) return
  const hasTabs = typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create
  if (hasTabs) {
    await createTab(item.url)
  } else {
    window.open(item.url, '_blank', 'noopener')
  }
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

// ---------------------------------------------------------------- 侧栏键盘焦点 / 滚动联动
export function setSidebarFocus(id) {
  store.sidebarFocusId = id || null
}

/** 焦点 id 失效（文件夹被删/改名）时，回落到第一个根文件夹 */
export function ensureSidebarFocus() {
  const id = store.sidebarFocusId
  if (id && nodeById(id) && !nodeById(id).url) return
  store.sidebarFocusId = store.roots[0]?.id || null
}

// ---------------------------------------------------------------- 常用（按打开次数）
/** 打开次数最多的书签（数据一直在记，之前只有详情抽屉读它） */
export const frequentBookmarks = computed(() => {
  const out = []
  for (const n of store.flatList) {
    if (!n.url) continue
    const st = store.nodeStats[n.id]
    if (st && st.count > 0) out.push({ node: n, count: st.count, lastOpenedAt: st.lastOpenedAt || 0 })
  }
  out.sort((a, b) => b.count - a.count || b.lastOpenedAt - a.lastOpenedAt)
  return out.slice(0, 10)   // 一屏放得下 10 个左右（原来 8 个）
})

// ---------------------------------------------------------------- 提示
// action: { label, run } —— 给有副作用的操作留一条后路（例如工作区一键开一组后的「撤销」）
export function toast(msg, type = 'info', action = null) {
  store.toast = { msg, type, action }
  if (window.__toastTimer) clearTimeout(window.__toastTimer)
  window.__toastTimer = setTimeout(() => (store.toast = null), action ? 6000 : 2200)
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
    const [c, r, t, done, bg, theme, customBackgrounds, nodeMeta, nodeStats, sidebarWidth, memos, memoState, memoStrokes, layoutMode, expandedGrids, workspaces, wsExpanded, panelSplit] = await Promise.all([
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
      storageGet('workspaces', []),
      storageGet('wsExpanded', []),
      storageGet('panelSplit', 0.33),
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
    store.workspaces = toArray(workspaces)
      .filter((w) => w && typeof w === 'object')
      .map((w) => ({
        id: w.id || uid('ws'),
        name: String(w.name || '未命名工作区'),
        icon: WS_ICONS.includes(w.icon) ? w.icon : 'briefcase',
        items: (Array.isArray(w.items) ? w.items : [])
          .filter((i) => i && typeof i.url === 'string' && i.url)
          .map((i) => ({ title: String(i.title || i.url), url: i.url })),
      }))
    store.wsExpanded = new Set(toArray(wsExpanded))
    normalizePanelLayout(panelSplit)
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
  watch(() => store.workspaces, (v) => storageSet('workspaces', v), { deep: true })
  watch(() => Array.from(store.wsExpanded), (v) => storageSet('wsExpanded', v))
  watch(() => store.panelSplit, (v) => storageSet('panelSplit', v))
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
