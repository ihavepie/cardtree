/* 新建标签页的垂直预算审计：谁吃掉了多少高度、不滚动能看到多少内容 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9263';
const C = [process.env.EDGE_BIN, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].filter(Boolean);
const BIN = C.find((p) => existsSync(p));
const profile = mkdtempSync(join(tmpdir(), 'budget-'));
const edge = spawn(BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9263', `--user-data-dir=${profile}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
try {
  let list; const t0 = Date.now();
  while (Date.now() - t0 < 15000) { try { list = await (await fetch(CDP + '/json')).json(); break; } catch { await sleep(250); } }
  ws = new WebSocket(list.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://localhost:5199/' });
  for (let i = 0; i < 60; i++) { await sleep(250); if (await ev(`!!(window.__store && !window.__store.loading && document.querySelectorAll('.bookmark-item').length > 0)`).catch(() => false)) break; }
  await sleep(700);

  // 造一个"用了一阵子"的真实状态：6 条最近、3 个标签、若干书签
  await ev(`(async () => {
    const s = window.__store;
    s.theme = 'light';
    s.recent = ['YouTube','Notion','GitHub','维基百科','知乎','Figma'].map((t, i) => ({ id: 'r' + i, title: t, url: 'https://e.com/' + i }));
    const byTitle = (t) => [...s.nodesMap.values()].find((n) => n.url && n.title === t)?.id;
    const g = byTitle('GitHub'), v = byTitle('Vue.js'), m = byTitle('MDN 文档');
    if (g) s.nodeMeta[g] = { desc: '', tags: ['开发', '常用'] };
    if (v) s.nodeMeta[v] = { desc: '', tags: ['开发'] };
    if (m) s.nodeMeta[m] = { desc: '', tags: ['文档'] };
    // 展开两个文件夹，模拟"用了一阵子"
    s.collapsed = new Set();
    await new Promise((r) => setTimeout(r, 700));
    return true;
  })()`);
  await sleep(600);

  // 再量一次"书签很多"的情况。注意 mock 的 create 是 **async**，不能按 callback 传 res（会 hang）
  await ev(`(async () => {
    const s = window.__store;
    const bm = window.__bm;
    const bar = s.roots.find((r) => (r.title || '').includes('书签栏')) || s.roots[0];
    for (let i = 0; i < 24; i++) {
      await bm.create(bar.id, { title: '很长的书签标题 ' + i, url: 'https://example.com/page/' + i });
    }
    for (let f = 0; f < 4; f++) {
      const folder = await bm.create(bar.id, { title: '文件夹 ' + f });
      for (let i = 0; i < 9; i++) {
        await bm.create(folder.id, { title: '子书签 ' + f + '-' + i, url: 'https://example.com/f' + f + '/' + i });
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
    return true;
  })()`);
  await sleep(1200);
  console.log('--- 书签很多时（书签栏 +24，另加 4 个文件夹各 9 个）---');
  const measure = `(() => {
    const H = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height) }; };
    const main = document.querySelector('.main');
    const card = document.querySelector('.root-card');
    return {
      布局模式: window.__store.layoutMode,
      书签栏卡高: Math.round(card.getBoundingClientRect().height),
      内容总高: main.scrollHeight,
      滚动量: Math.round(main.scrollHeight - main.clientHeight),
      文件夹栏数: new Set([...document.querySelectorAll('.root-card > .cascade-children > .cascade-node')].map((e) => Math.round(e.getBoundingClientRect().left))).size,
      最近浏览区: H('.recent-section'),
    };
  })()`;
  // 再量一次"并排"模式
  await ev(`(async () => { window.__store.layoutMode = 'columns'; await new Promise((r) => setTimeout(r, 800)); return true; })()`);
  await sleep(600);
  console.log('--- 切到「并排（自动列数）」后 ---');
  console.log(JSON.stringify(await ev(measure), null, 1));
  await ev(`(async () => { window.__store.layoutMode = 'stack'; await new Promise((r) => setTimeout(r, 600)); return true; })()`);
  await sleep(400);
  console.log(JSON.stringify(await ev(`(() => {
    const H = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height) }; };
    const main = document.querySelector('.main');
    const card = document.querySelector('.root-card');
    const cs = getComputedStyle(card);
    const chips = [...document.querySelectorAll('.root-card > .bookmark-grid .bookmark-item')];
    const rows = new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top))).size;
    const folderRows = [...document.querySelectorAll('.root-card > .cascade-children > .cascade-node')];
    return {
      视口高: window.innerHeight,
      顶栏: H('.topbar'),
      工具条: H('.board-index'),
      工具条下间距: (() => { const a = document.querySelector('.board-index').getBoundingClientRect(); const b = card.getBoundingClientRect(); return Math.round(b.top - a.bottom); })(),
      书签栏卡: { 顶部: Math.round(card.getBoundingClientRect().top), 高: Math.round(card.getBoundingClientRect().height), 内边距: cs.padding },
      最近浏览区: H('.recent-section'),
      最近条目: (() => { const c = document.querySelector('.recent-item'); if (!c) return null; const b = c.getBoundingClientRect(); return { 高: Math.round(b.height), 列数: getComputedStyle(document.querySelector('.recent-grid')).gridTemplateColumns.split(' ').length }; })(),
      书签芯片: (() => { const c = chips[0]; if (!c) return null; const b = c.getBoundingClientRect(); return { 高: Math.round(b.height), 宽: Math.round(b.width), 字号: getComputedStyle(c).fontSize }; })(),
      书签可见: { 个数: chips.length, 行数: rows },
      文件夹行: (() => { const f = folderRows[0]; if (!f) return null; const head = f.querySelector('.cascade-heading') || f; return { 行高: Math.round(head.getBoundingClientRect().height), 个数: folderRows.length }; })(),
      内容总高: main.scrollHeight,
      需要滚动: main.scrollHeight > main.clientHeight,
      滚动量: Math.round(main.scrollHeight - main.clientHeight),
      不滚动能看到: (() => {
        const vh = main.clientHeight;
        const seen = [...document.querySelectorAll('.root-card .bookmark-item, .root-card .cascade-heading')]
          .filter((e) => e.getBoundingClientRect().bottom <= main.getBoundingClientRect().top + vh).length;
        return seen;
      })(),
    };
  })()`), null, 1));
} finally { try { ws && ws.close(); } catch { /* ignore */ } try { edge.kill('SIGTERM'); } catch { /* ignore */ } try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
