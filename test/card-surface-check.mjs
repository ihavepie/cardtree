/* 「卡片」一致性审计：凡是用了**卡片配方**（--card-bg 玻璃底 + backdrop-filter + --card-shadow）的
 * 表面，都必须带上同一条玻璃边（--card-border）。少一个就会显得"四张卡里有一张没轮廓"。
 * 用途：这一条是用户实际提过的观感问题（主卡片上方那条看板索引条漏了边），钉成断言免得再漏。
 * 用法：node test/card-surface-check.mjs
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9271';
const SHOT_DIR = fileURLToPath(new URL('./screens/', import.meta.url));
const C = [process.env.EDGE_BIN, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].filter(Boolean);
const BIN = C.find((p) => existsSync(p));
if (!BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');
const profile = mkdtempSync(join(tmpdir(), 'cardsurf-'));
const edge = spawn(BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', `--remote-debugging-port=9271`, `--user-data-dir=${profile}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 页面里跑：列出所有"卡片面"。
// 注意：卡片配方**不能**用 backdrop-filter 来判定 —— 无头环境（--disable-gpu）里
// backdrop-filter 一律算成 none（真机才有毛玻璃）。所以用「圆角 + 底色 + 投影 + 尺寸」来认。
const SWEEP = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    if (b.width < 180 || b.height < 40 || b.width * b.height < 9000) continue;
    const r = parseFloat(cs.borderTopLeftRadius) || 0;
    if (r < 9) continue;
    if (!/rgba?\\(/.test(cs.boxShadow) && cs.boxShadow !== 'none') return out;  // 占位，下面分支不走这里
    if (cs.boxShadow === 'none') continue;                                     // 卡片一定有投影
    if (/rgba\\(0, 0, 0, 0\\)/.test(cs.backgroundColor)) continue;              // 卡片一定有底色
    const transparent = /rgba\\(0, 0, 0, 0\\)|transparent/.test(cs.borderTopColor) || cs.borderTopWidth === '0px';
    out.push({
      sel: el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''),
      radius: r,
      borderWidth: cs.borderTopWidth,
      borderColor: cs.borderTopColor,
      有边: !transparent,
      bg: cs.backgroundColor,
    });
  }
  const seen = new Set();
  return out.filter((x) => { if (seen.has(x.sel)) return false; seen.add(x.sel); return true; });
})()`;

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
  await sleep(800);

  // 让四张卡同时在场：侧栏保持打开（不然两张侧栏卡会被压成 0 宽），
  // 给书签打标签让顶部看板索引条渲染出来（它只在"侧栏收起 / 有标签"时出现）。
  await ev(`(async () => {
    const s = window.__store;
    s.sidebarOpen = true;
    const bms = [...s.nodesMap.values()].filter((n) => n.url).slice(0, 2);
    bms.forEach((n, i) => { s.nodeMeta[n.id] = { desc: '', tags: [i ? '文档' : '开发'] }; });
    await new Promise((r) => setTimeout(r, 600));
    return true;
  })()`);
  const hasIndex = await ev(`!!document.querySelector('.board-index')`);
  console.log('看板索引条是否在场:', hasIndex);

  const report = {};
  for (const theme of ['light', 'dark']) {
    await ev(`(async () => { window.__store.theme = ${JSON.stringify(theme)}; await new Promise((r) => setTimeout(r, 500)); return true })()`);
    report[theme] = await ev(SWEEP);
    // 顺带把这张"四张卡同框"的样子存下来（看板索引条那一带最容易看出边有没有漏）
    const clip = await ev(`(() => {
      const bar = document.querySelector('.board-index').getBoundingClientRect();
      const card = document.querySelector('.root-card').getBoundingClientRect();
      const p = document.querySelector('.panel--workspaces').getBoundingClientRect();
      const x = Math.round(Math.min(p.left, bar.left)) - 8;
      return { x, y: Math.round(Math.min(bar.top, p.top)) - 8, width: Math.round(bar.width + (bar.left - x) + 8), height: Math.round(card.top + 40 - bar.top) + 8 };
    })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 2 } });
    writeFileSync(SHOT_DIR + `card-surfaces-${theme}.png`, Buffer.from(shot.data, 'base64'));
  }
  console.log(JSON.stringify(report, null, 1));

  for (const theme of ['light', 'dark']) {
    const rows = report[theme];
    const missing = rows.filter((r) => !r.有边).map((r) => r.sel);
    const expected = ['div.root-card', 'nav.board-index', 'section.panel.panel--workspaces', 'section.panel.panel--folders'];
    const absent = expected.filter((sel) => !rows.some((r) => r.sel === sel));
    console.log(`--- ${theme} ---`);
    console.log('  卡片面:', rows.map((r) => `${r.sel}${r.有边 ? ' ✓' : ' ✗无边框'}`).join(', '));
    console.log('  漏掉边框的:', missing.length ? missing.join(', ') : '无');
    console.log('  没找到的卡片面:', absent.length ? absent.join(', ') : '无');
    if (missing.length || absent.length) process.exitCode = 1;
  }
  console.log(process.exitCode ? '\n❌ 卡片一致性不通过' : '\n✅ 四张卡片都带同一条玻璃边');
  console.log('截图: test/screens/card-surfaces-{light,dark}.png');
} finally { try { ws && ws.close(); } catch { /* ignore */ } try { edge.kill('SIGTERM'); } catch { /* ignore */ } try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
