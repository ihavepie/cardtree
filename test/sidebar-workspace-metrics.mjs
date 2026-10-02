/* 侧栏「工作区 + 文件夹」控件尺寸审计 + 局部放大截图。
 * 动机：用户反馈「新建工作区的按钮和工作区的按钮都比较小」。
 * 这里把行高、名称可用宽度、动作按钮的命中区、表头按钮、标签页行的尺寸都量出来，
 * 改 CSS 前后各跑一次对比（`node test/sidebar-workspace-metrics.mjs before|after`）。
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LABEL = process.argv[2] || 'now';
const CDP = 'http://127.0.0.1:9264';
const SHOT_DIR = fileURLToPath(new URL('./screens/', import.meta.url));
const C = [process.env.EDGE_BIN, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].filter(Boolean);
const BIN = C.find((p) => existsSync(p));
const profile = mkdtempSync(join(tmpdir(), 'wsmetrics-'));
const edge = spawn(BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9264', `--user-data-dir=${profile}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
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

  // 真实感数据：短名 / 长名各一，其中一组展开（看标签页行）
  await ev(`(async () => {
    const s = window.__store;
    s.theme = 'light';
    s.sidebarOpen = true;
    s.sidebarWidth = 230;
    s.panelSplit = 0.5;
    s.workspaces = [
      { id: 'wA', name: '开始工作', icon: 'briefcase', items: [
        { id: 'b-youtube', title: 'YouTube', url: 'https://www.youtube.com' },
        { id: 'b-notion', title: 'Notion', url: 'https://www.notion.so' },
      ] },
      { id: 'wB', name: '一个名字相当长的工作区分组', icon: 'zap', items: [
        { id: 'b-github', title: 'GitHub', url: 'https://github.com' },
      ] },
    ];
    s.wsExpanded = new Set(['wA']);
    await new Promise((r) => setTimeout(r, 600));
    return true;
  })()`);
  await sleep(700);

  const metrics = await ev(`(() => {
    const box = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return {
        宽: Math.round(b.width * 10) / 10,
        高: Math.round(b.height * 10) / 10,
        字号: cs.fontSize,
        内边距: cs.padding,
        圆角: cs.borderRadius,
      };
    };
    const row = document.querySelector('.ws-row');
    const name = document.querySelector('.ws-row .ws-name');
    const longName = document.querySelectorAll('.ws-row .ws-name')[1];
    return {
      侧栏宽: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
      面板可用宽: Math.round(document.querySelector('.panel--workspaces .panel-body').clientWidth),
      工作区行: box('.ws-row'),
      工作区名称宽_短: name ? Math.round(name.getBoundingClientRect().width) : null,
      工作区名称宽_长: longName ? Math.round(longName.getBoundingClientRect().width) : null,
      工作区名称是否被截断: longName ? longName.scrollWidth > longName.clientWidth + 1 : null,
      计数槽: box('.ws-slot'),
      行内按钮: box('.ws-act'),
      行内按钮图标: (() => { const s = document.querySelector('.ws-act svg'); return s ? Math.round(s.getBoundingClientRect().width * 10) / 10 : null; })(),
      表头新建按钮: box('.panel--workspaces .panel-act'),
      表头新建图标: (() => { const s = document.querySelector('.panel--workspaces .panel-act svg'); return s ? Math.round(s.getBoundingClientRect().width * 10) / 10 : null; })(),
      表头计数: box('.panel--workspaces .panel-count'),
      标签页行: box('.ws-tab'),
      标签页移除按钮: box('.ws-tab-x'),
      标签页图标: box('.ws-tab-fav'),
      空态新建链接: box('.ws-empty .link-btn'),
      文件夹行按钮: box('.sf-act'),
      文件夹行: box('.sf-row'),
      文件夹名称宽: (() => { const e = document.querySelector('.sf-row .sf-name'); return e ? Math.round(e.getBoundingClientRect().width) : null; })(),
    };
  })()`);
  console.log(JSON.stringify(metrics, null, 1));

  // 局部放大截图：工作区卡 + 文件夹卡上部
  const clip = await ev(`(() => {
    const p = document.querySelector('.panel--workspaces').getBoundingClientRect();
    const f = document.querySelector('.panel--folders').getBoundingClientRect();
    return { x: Math.round(p.left) - 6, y: Math.round(p.top) - 6, w: Math.round(p.width) + 12, h: Math.round(p.height + f.height / 2) + 12 };
  })()`);
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 2 },
  });
  writeFileSync(SHOT_DIR + `ws-controls-${LABEL}.png`, Buffer.from(shot.data, 'base64'));
  console.log('截图: test/screens/ws-controls-' + LABEL + '.png');

  // 悬停态：行内动作按钮只有 hover 才浮出，得单独截一张（顺便量一下浮出时的按钮尺寸）
  const rowBox = await ev(`(() => {
    const r = document.querySelector('.ws-row').getBoundingClientRect();
    return { x: Math.round(r.left + r.width * 0.6), y: Math.round(r.top + r.height / 2) };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowBox.x, y: rowBox.y, buttons: 0 });
  await sleep(400);
  const hoverState = await ev(`(() => {
    const acts = document.querySelector('.ws-row .ws-actions');
    const a = document.querySelector('.ws-act');
    const b = a.getBoundingClientRect();
    return {
      动作组可见: getComputedStyle(acts).opacity,
      按钮: { 宽: Math.round(b.width), 高: Math.round(b.height) },
      按钮数: document.querySelectorAll('.ws-row .ws-act').length,
      计数已让位: getComputedStyle(document.querySelector('.ws-row .ws-count')).opacity,
    };
  })()`);
  console.log('悬停态:', JSON.stringify(hoverState));
  const shot2 = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 2 },
  });
  writeFileSync(SHOT_DIR + `ws-controls-${LABEL}-hover.png`, Buffer.from(shot2.data, 'base64'));
  console.log('截图: test/screens/ws-controls-' + LABEL + '-hover.png');
} finally { try { ws && ws.close(); } catch { /* ignore */ } try { edge.kill('SIGTERM'); } catch { /* ignore */ } try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
