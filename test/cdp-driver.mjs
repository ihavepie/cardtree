/* CDP 交互测试：自启动无头 Edge，驱动卡片树页面做渲染/折叠/拖拽/搜索/CRUD 验证 */
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP_HTTP = 'http://127.0.0.1:9224';
const PAGE_URL = 'http://localhost:5199/';
const SHOT_DIR = fileURLToPath(new URL('./screens/', import.meta.url));

// Edge 可能装在 /Applications 或外置卷；用 EDGE_BIN 可覆盖
const EDGE_CANDIDATES = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);
const EDGE_BIN = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE_BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定：\n' + EDGE_CANDIDATES.join('\n'));

const results = {};
const pageErrors = [];

const profile = mkdtempSync(join(tmpdir(), 'cardtree-edge-'));
const edge = spawn(EDGE_BIN, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=9224`, `--user-data-dir=${profile}`,
  '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' });

async function waitHttp(url, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { return await (await fetch(url)).json(); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('CDP 未就绪: ' + url);
}

let ws;
try {
  const list = await waitHttp(CDP_HTTP + '/json');
  const target = list.find((t) => t.type === 'page' && t.url === 'about:blank') || list.find((t) => t.type === 'page');
  if (!target) throw new Error('no page target');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const txt = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (msg.params.type === 'error' || msg.params.type === 'warning') pageErrors.push(msg.params.type + ': ' + txt);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push('exception: ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'unknown'));
    }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function ev(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function run(name, fn) {
    try { results[name] = await fn(); }
    catch (e) { results[name] = { ERROR: e.message }; }
  }
  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOT_DIR + name, Buffer.from(r.data, 'base64'));
  }

  // 定位辅助
  const bmEl = (name) => `[...document.querySelectorAll('.bookmark-item')].find(e => e.querySelector('.bookmark-title')?.textContent === '${name}')`;
  const folderEl = (name) => `[...document.querySelectorAll('.cascade-node')].find(n => n.querySelector('.cascade-title')?.textContent.includes('${name}'))`;
  const folderCard = (name) => `${folderEl(name)}.querySelector('.cascade-card')`;
  const folderHead = (name) => `${folderEl(name)}.querySelector('.cascade-heading')`;
  const rootCard = (name) => `[...document.querySelectorAll('.root-section')].find(s => s.querySelector('.section-label')?.textContent.includes('${name}')).querySelector('.root-card')`;
  const barBookmarks = `(async () => { const roots = await window.__bm.getRoots(); const bar = roots.find(r => r.title === '书签栏'); return bar.children.filter(c => c.url).map(c => c.title); })()`;
  const barAll = `(async () => { const roots = await window.__bm.getRoots(); const bar = roots.find(r => r.title === '书签栏'); return bar.children.map(c => c.title); })()`;

  // 通用拖拽：mode 内联为字符串字面量
  function dragExpr(srcExpr, dstExpr, mode = 'inside') {
    const m = JSON.stringify(mode);
    return `(async () => {
      const src = ${srcExpr};
      const dst = ${dstExpr};
      if (!src || !dst) return { err: 'element not found' };
      const r = dst.getBoundingClientRect();
      let cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (${m} === 'before') { cy = r.top + Math.min(8, r.height / 2); }
      else if (${m} === 'after') { cy = r.bottom - Math.min(8, r.height / 2); }
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
      dst.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      await new Promise(r => setTimeout(r, 700));
      return true;
    })()`;
  }
  const escape = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: PAGE_URL });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const ready = await ev(`!!(window.__store && !window.__store.loading && document.querySelectorAll('.bookmark-item').length > 0)`).catch(() => false);
    if (ready) break;
  }
  await sleep(800);

  // T1 初始渲染
  await run('T1_render', async () => {
    const data = await ev(`(async () => ({
      sections: document.querySelectorAll('.root-section').length,
      bookmarks: document.querySelectorAll('.bookmark-item').length,
      folders: document.querySelectorAll('.cascade-node').length,
      hasBookmarkBar: [...document.querySelectorAll('.section-label')].some(e => e.textContent.includes('书签栏')),
      hasOther: [...document.querySelectorAll('.section-label')].some(e => e.textContent.includes('其他书签')),
      hasDev: ${folderEl('前端开发')} != null,
      barOrder: await ${barBookmarks},
    }))()`);
    await shot('01-home.png');
    return data;
  });

  // T2 折叠/展开（默认折叠 → 点开展开 → 再折叠）
  await run('T2_collapse', async () => {
    return await ev(`(async () => {
      const f = ${folderEl('常用工具')};
      const body = f.querySelector('.cascade-body');
      const initialCollapsed = body.getBoundingClientRect().height === 0;
      f.querySelector('.cascade-toggle').click();
      await new Promise(r => setTimeout(r, 320));
      const expanded = body.getBoundingClientRect().height > 0;
      f.querySelector('.cascade-toggle').click();
      await new Promise(r => setTimeout(r, 320));
      const collapsedAgain = body.getBoundingClientRect().height === 0;
      return { initialCollapsed, expanded, collapsedAgain };
    })()`);
  });

  // T3 拖拽排序：YouTube 移到 Notion 前
  await run('T3_drag_reorder', async () => {
    await ev(dragExpr(bmEl('YouTube'), bmEl('Notion'), 'before'));
    return await ev(barBookmarks);
  });

  // T4 拖入文件夹：Notion 拖入「设计灵感」
  await run('T4_drag_into_folder', async () => {
    await ev(dragExpr(bmEl('Notion'), folderCard('设计灵感'), 'inside'));
    return await ev(`(async () => { const roots = await window.__bm.getRoots(); const bar = roots.find(r => r.title === '书签栏'); const d = bar.children.find(c => c.title === '设计灵感'); return d.children.map(c => c.title); })()`);
  });

  // T5 文件夹嵌套：常用工具 拖入 前端开发
  await run('T5_drag_folder_nest', async () => {
    await ev(dragExpr(folderHead('常用工具'), folderCard('前端开发'), 'inside'));
    return await ev(`(async () => { const roots = await window.__bm.getRoots(); const bar = roots.find(r => r.title === '书签栏'); const dev = bar.children.find(c => c.title === '前端开发'); return dev.children.map(c => c.title); })()`);
  });

  // T6 拖回书签栏：GitHub 从常用工具拖回书签栏根卡片
  await run('T6_drag_back_out', async () => {
    await ev(dragExpr(bmEl('GitHub'), rootCard('书签栏'), 'inside'));
    const bar = await ev(barBookmarks);
    await shot('02-drag.png');
    return { barBookmarks: bar };
  });

  // T7 右键菜单
  await run('T7_context_menu', async () => {
    const items = await ev(`(async () => {
      (${bmEl('哔哩哔哩')}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
      await new Promise(r => setTimeout(r, 120));
      return [...document.querySelectorAll('.context-menu-item')].map(b => b.innerText.trim());
    })()`);
    await ev(escape);
    await sleep(100);
    return items;
  });

  // T8 搜索
  await run('T8_search', async () => {
    const data = await ev(`(async () => {
      const i = document.querySelector('.search-input'); i.value = 'vue'; i.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 350));
      return [...document.querySelectorAll('.search-result .sr-title')].map(e => e.textContent);
    })()`);
    await shot('03-search.png');
    await ev(`document.querySelector('.search-clear')?.click()`);
    await sleep(200);
    return data;
  });

  // T9 新建书签（对话框）
  await run('T9_new_bookmark', async () => {
    await ev(`document.querySelector('.btn-primary').click()`);
    await sleep(150);
    await ev(`(() => {
      const inputs = document.querySelectorAll('.modal .field-input');
      inputs[0].value = '示例站点'; inputs[0].dispatchEvent(new Event('input'));
      inputs[1].value = 'https://example.com/hello'; inputs[1].dispatchEvent(new Event('input'));
    })()`);
    await ev(`[...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent.includes('创建')).click()`);
    await sleep(700);
    return await ev(`[...document.querySelectorAll('.bookmark-title')].some(e => e.textContent === '示例站点')`);
  });

  // T10 删除到回收站并恢复
  await run('T10_trash_restore', async () => {
    const beforeTree = await ev(barAll);
    await ev(`(async () => {
      (${bmEl('示例站点')}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
      await new Promise(r => setTimeout(r, 150));
      [...document.querySelectorAll('.context-menu-item')].find(b => b.innerText.includes('删除')).click();
      await new Promise(r => setTimeout(r, 800));
    })()`);
    const trashLen = await ev(`window.__store.trash.length`);
    const afterTree = await ev(barAll);
    const trashTitles = await ev(`window.__store.trash.map(t => t.title)`);
    await ev(`(async () => {
      document.querySelector('.btn[title="回收站"]').click();
      await new Promise(r => setTimeout(r, 200));
      [...document.querySelectorAll('.trash-item')].find(i => i.querySelector('.t-title')?.textContent.includes('示例站点'))?.querySelector('.btn').click();
      await new Promise(r => setTimeout(r, 800));
      window.__store.trashOpen = false;
    })()`);
    const restoredInTree = await ev(`(async () => { const roots = await window.__bm.getRoots(); const bar = roots.find(r => r.title === '书签栏'); return bar.children.some(c => c.title === '示例站点'); })()`);
    return { beforeTree, afterTree, trashLen, trashTitles, restoredInTree };
  });

  results.pageErrors = [...new Set(pageErrors)];
  console.log(JSON.stringify(results, null, 2));
} finally {
  try { ws && ws.close(); } catch {}
  try { edge.kill('SIGTERM'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
