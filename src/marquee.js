// 框选：在空白处按住左键拖动，拉出一个选择框，框内的书签被选中。
// 与单击/双击/右键/拖拽排序互不干扰：只有落在空白处才启动。

import { store, selectAll } from './store.js'

const IGNORE = '.bookmark-item, .cascade-heading, .cascade-toggle, .cascade-handle, ' +
  '.section-head, .context-menu, .modal, .topbar, .sidebar, .search-box, .btn, .icon-btn, ' +
  '.detail-drawer, .trash-panel, .bg-panel, .recent-item, .link-btn, .sidebar-resizer, ' +
  'input, textarea, [contenteditable], .memo-ball, .memo-panel, .memo-board, .memo-editor, ' +
  '.memo-color, .memo-col-add, .memo-note-flat'

let active = false
let moved = false
let startX = 0
let startY = 0
let suppressClick = false

export function marqueeMouseDown(e) {
  if (e.button !== 0) return
  if (e.target.closest(IGNORE)) return
  active = true
  moved = false
  startX = e.clientX
  startY = e.clientY
  store.marquee = { x1: startX, y1: startY, x2: startX, y2: startY }
  e.preventDefault()
}

export function marqueeMouseMove(e) {
  if (!active) return
  if (!moved && Math.abs(e.clientX - startX) < 4 && Math.abs(e.clientY - startY) < 4) return
  moved = true
  store.marquee = { x1: startX, y1: startY, x2: e.clientX, y2: e.clientY }
  applyMarquee()
}

export function marqueeMouseUp() {
  if (!active) return
  active = false
  if (moved) {
    applyMarquee()
    suppressClick = true
    setTimeout(() => { suppressClick = false }, 0)
  }
  store.marquee = null
}

// 框选结束后，抑制紧随其后的 click（避免 onGlobalClick 又把选中清掉）
export function consumeMarqueeClick() {
  if (suppressClick) {
    suppressClick = false
    return true
  }
  return false
}

function applyMarquee() {
  const m = store.marquee
  if (!m) return
  const x1 = Math.min(m.x1, m.x2)
  const x2 = Math.max(m.x1, m.x2)
  const y1 = Math.min(m.y1, m.y2)
  const y2 = Math.max(m.y1, m.y2)
  const ids = []
  document.querySelectorAll('.bookmark-item').forEach((el) => {
    const r = el.getBoundingClientRect()
    if (r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1) {
      const id = el.getAttribute('data-id')
      if (id) ids.push(id)
    }
  })
  selectAll(ids)
}
