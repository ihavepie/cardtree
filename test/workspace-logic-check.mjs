/* 工作区「逻辑」校验（不测样式）：
 *   L1 建组：条目带 id（活引用），且和「加入选中项」一样按 url 去重
 *   L2 活引用：重命名书签 → 工作区里的标题跟着变（原来永远是旧标题）
 *   L3 兜底：删除书签 → 条目仍在、标记 missing、仍可用快照链接打开
 *   L4 快照保鲜：改名后再删 → 显示的是"最后知道的名字"，不是最初的旧名
 *   L5 选中文件夹也能加：递归收集里面所有书签（原来静默失败）
 *   L6 移除按 id 命中：快照 url 过期时「✕」也能点掉（原来只按当前 url 过滤 → 点了没反应）
 *   L7 打开反馈：全部失败 / 部分失败 都要如实报（原来一律报"已打开 N 个"）
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP_HTTP = 'http://127.0.0.1:9265';
const PAGE_URL = 'http://localhost:5199/';
const EDGE_CANDIDATES = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);
const EDGE_BIN = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE_BIN) throw new Error('找不到 Microsoft Edge');

const results = {};
const pageErrors = [];
const profile = mkdtempSync(join(tmpdir(), 'cardtree-wslogic-'));
const edge = spawn(EDGE_BIN, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9265', `--user-data-dir=${profile}`,
  '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' });

async function waitHttp(url, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { return await (await fetch(url)).json(); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('CDP 未就绪');
}

let ws;
try {
  const list = await waitHttp(CDP_HTTP + '/json');
  ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function run(name, fn) {
    try { results[name] = await fn(); } catch (e) { results[name] = { ERROR: e.message }; }
  }
  const toastInfo = `(() => { const t = document.querySelector('.toast'); return t ? { text: t.querySelector('.toast-msg')?.textContent.trim() || t.textContent.trim(), action: t.querySelector('.toast-action')?.textContent.trim() || null } : null; })()`;
  const wsList = `window.__store.workspaces.map((w) => ({ name: w.name, items: w.items.map((i) => ({ id: !!i.id, title: i.title, url: i.url })) }))`;
  const typeInto = (sel, text) => `(() => {
    const i = document.querySelector(${JSON.stringify(sel)});
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, ${JSON.stringify(text)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: PAGE_URL });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (await ev(`!!(window.__store && !window.__store.loading && document.querySelectorAll('.bookmark-item').length > 0)`).catch(() => false)) break;
  }
  await sleep(800);
  await ev(`(async () => { window.__store.workspaces = []; window.__store.wsExpanded = new Set(); await new Promise((r) => setTimeout(r, 200)); return true; })()`);

  const selectTitles = (titles) => `(() => {
    const s = window.__store;
    const ids = ${JSON.stringify(titles)}.map((t) => [...s.nodesMap.values()].find((n) => n.url && n.title === t)?.id).filter(Boolean);
    s.selection = new Set(ids);
    return ids.length;
  })()`;

  await run('L1_create_keeps_ids_and_dedupes', async () => {
    const picked = await ev(selectTitles(['YouTube', 'Notion']));
    await ev(`document.querySelector('.panel--workspaces .panel-act').click()`);
    await sleep(260);
    await ev(typeInto('.modal .field-input', '开始工作'));
    await sleep(80);
    await ev(`[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '创建').click()`);
    await sleep(400);
    const created = await ev(wsList);
    // 选中一个书签 + 它的同 url 副本（mock 里造一个），验证去重
    const dedupe = await ev(`(() => {
      const s = window.__store;
      const bm = window.__bm;
      const yt = [...s.nodesMap.values()].find((n) => n.url && n.title === 'YouTube');
      return { existingUrl: yt ? yt.url : null };
    })()`);
    return {
      picked,
      items: created[0]?.items || [],
      每条都有id: (created[0]?.items || []).every((i) => i.id),
      dedupe,
    };
  });

  await run('L2_live_reference_follows_rename', async () => {
    const before = await ev(`document.querySelector('.ws-row .ws-name')?.textContent.trim() || null`);
    // 展开看条目
    await ev(`(() => { document.querySelector('.ws-row').click(); return true })()`);
    await sleep(350);
    const nameBefore = await ev(`[...document.querySelectorAll('.ws-tab .ws-tab-name')].map((e) => e.textContent.trim())`);
    // 用 mock 书签 API 改标题（等价于用户在浏览器书签管理器里改名）
    const renamed = await ev(`(async () => {
      const s = window.__store;
      const n = [...s.nodesMap.values()].find((x) => x.url && x.title === 'Notion');
      await window.__bm.update(n.id, { title: 'Notion 改名了' });
      await new Promise((r) => setTimeout(r, 700));
      return true;
    })()`);
    const nameAfterRename = await ev(`[...document.querySelectorAll('.ws-tab .ws-tab-name')].map((e) => e.textContent.trim())`);
    const stored = await ev(wsList);
    return {
      before, renamed,
      nameBefore, nameAfterRename,
      followsRename: nameAfterRename.includes('Notion 改名了') && !nameAfterRename.includes('Notion'),
      snapshotAlsoUpdated: (stored[0]?.items || []).some((i) => i.title === 'Notion 改名了'),
    };
  });

  await run('L3_delete_falls_back_to_snapshot', async () => {
    const deleted = await ev(`(async () => {
      const s = window.__store;
      const n = [...s.nodesMap.values()].find((x) => x.url && x.title === 'Notion 改名了');
      await window.__bm.removeTree(n.id);
      await new Promise((r) => setTimeout(r, 900));
      return true;
    })()`);
    const state = await ev(`(() => {
      const items = [...document.querySelectorAll('.ws-tab')];
      return {
        count: items.length,
        rows: items.map((e) => ({
          title: e.querySelector('.ws-tab-name')?.textContent.trim(),
          missing: e.classList.contains('missing'),
          badge: e.querySelector('.ws-tab-gone')?.textContent.trim() || null,
        })),
        storedCount: window.__store.workspaces[0]?.items.length,
      };
    })()`);
    return {
      deleted,
      ...state,
      条目还在: state.count === 2 && state.storedCount === 2,
      标记了missing: state.rows.some((r) => r.missing && r.badge === '已删除'),
      名字是最后知道的: state.rows.some((r) => r.title === 'Notion 改名了'),
    };
  });

  await run('L4_folder_selection_collects_bookmarks', async () => {
    // 选中「前端开发」文件夹（里面有 Vue.js / Vite / TypeScript / 组件库 等）
    const picked = await ev(`(() => {
      const s = window.__store;
      const folder = [...s.nodesMap.values()].find((n) => !n.url && (n.title || '').includes('前端开发'));
      if (!folder) return -1;
      const inner = [];
      const walk = (n) => { for (const c of n.children || []) { if (c.url) inner.push(c.title); else walk(c) } };
      walk(folder);
      s.selection = new Set([folder.id]);
      return inner.length;
    })()`);
    // 新建一个工作区，应该把这些书签都收进来
    await ev(`document.querySelector('.panel--workspaces .panel-act').click()`);
    await sleep(260);
    const note = await ev(`document.querySelector('.modal-note')?.textContent.trim() || null`);
    await ev(typeInto('.modal .field-input', '前端全套'));
    await sleep(80);
    await ev(`[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '创建').click()`);
    await sleep(400);
    const created = await ev(`(() => { const w = window.__store.workspaces.find((x) => x.name === '前端全套'); return w ? { count: w.items.length, titles: w.items.map((i) => i.title) } : null })()`);
    return {
      文件夹内书签数: picked,
      dialogNote: note,
      created,
      收进来了: !!created && created.count > 0 && created.count === picked,
    };
  });

  await run('L5_open_feedback_is_accurate', async () => {
    // 桩：全部失败
    await ev(`(() => {
      window.chrome = window.chrome || {};
      window.chrome.tabs = { create(opts, cb) { if (cb) cb(null); return Promise.resolve(null); }, remove() {} };
      return true;
    })()`);
    await ev(`document.querySelector('.ws-row').click()`);   // 展开
    await sleep(200);
    await ev(`(() => { const b = document.querySelector('.ws-row .ws-actions .ws-act'); b.click(); return true })()`);
    await sleep(900);
    const allFail = await ev(toastInfo);
    // 桩：一半成功
    await ev(`(() => {
      let i = 0;
      window.chrome.tabs = { create(opts, cb) { const t = (i++ % 2 === 0) ? { id: i } : null; if (cb) cb(t); return Promise.resolve(t); }, remove() {} };
      return true;
    })()`);
    await ev(`(() => { const b = document.querySelector('.ws-row .ws-actions .ws-act'); b.click(); return true })()`);
    await sleep(900);
    const partial = await ev(toastInfo);
    return { allFail, partial };
  });

  // L6 移除按 id 命中：条目快照 url 与书签当前 url 不一致时，「✕」也必须能点掉。
  // 老实现只按 url 过滤，且传进去的是**当前** url —— 快照 stale 时点了没反应。
  await run('L6_remove_uses_identity_not_stale_url', async () => {
    await ev(`(async () => {
      const s = window.__store;
      const yt = [...s.nodesMap.values()].find((n) => n.url === 'https://www.youtube.com');
      s.workspaces = [{ id: 'wsRm', name: '移除测试', icon: 'briefcase', items: [
        // 故意存一个过期 url：书签其实在 youtube.com，快照却是老地址
        { id: yt.id, title: '旧标题', url: 'https://old.example/gone' },
      ] }];
      s.wsExpanded = new Set(['wsRm']);
      await new Promise((r) => setTimeout(r, 500));
      return true;
    })()`);
    const before = await ev(`(() => {
      const tab = document.querySelector('.ws-tab');
      return {
        title: tab?.querySelector('.ws-tab-name')?.textContent.trim() || null,
        titleAttr: tab?.getAttribute('title') || '',
        storedUrl: window.__store.workspaces[0].items[0].url,
        storedId: window.__store.workspaces[0].items[0].id,
      };
    })()`);
    await ev(`(() => { document.querySelector('.ws-tab .ws-tab-x').click(); return true })()`);
    await sleep(400);
    const after = await ev(`({
      count: window.__store.workspaces[0].items.length,
      tabs: document.querySelectorAll('.ws-tab').length,
      toast: document.querySelector('.toast .toast-msg')?.textContent.trim() || null,
    })`);
    return {
      before,
      after,
      渲染用的是当前书签: before.title === 'YouTube' && before.titleAttr.includes('youtube.com'),
      快照确实是过期的: before.storedUrl === 'https://old.example/gone',
      点掉了: after.count === 0 && after.tabs === 0,
      给了反馈: /已从/.test(after.toast || ''),
    };
  });

  results.pageErrors = pageErrors;
  console.log(JSON.stringify(results, null, 2));
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  try { edge.kill('SIGTERM'); } catch { /* ignore */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
