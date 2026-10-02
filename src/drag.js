// 拖拽控制器：基于原生 HTML5 Drag & Drop。
// 统一解析三种落点：
//   inside —— 拖入某文件夹（文件夹卡片高亮，悬停折叠文件夹自动展开）
//   before / after —— 在兄弟序列中前插 / 后插（全局插入指示线）
//   workspace —— 拖到侧栏「工作区」行上 = 把这些书签/文件夹里的书签登记进这一组（**不移动书签**）
// 全部通过 store.dragging / dropTarget / dropLine 驱动 UI。

import { store, nodeById, realChildrenIds, isDescendant, moveTo, addNodesToWorkspace } from './store.js'
import { isFolder } from './utils.js'

const DRAG_TYPE = 'application/x-cardtree'
let ghostEl = null
let expandTimer = null

// —— 拖拽期间替侧栏临时"让路" ——
// 侧栏收起时它就没有投放区了，而"收起侧栏"本身是被鼓励的状态；
// 所以拖拽贴到窗口左边缘停一下 → 临时唤出侧栏，松手/取消后还原用户的设置。
const PEEK_X = 12       // 离窗口左边缘多少 px 内算"想去侧栏"
const PEEK_DELAY = 200  // 停留多久才唤出（避免主区内部拖拽时贴边误触）
let peekTimer = null
let sidebarWasOpen = null  // 本次拖拽前侧栏的开合状态
let sidebarPeeked = false  // 本次拖拽是否由"贴边"临时唤出
let landedInChrome = false // 本次拖拽是否真的落进了侧栏（落成了就别急着收回去）

function armPeek() {
  if (peekTimer || store.sidebarOpen) return
  peekTimer = setTimeout(() => {
    peekTimer = null
    sidebarPeeked = true
    store.sidebarOpen = true
  }, PEEK_DELAY)
}

function disarmPeek() {
  if (peekTimer) {
    clearTimeout(peekTimer)
    peekTimer = null
  }
}

// ---------------------------------------------------------------- 拖拽开始
export function startDrag(e, ids) {
  if (!ids || !ids.length) {
    e.preventDefault()
    return
  }
  const nodes = ids.map(nodeById).filter(Boolean)
  if (!nodes.length) {
    e.preventDefault()
    return
  }

  store.dragging = {
    kind: nodes.every(isFolder)
      ? 'folder'
      : nodes.some(isFolder) ? 'mixed' : 'bookmark',
    ids,
    titles: nodes.map((n) => n.title || '未命名'),
    urls: nodes.filter((n) => n.url).map((n) => n.url),
    count: nodes.length,
  }

  e.dataTransfer.effectAllowed = 'move'
  try {
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ ids }))
    const first = nodes.find((n) => n.url)
    if (first) e.dataTransfer.setData('text/uri-list', first.url)
    e.dataTransfer.setData('text/plain', nodes.map((n) => n.title || '未命名').join(', '))
  } catch { /* ignore */ }

  buildGhost(nodes, e)
  document.body.classList.add('is-dragging')

  // 侧栏整棵树临时全展开：否则悬停某一行的自动展开会把下面的行推走，落点漂移
  sidebarWasOpen = store.sidebarOpen
  sidebarPeeked = false
  landedInChrome = false
  store.dragExpandAll = true
}

function buildGhost(nodes, e) {
  removeGhost()
  ghostEl = document.createElement('div')
  ghostEl.className = 'drag-ghost'
  const label = document.createElement('span')
  label.className = 'drag-ghost-label'
  label.textContent =
    nodes.length > 1 ? `${nodes.length} 项` : nodes[0].title || '未命名'
  ghostEl.appendChild(label)
  if (nodes.length > 1) {
    const badge = document.createElement('span')
    badge.className = 'drag-ghost-badge'
    badge.textContent = String(nodes.length)
    ghostEl.appendChild(badge)
  }
  ghostEl.style.cssText =
    'position:fixed;left:-9999px;top:0;pointer-events:none;'
  document.body.appendChild(ghostEl)
  try {
    e.dataTransfer.setDragImage(ghostEl, 16, 16)
  } catch { /* ignore */ }
}

function removeGhost() {
  if (ghostEl && ghostEl.parentNode) ghostEl.parentNode.removeChild(ghostEl)
  ghostEl = null
}

// ---------------------------------------------------------------- 目标解析
function setTarget(target, line) {
  store.dropTarget = target
  store.dropLine = line
}

function reject(e) {
  e.stopPropagation()
  store.dropTarget = null
  store.dropLine = null
  clearExpandTimer()
  if (e) e.dataTransfer.dropEffect = 'none'
}

function allow(e) {
  e.preventDefault()
  e.stopPropagation()
  e.dataTransfer.dropEffect = 'move'
}

function makeLine(rect, side, orient) {
  if (orient === 'v') {
    const x = side === 'before' ? rect.left - 1 : rect.right + 1
    return { x, y: rect.top, w: 3, h: rect.height, orient: 'v' }
  }
  const y = side === 'before' ? rect.top - 1 : rect.bottom + 1
  return { x: rect.left, y, w: rect.width, h: 3, orient: 'h' }
}

function maybeAutoExpand(folderId, delay = 600) {
  clearExpandTimer()
  if (store.collapsed.has(folderId)) {
    expandTimer = setTimeout(() => {
      store.collapsed.delete(folderId)
      expandTimer = null
    }, delay)
  }
}

function clearExpandTimer() {
  if (expandTimer) {
    clearTimeout(expandTimer)
    expandTimer = null
  }
}

// 当前拖拽对象能否落进该文件夹（拖文件夹进自己/后代 = 非法）
export function invalidFolderTarget(folderId) {
  const d = store.dragging
  if (!d) return true
  if (d.kind !== 'folder' && d.kind !== 'mixed') return false
  return d.ids.includes(folderId) || d.ids.some((id) => isDescendant(id, folderId))
}

// 判断目标所在网格是「单列（纵向）」还是「多列（横向）」。
// 单列时用上/下判断前后，多列时用左/右判断前后，避免拖拽手感僵硬。
function isVerticalGrid(el) {
  const grid = el.closest('.bookmark-grid, .cascade-children')
  if (!grid) return false
  const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length
  return cols <= 1
}

// 悬停在文件夹卡片上：单列上/下 22% 前后插、多列左/右 22% 前后插、中间拖入
export function overFolder(e, folderId) {
  if (!store.dragging) return
  if (invalidFolderTarget(folderId)) return reject(e)

  const el = e.currentTarget
  const rect = el.getBoundingClientRect()
  const vertical = isVerticalGrid(el)
  const band = Math.max(12, (vertical ? rect.height : rect.width) * 0.22)
  let side
  if (vertical) {
    if (e.clientY < rect.top + band) side = 'before'
    else if (e.clientY > rect.bottom - band) side = 'after'
    else side = 'inside'
  } else {
    if (e.clientX < rect.left + band) side = 'before'
    else if (e.clientX > rect.right - band) side = 'after'
    else side = 'inside'
  }

  const folder = nodeById(folderId)
  if (!folder) return reject(e)

  if (side === 'inside') {
    setTarget({ type: 'inside', folderId, parentId: folderId }, null)
    maybeAutoExpand(folderId)
  } else {
    setTarget(
      { type: side, side, parentId: folder.parentId || null, refId: folderId },
      makeLine(rect, side, vertical ? 'h' : 'v'),
    )
  }
  allow(e)
}

// 悬停在书签上：单列上/下对半、多列左/右对半
export function overBookmark(e, { parentId, refId }) {
  if (!store.dragging) return
  const el = e.currentTarget
  const rect = el.getBoundingClientRect()
  const vertical = isVerticalGrid(el)
  const side = vertical
    ? (e.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
    : (e.clientX < rect.left + rect.width / 2 ? 'before' : 'after')
  setTarget(
    { type: side, side, parentId, refId },
    makeLine(rect, side, vertical ? 'h' : 'v'),
  )
  allow(e)
}

// 悬停在文件夹内部（网格空白 / 卡片空白）→ 拖入
export function overGrid(e, folderId, expandDelay = 600) {
  if (!store.dragging) return
  if (invalidFolderTarget(folderId)) return reject(e)
  setTarget({ type: 'inside', folderId, parentId: folderId }, null)
  maybeAutoExpand(folderId, expandDelay)
  allow(e)
}

// 悬停在侧边栏的文件夹行 → 拖入。
// 与主区共用落点逻辑，唯一区别是落点带上 fromSidebar 标记（用来判断"这次拖拽真的用了侧栏"），
// 且悬停展开更快：侧栏行又窄又密，等 600ms 手感发黏。
export function overSidebarRow(e, folderId) {
  overGrid(e, folderId, 320)
  if (store.dropTarget) store.dropTarget.fromSidebar = true
}

// 悬停在侧边栏的**工作区行** → 落点 = 把拖的东西加进这一组。
// 语义上这是"登记"，不是移动：工作区只是"我要开的这几个站"的清单，
// 书签本体留在原来的文件夹里（所以落点执行时**不调 moveTo**）。
// 拖文件夹也允许：递归把里面的书签都加进去（和选中文件夹后点「＋」一致）。
export function overWorkspaceRow(e, wsId) {
  if (!store.dragging) return
  setTarget({ type: 'workspace', wsId, fromSidebar: true }, null)
  allow(e)
}

// ---------------------------------------------------------------- 落点执行
export function onDrop(e) {
  e.preventDefault()
  e.stopPropagation()
  performDrop()
}

async function performDrop() {
  const t = store.dropTarget
  const d = store.dragging
  if (!t || !d) return endDrag()

  try {
    if (t.type === 'inside') {
      await moveTo(d.ids, t.folderId)
      if (t.fromSidebar) landedInChrome = true
    } else if (t.type === 'workspace') {
      // 加进工作区：不动书签本体，只登记一份引用（所以这里不 await moveTo）
      addNodesToWorkspace(t.wsId, d.ids, { emptyHint: '拖进来的东西里没有可加的书签' })
      landedInChrome = true
    } else if (t.type === 'before' || t.type === 'after') {
      const parentId = t.parentId
      if (!parentId) return endDrag()
      const set = new Set(d.ids)
      const existing = realChildrenIds(parentId).filter((id) => !set.has(id))
      let idx
      if (t.refId == null) {
        idx = existing.length
      } else {
        const pos = existing.indexOf(t.refId)
        idx = t.side === 'before' ? pos : pos + 1
        if (pos === -1) idx = existing.length
      }
      await moveTo(d.ids, parentId, idx)
    }
  } catch (err) {
    console.error('[cardtree] drop failed', err)
  } finally {
    endDrag()
  }
}

export function endDrag() {
  removeGhost()
  clearExpandTimer()
  disarmPeek()
  store.dragging = null
  store.dropTarget = null
  store.dropLine = null
  store.dragExpandAll = false
  // 贴边临时唤出的侧栏：真的用它投放了就留着（你显然在用），
  // 只是路过的话还原你原本的设置，不偷偷改偏好
  if (sidebarPeeked && !landedInChrome) store.sidebarOpen = sidebarWasOpen
  sidebarPeeked = false
  sidebarWasOpen = null
  landedInChrome = false
  document.body.classList.remove('is-dragging')
}

// ---------------------------------------------------------------- 全局监听
export function setupDragListeners() {
  window.addEventListener('dragover', (e) => {
    if (!store.dragging) return
    // 贴到窗口左边缘停一下 → 临时唤出侧栏，让"侧栏收起"时也能拖进去
    if (typeof e.clientX === 'number' && e.clientX <= PEEK_X) armPeek()
    else disarmPeek()

    const t = e.target
    if (!(t instanceof Element) || !t.closest('[data-droppable]')) {
      store.dropTarget = null
      store.dropLine = null
      clearExpandTimer()
    }
  })
  window.addEventListener('drop', (e) => {
    if (store.dragging) e.preventDefault()
  })
  window.addEventListener('dragend', endDrag)
}
