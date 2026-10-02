/* 侧栏「两张卡片之间那条缝」+ 卡片圆角的放大取证（浅色 / 深色各一套）。
 * 目的：看清缝里到底叠了什么（阴影？背景？半透明叠加？），以及各卡片的圆角半径是否一致。
 * 用法：node test/panel-seam-shot.mjs
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9269';
const SHOT_DIR = fileURLToPath(new URL('./screens/', import.meta.url));
const C = [process.env.EDGE_BIN, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].filter(Boolean);
const BIN = C.find((p) => existsSync(p));
if (!BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');
const profile = mkdtempSync(join(tmpdir(), 'seam-'));
const edge = spawn(BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', `--remote-debugging-port=9269`, `--user-data-dir=${profile}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
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
  const clipShot = async (name, box, scale = 3) => {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale } });
    writeFileSync(SHOT_DIR + name, Buffer.from(r.data, 'base64'));
    console.log('截图:', name, JSON.stringify(box), 'x' + scale);
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://localhost:5199/' });
  for (let i = 0; i < 60; i++) { await sleep(250); if (await ev(`!!(window.__store && !window.__store.loading && document.querySelectorAll('.bookmark-item').length > 0)`).catch(() => false)) break; }
  await sleep(800);

  await ev(`(async () => {
    const s = window.__store;
    s.sidebarOpen = true;
    s.sidebarWidth = 230;
    s.panelSplit = 0.5;
    s.workspaces = [{ id: 'wSeam', name: '开始工作', icon: 'briefcase', items: [
      { id: 'b-youtube', title: 'YouTube', url: 'https://www.youtube.com' },
    ] }];
    s.wsExpanded = new Set();
    await new Promise((r) => setTimeout(r, 500));
    return true;
  })()`);

  const geo = await ev(`(() => {
    const sb = document.querySelector('.sidebar').getBoundingClientRect();
    const top = document.querySelector('.panel--workspaces').getBoundingClientRect();
    const bottom = document.querySelector('.panel--folders').getBoundingClientRect();
    const card = document.querySelector('.root-card').getBoundingClientRect();
    const lite = (el) => { const cs = getComputedStyle(el); return { radius: cs.borderRadius, shadow: cs.boxShadow, bg: cs.backgroundColor, border: cs.borderColor, backdrop: cs.backdropFilter }; };
    return {
      侧栏: { x: Math.round(sb.left), y: Math.round(sb.top), w: Math.round(sb.width), h: Math.round(sb.height) },
      上卡: { top: Math.round(top.top), bottom: Math.round(top.bottom), h: Math.round(top.height) },
      下卡: { top: Math.round(bottom.top), bottom: Math.round(bottom.bottom), h: Math.round(bottom.height) },
      缝: { top: Math.round(top.bottom), bottom: Math.round(bottom.top), h: Math.round(bottom.top - top.bottom) },
      主卡: { x: Math.round(card.left), y: Math.round(card.top), w: Math.round(card.width) },
      上卡样式: lite(document.querySelector('.panel--workspaces')),
      下卡样式: lite(document.querySelector('.panel--folders')),
      主卡样式: lite(document.querySelector('.root-card')),
      分隔条样式: lite(document.querySelector('.sidebar-splitter')),
    };
  })()`);
  console.log(JSON.stringify(geo, null, 1));

  for (const theme of ['light', 'dark']) {
    await ev(`(async () => { window.__store.theme = ${JSON.stringify(theme)}; await new Promise((r) => setTimeout(r, 500)); return true })()`);
    const seam = { x: geo.侧栏.x - 10, y: geo.缝.top - 26, width: geo.侧栏.w + 20, height: (geo.缝.h + 52) };
    await clipShot(`seam-${theme}.png`, seam, 4);
    // 下卡左上角（看圆角与卡内边距的同心关系）
    await clipShot(`card-corner-${theme}.png`, { x: geo.主卡.x - 6, y: geo.主卡.y - 6, width: 120, height: 90 }, 4);
  }
} finally { try { ws && ws.close(); } catch { /* ignore */ } try { edge.kill('SIGTERM'); } catch { /* ignore */ } try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
