/* 「还有没有紫色」审计：把页面上每个元素的计算样式（文字色 / 底色 / 边框 / 阴影）转成 HSL，
 * 凡是落在**紫/靛蓝**色相区间（230°–300° 且饱和度 > 0.15）的就报出来。
 * 光看截图容易漏（阴影、边框、伪元素），所以用色相判定来兜底。
 * 用法：node test/no-purple-check.mjs
 * 白名单：颜色选择器的调色板（那是给用户挑 Folder/Icon 颜色的选项，不是界面配色）。
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9267';
const SHOT_DIR = fileURLToPath(new URL('./screens/', import.meta.url));
const C = [process.env.EDGE_BIN, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].filter(Boolean);
const BIN = C.find((p) => existsSync(p));
if (!BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');
const profile = mkdtempSync(join(tmpdir(), 'nopurple-'));
const edge = spawn(BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9267', `--user-data-dir=${profile}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SWEEP = `(() => {
  const hue = (r, g, b) => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return { h: 0, s: 0 };
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    const l = (max + min) / 2 / 255;
    const s = d / 255 / (1 - Math.abs(2 * l - 1) || 1);
    return { h, s };
  };
  const PURPLE = (h, s) => h >= 228 && h <= 305 && s > 0.15;
  const parse = (str) => {
    const m = String(str).match(/rgba?\\(([^)]+)\\)/g) || [];
    const out = [];
    for (const one of m) {
      const p = one.match(/([\\d.]+)/g).map(Number);
      if (p.length >= 3 && (p.length < 4 || p[3] > 0.02)) out.push(p);
    }
    return out;
  };
  const bad = [];
  const skip = (el) => el.closest('.icon-color-dot, .icon-opt, .bg-preset, .bg-color-swatch, .tag-color');
  for (const el of document.querySelectorAll('body *')) {
    if (skip(el)) continue;
    const cs = getComputedStyle(el);
    for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderRightColor', 'boxShadow', 'backgroundImage', 'fill', 'stroke']) {
      for (const p of parse(cs[prop])) {
        const { h, s } = hue(p[0], p[1], p[2]);
        if (PURPLE(h, s)) {
          bad.push({
            sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : ''),
            prop,
            value: cs[prop].slice(0, 90),
            hue: Math.round(h), sat: Math.round(s * 100),
          });
          break;
        }
      }
      if (bad.length > 40) break;
    }
  }
  // 去重
  const seen = new Set();
  return bad.filter((b) => { const k = b.sel + b.prop + b.value; if (seen.has(k)) return false; seen.add(k); return true; });
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

  // 打开一些面板，让更多配色进入 DOM（详情抽屉、右键菜单、便签、背景面板）
  await ev(`(async () => {
    const s = window.__store;
    s.workspaces = [{ id: 'wP', name: '审计组', icon: 'briefcase', items: [{ id: 'b-youtube', title: 'YouTube', url: 'https://www.youtube.com' }] }];
    s.wsExpanded = new Set(['wP']);
    s.sidebarOpen = true;
    await new Promise((r) => setTimeout(r, 400));
    return true;
  })()`);

  const report = {};
  for (const theme of ['light', 'dark']) {
    await ev(`(async () => { window.__store.theme = ${JSON.stringify(theme)}; await new Promise((r) => setTimeout(r, 500)); return true })()`);
    report[theme] = await ev(SWEEP);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOT_DIR + `no-purple-${theme}.png`, Buffer.from(r.data, 'base64'));
  }
  console.log(JSON.stringify(report, null, 1));
  const total = report.light.length + report.dark.length;
  console.log(total === 0 ? '\n✅ 没有紫色残留（浅色 / 深色均为 0）' : `\n⚠️ 仍有 ${total} 处紫色残留`);
} finally { try { ws && ws.close(); } catch { /* ignore */ } try { edge.kill('SIGTERM'); } catch { /* ignore */ } try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
