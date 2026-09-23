// 通用工具函数

export function debounce(fn, wait = 150) {
  let t
  const wrapped = (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), wait)
  }
  wrapped.cancel = () => clearTimeout(t)
  return wrapped
}

export function uid() {
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

const PALETTE = [
  '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981',
  '#06b6d4', '#ef4444', '#f97316', '#14b8a6', '#6366f1',
]

export function colorFor(str = '') {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export function isFolder(node) {
  return !!node && !node.url
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// 抓取网页的描述（优先 meta description / og:description / twitter:description，兜底 <title>）。
// 需在扩展里声明 http(s) host_permissions；mock/dev 环境下多数站点会因 CORS 失败。
export async function fetchPageDescription(url, timeoutMs = 9000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { Accept: 'text/html' },
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const html = await res.text()
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const candidates = [
      doc.querySelector('meta[name="description"]'),
      doc.querySelector('meta[property="og:description"]'),
      doc.querySelector('meta[name="twitter:description"]'),
    ]
    for (const m of candidates) {
      const c = ((m && m.getAttribute('content')) || '').replace(/\s+/g, ' ').trim()
      if (c) return c.length > 220 ? c.slice(0, 220) + '…' : c
    }
    const title = (doc.querySelector('title')?.textContent || '').replace(/\s+/g, ' ').trim()
    return title
  } finally {
    clearTimeout(timer)
  }
}

// 优先用 chrome favicon 服务（读本地缓存，能拿到真实图标）；
// mock/dev 环境回退 Google s2；两者都失败时由调用方回退到首字母色块。
export function faviconUrl(url, size = 64) {
  if (!url) return ''
  try {
    const u = new URL(url)
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(u.href)}&size=${Math.round(size)}`
    }
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.hostname)}&sz=${Math.round(size)}`
  } catch {
    return ''
  }
}



export function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max)
}

export function elTitle(title, url) {
  return title ? `${title}\n${url || ''}`.trim() : url || ''
}
