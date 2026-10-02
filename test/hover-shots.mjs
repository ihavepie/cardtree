/* 交互态（hover / active）观感截图：浅色 + 深色各来一套，重点看
 *   侧栏文件夹行 / 工作区行 / 主卡片书签 / 看板索引胶囊 / 卡片表头的「＋ 新建」
 * 用法：node test/hover-shots.mjs
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9266';
const SHOT_DIR = fileURLToPath(new URL('./screens/', import.meta.url));
const C = [process.env.EDGE_BIN, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].filter(Boolean);
const BIN = C.find((p) => existsSync(p));
if (!BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');
const profile = mkdtempSync(join(tmpdir(), 'hover-shots-'));
const edge = spawn(BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9266', `--user-data-dir=${profile}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
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
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOT_DIR + name, Buffer.from(r.data, 'base64'));
    console.log('截图:', name);
  };
  const center = (sel) => ev(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  const hover = async (sel) => {
    const p = await center(sel);
    if (!p) { console.log('  跳过（没找到 ' + sel + '）'); return false; }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 });
    await sleep(320);
    return true;
  };
  // 读一组元素的"悬停后计算样式"，用来核对没有紫色残留
  const probe = (sel) => ev(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    const cs = getComputedStyle(e);
    return { color: cs.color, background: cs.backgroundColor, border: cs.borderColor, shadow: cs.boxShadow };
  })()`);

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://localhost:5199/' });
  for (let i = 0; i < 60; i++) { await sleep(250); if (await ev(`!!(window.__store && !window.__store.loading && document.querySelectorAll('.bookmark-item').length > 0)`).catch(() => false)) break; }
  await sleep(800);

  // 造一个真实感状态：一个展开的工作区 + 若干文件夹
  await ev(`(async () => {
    const s = window.__store;
    s.sidebarOpen = true;
    s.sidebarWidth = 230;
    s.panelSplit = 0.45;
    s.workspaces = [{ id: 'wShot', name: '开始工作', icon: 'briefcase', items: [
      { id: 'b-youtube', title: 'YouTube', url: 'https://www.youtube.com' },
      { id: 'b-notion', title: 'Notion', url: 'https://www.notion.so' },
    ] }];
    s.wsExpanded = new Set(['wShot']);
    await new Promise((r) => setTimeout(r, 500));
    return true;
  })()`);

  for (const theme of ['light', 'dark']) {
    await ev(`(async () => { window.__store.theme = ${JSON.stringify(theme)}; await new Promise((r) => setTimeout(r, 500)); return true })()`);
    await hover('.sf-row');                       // 侧栏：文件夹行
    await shot(`hover-${theme}-sidebar.png`);
    const folderRow = await probe('.sf-row:hover');
    await hover('.ws-row');                       // 侧栏：工作区行
    const wsRow = await probe('.ws-row:hover');
    await hover('.panel-act--text');              // 侧栏：表头「＋ 新建」
    await shot(`hover-${theme}-newbtn.png`);
    const newBtn = await probe('.panel-act--text');
    await hover('.bookmark-item');                // 主区：书签
    await shot(`hover-${theme}-main.png`);
    const bm = await probe('.bookmark-item:hover');
    await hover('.idx-chip');                     // 看板索引胶囊
    const chip = await probe('.idx-chip:hover');
    console.log(`--- ${theme} ---`);
    for (const [k, v] of Object.entries({ 文件夹行: folderRow, 工作区行: wsRow, 新建按钮: newBtn, 书签: bm, 索引胶囊: chip })) {
      console.log(' ', k, v ? JSON.stringify(v) : 'null');
    }
  }
} finally { try { ws && ws.close(); } catch { /* ignore */ } try { edge.kill('SIGTERM'); } catch { /* ignore */ } try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
