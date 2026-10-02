// UI 动作层：打开书签、右键菜单构建、弹窗构建。组件直接调用，避免事件层层透传。

import {
  store, nodeById, createBookmark, createFolder, renameNode, moveTo,
  trashNodes, clearSelection, selectedNodes, topLevelSelection, toggleCollapse, isCollapsed,
  recordOpen, toast, setMeta, selectedBookmarkNodes, createWorkspace, renameWorkspace,
  deleteWorkspace, openWorkspace, toggleWorkspaceExpand,
} from './store.js'
import { isFolder } from './utils.js'

// ---------------------------------------------------------------- 打开
export function openBookmark(node) {
  if (!node || !node.url) return
  window.open(node.url, '_blank', 'noopener')
  recordOpen(node)
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('已复制链接', 'info')
  } catch {
    toast('复制失败', 'warning')
  }
}

// ---------------------------------------------------------------- 菜单
export function closeMenu() {
  store.contextMenu = null
}

export function openMenu(x, y, items) {
  store.contextMenu = { x, y, items }
}

function sep() {
  return { separator: true }
}

function item(label, action, { icon = '', danger = false, disabled = false } = {}) {
  return { label, action, icon, danger, disabled }
}

export function menuForNode(node, x, y) {
  const multi = topLevelSelection().length > 1 && store.selection.has(node.id)
  if (multi) {
    openMenu(x, y, menuForMulti())
    return
  }
  openMenu(x, y, isFolder(node) ? menuForFolder(node) : menuForBookmark(node))
}

function menuForMulti() {
  const nodes = selectedNodes()
  return [
    item('打开全部', () => nodes.forEach(openBookmark), { icon: 'open' }),
    item('移动到文件夹…', () => dialogMove(nodes.map((n) => n.id)), { icon: 'folder' }),
    sep(),
    item('删除', () => trashNodes(nodes.map((n) => n.id)), { icon: 'trash', danger: true }),
  ]
}

function menuForBookmark(node) {
  return [
    item('在新标签页打开', () => openBookmark(node), { icon: 'open' }),
    item('复制链接', () => copyText(node.url), { icon: 'link' }),
    sep(),
    item('移动到文件夹…', () => dialogMove([node.id]), { icon: 'folder' }),
    sep(),
    item('删除', () => trashNodes([node.id]), { icon: 'trash', danger: true }),
  ]
}

function menuForFolder(node) {
  const collapsed = isCollapsed(node.id)
  return [
    item(collapsed ? '展开' : '折叠', () => toggleCollapse(node.id), { icon: collapsed ? 'chevron-right' : 'chevron-down' }),
    item('新建书签', () => dialogNewBookmark(node.id), { icon: 'plus' }),
    item('新建子文件夹', () => dialogNewFolder(node.id), { icon: 'folder' }),
    sep(),
    item('重命名', () => dialogRename(node), { icon: 'edit' }),
    item('更改图标', () => { store.iconPickerFolderId = node.id }, { icon: 'emoji' }),
    item('移动到文件夹…', () => dialogMove([node.id]), { icon: 'folder' }),
    sep(),
    item('删除', () => trashNodes([node.id]), { icon: 'trash', danger: true }),
  ]
}

export function menuForEmpty(x, y, parentId) {
  openMenu(x, y, [
    item('新建书签', () => dialogNewBookmark(parentId), { icon: 'plus' }),
    item('新建文件夹', () => dialogNewFolder(parentId), { icon: 'folder' }),
    sep(),
    item('刷新', () => location.reload(), { icon: 'refresh' }),
  ])
}

// ---------------------------------------------------------------- 弹窗
export function closeDialog() {
  store.dialog = null
}

export function openDialog(dialog) {
  store.dialog = dialog
}

export function dialogNewBookmark(parentId) {
  openDialog({
    title: '新建书签',
    submitLabel: '创建',
    fields: [
      { key: 'title', label: '名称', type: 'text', value: '', placeholder: '书签名称', required: true },
      { key: 'url', label: '网址', type: 'url', value: 'https://', placeholder: 'https://example.com', required: true },
      { key: 'desc', label: '描述', type: 'text', value: '', placeholder: '一句话说明这个网址（可选）' },
      { key: 'tags', label: '标签', type: 'text', value: '', placeholder: '逗号分隔，如：设计, 灵感' },
    ],
    async onSubmit(values) {
      const node = await createBookmark({ parentId, title: values.title.trim(), url: values.url.trim() })
      setMeta(node.id, { desc: values.desc, tags: values.tags })
      toast('已创建书签')
    },
  })
}

export function dialogNewFolder(parentId) {
  openDialog({
    title: '新建文件夹',
    submitLabel: '创建',
    fields: [
      { key: 'title', label: '名称', type: 'text', value: '', placeholder: '文件夹名称', required: true },
    ],
    async onSubmit(values) {
      await createFolder({ parentId, title: values.title.trim() })
      toast('已创建文件夹')
    },
  })
}

export function dialogRename(node) {
  // 仅用于重命名文件夹
  openDialog({
    title: '重命名文件夹',
    submitLabel: '保存',
    fields: [
      { key: 'title', label: '名称', type: 'text', value: node.title || '', required: true },
    ],
    async onSubmit(values) {
      await renameNode(node.id, values.title.trim())
      toast('已保存')
    },
  })
}

// ---------------------------------------------------------------- 工作区
export function dialogNewWorkspace() {
  const picked = selectedBookmarkNodes()
  openDialog({
    title: '新建工作区',
    submitLabel: '创建',
    note: picked.length
      ? `会把当前选中的 ${picked.length} 个书签放进去。之后选中别的书签，点工作区右侧的「＋」可以继续添加。`
      : '现在没有选中书签，先建一个空工作区也行：之后选中书签，点工作区右侧的「＋」加进来。',
    fields: [
      { key: 'name', label: '名称', type: 'text', value: '', placeholder: '例如：开始工作 / 查资料', required: true },
    ],
    async onSubmit(values) {
      const ws = createWorkspace(values.name, picked)
      toast(picked.length ? `已创建「${ws.name}」（${picked.length} 项）` : `已创建「${ws.name}」`)
    },
  })
}

export function dialogRenameWorkspace(ws) {
  openDialog({
    title: '重命名工作区',
    submitLabel: '保存',
    fields: [
      { key: 'name', label: '名称', type: 'text', value: ws.name, required: true },
    ],
    async onSubmit(values) {
      renameWorkspace(ws.id, values.name)
      toast('已保存')
    },
  })
}

export function dialogDeleteWorkspace(ws) {
  openDialog({
    title: '删除工作区',
    submitLabel: '删除',
    note: `「${ws.name}」里有 ${ws.items.length} 个网站。删除只影响这个工作区，不会动你的书签。`,
    fields: [],
    async onSubmit() {
      deleteWorkspace(ws.id)
      toast(`已删除「${ws.name}」`)
    },
  })
}

/** 工作区行右侧「⋯」的小菜单（右键同一份） */
export function menuForWorkspace(ws, x, y) {
  const expanded = store.wsExpanded.has(ws.id)
  openMenu(x, y, [
    item('立即打开全部', () => openWorkspace(ws.id), { icon: 'external' }),
    item(expanded ? '收起标签页' : '展开标签页', () => toggleWorkspaceExpand(ws.id), { icon: 'list' }),
    { separator: true },
    item('重命名', () => dialogRenameWorkspace(ws), { icon: 'edit' }),
    item('删除工作区', () => dialogDeleteWorkspace(ws), { icon: 'trash', danger: true }),
  ])
}

export function dialogEditBookmark(node) {
  // 编辑书签的名称与网址（描述/标签在右侧抽屉就地编辑）
  openDialog({
    title: '编辑书签',
    submitLabel: '保存',
    fields: [
      { key: 'title', label: '名称', type: 'text', value: node.title || '', required: true },
      { key: 'url', label: '网址', type: 'url', value: node.url || '', required: true },
    ],
    async onSubmit(values) {
      await renameNode(node.id, values.title.trim(), values.url.trim())
      toast('已保存')
    },
  })
}

export function dialogMove(ids) {
  const folderOptions = []
  const forbidden = new Set()
  for (const id of ids) {
    forbidden.add(id)
    const n = nodeById(id)
    if (n && !n.url) {
      for (const c of collectIds(n)) forbidden.add(c)
    }
  }
  const walk = (node, depth) => {
    if (!isFolder(node)) return
    const disabled = forbidden.has(node.id)
    folderOptions.push({
      id: node.id,
      label: node.title || '未命名',
      indent: depth,
      disabled,
    })
    if (!disabled) for (const c of node.children || []) walk(c, depth + 1)
  }
  for (const r of store.roots) walk(r, 0)

  openDialog({
    title: `移动 ${ids.length} 项到文件夹`,
    submitLabel: '移动',
    fields: [
      { key: 'target', label: '目标文件夹', type: 'folder', options: folderOptions },
    ],
    async onSubmit(values) {
      if (!values.target) {
        toast('请选择目标文件夹', 'warning')
        throw new Error('no target')
      }
      await moveTo(ids, values.target)
      clearSelection()
      toast('已移动')
    },
  })
}

function collectIds(node) {
  const out = [node.id]
  for (const c of node.children || []) out.push(...collectIds(c))
  return out
}

// ---------------------------------------------------------------- 键盘辅助
export function openSelected() {
  const nodes = selectedNodes()
  if (nodes.length === 1) openBookmark(nodes[0])
  else nodes.forEach(openBookmark)
}

export function deleteSelected() {
  const nodes = selectedNodes()
  if (nodes.length) trashNodes(nodes.map((n) => n.id))
}

export function renameSelected() {
  const nodes = selectedNodes()
  if (nodes.length === 1 && !nodes[0].url) dialogRename(nodes[0])
}
