/* 看板索引条校验：文件夹跳转 + 标签聚合/筛选 + 空态 + 与搜索/前N折叠的相互作用
   用法：python3 -m http.server 5199 --directory dist & 然后 node test/board-index-check.mjs [宽] [高] */
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const W = Number(process.argv[2] || 1440);
const H = Number(process.argv[3] || 940);
const CDP_HTTP = 'http://127.0.0.1:9238';
const PAGE_URL = 'http://localhost:5199/';
const SHOT_DIR = fileURLToPath(new URL('./screens/', import.meta.url));
const EDGE_CANDIDATES = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);
const EDGE_BIN = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE_BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');

mkdirSync(SHOT_DIR, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'cardtree-boardindex-'));
const edge = spawn(EDGE_BIN, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  `--remote-debugging-port=9238`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });

async function waitHttp(url, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { return await (await fetch(url)).json(); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('CDP 未就绪');
}

// 当前看板状态：索引条内容 / 渲染出的书签 / 文件夹卡片
const SNAPSHOT = `(() => {
  const chips = [...document.querySelectorAll('.board-index .idx-chip')];
  const groups = [...document.querySelectorAll('.board-index .idx-group')].map(g => ({
    label: g.querySelector('.idx-label')?.textContent,
    chips: [...g.querySelectorAll('.idx-chip')].map(c => c.textContent.trim()),
  }));
  const cards = [...document.querySelectorAll('.root-section')].map(s => ({
    children: [...s.querySelector('.root-card').children].filter(e => e.classList.contains('cascade-children') || e.classList.contains('bookmark-grid')).length,
  }));
  const folders = [...document.querySelectorAll('.root-card .cascade-node')].map(n => {
    const t = n.querySelector('.cascade-title-text');
    return t ? t.textContent : null;
  }).filter(Boolean);
  return {
    hasIndex: !!document.querySelector('.board-index'),
    groups,
    chipCount: chips.length,
    activeChip: (document.querySelector('.board-index .idx-chip.active') || {}).textContent?.trim() || null,
    hasClear: !!document.querySelector('.board-index .idx-clear'),
    rootSections: cards.length,
    folders,
    bookmarkCount: document.querySelectorAll('.bookmark-item').length,
    titles: [...document.querySelectorAll('.bookmark-title')].map(e => e.textContent),
    emptyHint: (document.querySelector('.board-filter-empty .big') || {}).textContent || null,
    moreButtons: document.querySelectorAll('.grid-more').length,
  };
})()`;

let ws;
try {
  const list = await waitHttp(CDP_HTTP + '/json');
  const target = list.find((t) => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOT_DIR, `index-${name}.png`), Buffer.from(data, 'base64'));
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: PAGE_URL });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (await ev(`!!(window.__store && !window.__store.loading && document.querySelectorAll('.bookmark-item').length > 0)`).catch(() => false)) break;
  }
  await sleep(900);

  const report = {};
  report['1_无标签时'] = await ev(SNAPSHOT);

  // 侧边栏分工：开着 → 不重复列文件夹（只剩标签组，没标签时整条不出现）；收起 → 接管文件夹跳转
  report['0_分工'] = {
    侧边栏开着: {
      hasIndex: await ev(`!!document.querySelector('.board-index')`),
      分组: await ev(`[...document.querySelectorAll('.board-index .idx-group')].map(g => g.querySelector('.idx-label')?.textContent)`),
    },
    侧边栏收起: await ev(`(async () => {
      window.__store.sidebarOpen = false;
      await new Promise(r => setTimeout(r, 400));
      const out = {
        分组: [...document.querySelectorAll('.board-index .idx-group')].map(g => g.querySelector('.idx-label')?.textContent),
        文件夹胶囊: [...document.querySelectorAll('.board-index .idx-group')].find(g => g.querySelector('.idx-label')?.textContent === '文件夹')?.querySelectorAll('.idx-chip').length ?? 0,
      };
      window.__store.sidebarOpen = true;
      await new Promise(r => setTimeout(r, 300));
      return out;
    })()`),
  };

  // 侧边栏收起时主区更宽：并排模式能多放一栏
  report['0_收起侧边栏的宽度收益'] = await ev(`(async () => {
    const s = window.__store;
    const before = { mode: s.layoutMode };
    s.layoutMode = 'columns';
    await new Promise(r => setTimeout(r, 400));
    const measure = () => {
      const card = document.querySelector('.root-card');
      const nodes = [...document.querySelectorAll('.root-card > .cascade-children > .cascade-node')];
      const lefts = [...new Set(nodes.map(n => Math.round(n.getBoundingClientRect().left)))];
      return { 卡片宽: Math.round(card.getBoundingClientRect().width), 文件夹栏数: lefts.length };
    };
    s.sidebarOpen = true;
    await new Promise(r => setTimeout(r, 400));
    const withSidebar = measure();
    s.sidebarOpen = false;
    await new Promise(r => setTimeout(r, 500));
    const withoutSidebar = measure();
    s.sidebarOpen = true;
    s.layoutMode = before.mode;
    await new Promise(r => setTimeout(r, 400));
    return { 侧边栏开着: withSidebar, 侧边栏收起: withoutSidebar };
  })()`);

  // 给几个书签打标签：GitHub→开发, Vue.js→开发, MDN 文档→文档；再用一个不存在的标签做空态
  await ev(`(async () => {
    const s = window.__store;
    const find = (name) => [...document.querySelectorAll('.bookmark-item')]
      .map(e => e.dataset.id)
      .find(id => (s.nodesMap.get(id) || {}).title === name);
    const byTitle = (t) => [...s.nodesMap.values()].find(n => n.url && n.title === t)?.id;
    const g = byTitle('GitHub'), v = byTitle('Vue.js'), m = byTitle('MDN 文档');
    s.nodeMeta[g] = { desc: '', tags: ['开发', '常用'] };
    s.nodeMeta[v] = { desc: '', tags: ['开发'] };
    s.nodeMeta[m] = { desc: '', tags: ['文档'] };
    await new Promise(r => setTimeout(r, 400));
    return [g, v, m].filter(Boolean).length;
  })()`);
  await sleep(600);
  report['2_打上标签后'] = await ev(SNAPSHOT);
  await shot('01-tags');

  // 点「开发」标签 → 只应剩下 GitHub / Vue.js，且空文件夹被剪掉、前 N 折叠让位
  await ev(`(async () => {
    const chip = [...document.querySelectorAll('.board-index .idx-chip')].find(c => c.textContent.trim().startsWith('开发'));
    if (!chip) return false;
    chip.click();
    await new Promise(r => setTimeout(r, 500));
    return true;
  })()`);
  await sleep(600);
  report['3_筛选开发'] = await ev(SNAPSHOT);
  await shot('02-filtered');

  // 再点同一个标签 = 取消
  await ev(`(async () => {
    const chip = [...document.querySelectorAll('.board-index .idx-chip')].find(c => c.textContent.trim().startsWith('开发'));
    chip && chip.click();
    await new Promise(r => setTimeout(r, 500));
    return true;
  })()`);
  await sleep(500);
  report['4_再点取消'] = {
    tagFilter: await ev(`window.__store.tagFilter`),
    bookmarkCount: await ev(`document.querySelectorAll('.bookmark-item').length`),
  };

  // 空态：手动设一个没人用的标签
  await ev(`(async () => { window.__store.tagFilter = '不存在的标签'; await new Promise(r => setTimeout(r, 400)); return true })()`);
  await sleep(500);
  report['5_空态'] = await ev(SNAPSHOT);
  await shot('03-empty');
  await ev(`window.__store.tagFilter = ''`);

  // 文件夹索引条：点「前端开发」应展开并定位（focusId + 展开）
  // 注意：文件夹胶囊按分工设计只在侧边栏收起时出现（App.vue 的 showFolderChips），
  // 所以这里必须先收起侧边栏，否则根本找不到胶囊 —— 步骤结束再还原。
  await ev(`(async () => { window.__store.collapsed = new Set(); await new Promise(r => setTimeout(r, 300)); return true })()`);
  const folderJump = await ev(`(async () => {
    window.__store.sidebarOpen = false;
    await new Promise(r => setTimeout(r, 400));
    const chip = [...document.querySelectorAll('.board-index .idx-chip')].find(c => c.textContent.trim().startsWith('前端开发'));
    if (!chip) { window.__store.sidebarOpen = true; return { err: '索引条里没有 前端开发' }; }
    window.__store.collapsed.add('f-dev');            // 先折叠，验证点击会展开
    await new Promise(r => setTimeout(r, 300));
    const before = { collapsed: window.__store.collapsed.has('f-dev'), focus: window.__store.focusId };
    chip.click();
    await new Promise(r => setTimeout(r, 600));
    const el = document.querySelector('.main [data-id="f-dev"]');
    const out = {
      before,
      after: { collapsed: window.__store.collapsed.has('f-dev'), focus: window.__store.focusId, found: !!el },
      bodyVisible: el ? Math.round(el.getBoundingClientRect().height) > 0 : null,
    };
    window.__store.sidebarOpen = true;
    await new Promise(r => setTimeout(r, 300));
    return out;
  })()`);
  report['6_文件夹跳转'] = folderJump;
  await shot('04-jump');

  // 搜索优先级：搜索时应让位给搜索结果
  report['7_搜索时索引条'] = await ev(`(async () => {
    const i = document.querySelector('.search-input'); i.value = 'vue'; i.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 400));
    const out = { hasIndex: !!document.querySelector('.board-index'), hasSearch: !!document.querySelector('.search-results') };
    i.value = ''; i.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 300));
    return out;
  })()`);

  report.pageErrors = await ev(`window.__pageErrors || []`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  try { ws && ws.close(); } catch {}
  try { edge.kill('SIGTERM'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
