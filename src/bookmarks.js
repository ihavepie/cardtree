// chrome.bookmarks 封装 + mock 实现。
// 统一对外 API，扩展环境走真实 chrome.bookmarks，`?mock=1` 或非扩展环境走内存 mock，
// 两者都通过同一个事件订阅机制触发 store 刷新。

import { uid } from './utils.js'

export const isExtension =
  typeof chrome !== 'undefined' && !!chrome.bookmarks && !!chrome.runtime

// ---------------------------------------------------------------- 事件订阅
const listeners = new Set()
function emit() {
  for (const cb of listeners) cb()
}

/** 订阅书签变化（任意增删改/移动/排序/导入），返回取消函数 */
export function subscribe(cb) {
  listeners.add(cb)
  if (isExtension) {
    const evs = [
      'onCreated', 'onRemoved', 'onChanged', 'onMoved',
      'onChildrenReordered', 'onImportEnded',
    ]
    const handler = () => emit()
    for (const name of evs) {
      if (chrome.bookmarks[name]) chrome.bookmarks[name].addListener(handler)
    }
    return () => {
      listeners.delete(cb)
      for (const name of evs) {
        if (chrome.bookmarks[name]) chrome.bookmarks[name].removeListener(handler)
      }
    }
  }
  return () => listeners.delete(cb)
}

// ---------------------------------------------------------------- 真实实现
function wrap() {
  return new Promise((resolve, reject) => {
    try {
      const cbs = {}
      chrome.bookmarks.getTree((tree) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
        else resolve(tree)
      })
    } catch (e) {
      reject(e)
    }
  })
}

const real = {
  async getRoots() {
    const tree = await wrap()
    // tree[0] 是根节点，children 是「书签栏/其他书签/移动设备书签」等顶层文件夹
    return (tree[0] && tree[0].children) || []
  },

  create(parentId, { title, url }, index) {
    return new Promise((resolve, reject) => {
      const opts = { parentId, title }
      if (url) opts.url = url
      if (index != null) opts.index = index
      chrome.bookmarks.create(opts, (node) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
        else resolve(node)
      })
    })
  },

  update(id, changes) {
    return new Promise((resolve, reject) => {
      chrome.bookmarks.update(id, changes, (node) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
        else resolve(node)
      })
    })
  },

  removeTree(id) {
    return new Promise((resolve, reject) => {
      chrome.bookmarks.removeTree(id, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
        else resolve()
      })
    })
  },

  move(id, dest) {
    return new Promise((resolve, reject) => {
      chrome.bookmarks.move(id, dest, (node) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
        else resolve(node)
      })
    })
  },

  /** 把 parentId 下所有子节点按 orderedIds 精确排序（逆序 move，避免索引漂移） */
  async applyOrder(parentId, orderedIds) {
    for (let i = orderedIds.length - 1; i >= 0; i--) {
      await this.move(orderedIds[i], { parentId, index: i })
    }
  },
}

// ---------------------------------------------------------------- mock 实现
function buildMock() {
  const nodes = new Map() // id -> {id,title,url?,children:[ids]}
  const addFolder = (id, title) => {
    const n = { id, title, children: [] }
    nodes.set(id, n)
    return n
  }
  const addBm = (id, title, url) => {
    const n = { id, title, url, children: [] }
    nodes.set(id, n)
    return n
  }
  const attach = (parentId, ...childIds) => {
    nodes.get(parentId).children.push(...childIds)
  }
  const setChildren = (parentId, childIds) => {
    nodes.get(parentId).children = childIds.slice()
  }

  // —— 顶层 ——
  addFolder('bar', '书签栏')
  addFolder('other', '其他书签')
  addFolder('mobile', '移动设备书签')

  // 书签栏内容
  addFolder('f-tools', '常用工具')
  attach('f-tools',
    addBm('b-github', 'GitHub', 'https://github.com').id,
    addBm('b-gmail', 'Gmail', 'https://mail.google.com').id,
    addBm('b-translate', 'Google 翻译', 'https://translate.google.com').id,
    addBm('b-drive', 'Google Drive', 'https://drive.google.com').id,
  )

  addFolder('f-dev', '前端开发')
  addFolder('f-dev-ui', '组件库')
  attach('f-dev-ui',
    addBm('b-antd', 'Ant Design', 'https://ant.design').id,
    addBm('b-element', 'Element Plus', 'https://element-plus.org').id,
    addBm('b-naive', 'Naive UI', 'https://www.naiveui.com').id,
  )
  attach('f-dev',
    addBm('b-mdn', 'MDN 文档', 'https://developer.mozilla.org').id,
    addBm('b-vue', 'Vue.js', 'https://vuejs.org').id,
    addBm('b-vite', 'Vite', 'https://vitejs.dev').id,
    addBm('b-ts', 'TypeScript', 'https://www.typescriptlang.org').id,
    nodes.get('f-dev-ui').id,
    addBm('b-react', 'React', 'https://react.dev').id,
  )

  addFolder('f-design', '设计灵感')
  attach('f-design',
    addBm('b-figma', 'Figma', 'https://www.figma.com').id,
    addBm('b-dribbble', 'Dribbble', 'https://dribbble.com').id,
    addBm('b-behance', 'Behance', 'https://www.behance.net').id,
  )

  attach('bar',
    nodes.get('f-tools').id,
    addBm('b-youtube', 'YouTube', 'https://www.youtube.com').id,
    addBm('b-x', 'X / Twitter', 'https://x.com').id,
    nodes.get('f-dev').id,
    addBm('b-notion', 'Notion', 'https://www.notion.so').id,
    nodes.get('f-design').id,
    addBm('b-bilibili', '哔哩哔哩', 'https://www.bilibili.com').id,
    addBm('b-zhihu', '知乎', 'https://www.zhihu.com').id,
  )

  // 其他书签
  addFolder('f-news', '资讯阅读')
  attach('f-news',
    addBm('b-hn', 'Hacker News', 'https://news.ycombinator.com').id,
    addBm('b-reddit', 'Reddit', 'https://www.reddit.com').id,
  )
  attach('other',
    addBm('b-wiki', '维基百科', 'https://zh.wikipedia.org').id,
    nodes.get('f-news').id,
    addBm('b-archive', 'Internet Archive', 'https://archive.org').id,
  )

  // 移动设备书签（少量）
  attach('mobile', addBm('b-map', 'Google Maps', 'https://maps.google.com').id)

  const rootIds = ['bar', 'other', 'mobile']

  function findParentEntry(id) {
    for (const [, n] of nodes) {
      if (n.children.includes(id)) return n
    }
    return null
  }

  function cloneNode(id) {
    const n = nodes.get(id)
    if (!n) return null
    return { id: n.id, title: n.title, url: n.url, children: n.children.map(cloneNode) }
  }

  return {
    async getRoots() {
      return rootIds.map(cloneNode)
    },
    async create(parentId, { title, url }, index) {
      const node = url
        ? addBm(uid(), title, url)
        : addFolder(uid(), title)
      const parent = nodes.get(parentId)
      if (!parent) throw new Error('父节点不存在')
      if (index == null || index >= parent.children.length) parent.children.push(node.id)
      else parent.children.splice(index, 0, node.id)
      emit()
      return node
    },
    async update(id, changes) {
      const n = nodes.get(id)
      if (!n) throw new Error('节点不存在')
      if ('title' in changes) n.title = changes.title
      if ('url' in changes) n.url = changes.url
      emit()
      return n
    },
    async removeTree(id) {
      const parent = findParentEntry(id)
      if (parent) parent.children = parent.children.filter((c) => c !== id)
      const purge = (nid) => {
        const n = nodes.get(nid)
        if (!n) return
        for (const c of n.children) purge(c)
        nodes.delete(nid)
      }
      purge(id)
      emit()
    },
    async move(id, { parentId, index }) {
      const oldParent = findParentEntry(id)
      const n = nodes.get(id)
      if (!n) throw new Error('节点不存在')
      if (oldParent) oldParent.children = oldParent.children.filter((c) => c !== id)
      const newParent = nodes.get(parentId)
      if (!newParent) throw new Error('目标父节点不存在')
      if (index == null || index >= newParent.children.length) newParent.children.push(id)
      else newParent.children.splice(index, 0, id)
      emit()
      return n
    },
    async applyOrder(parentId, orderedIds) {
      const parent = nodes.get(parentId)
      if (!parent) throw new Error('父节点不存在')
      parent.children = orderedIds.slice()
      emit()
    },
  }
}

const mock = buildMock()

// 选择实现
export const bm = isExtension ? real : mock

/** 是否运行在 mock 模式（本地 `?mock=1` 或非扩展环境） */
export const isMock = !isExtension
