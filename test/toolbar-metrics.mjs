/* 量顶部工具条与胶囊的实际尺寸（字号 / 内边距 / 高度 / 圆角 / 底色） */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9253';
const C = [process.env.EDGE_BIN, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].filter(Boolean);
const BIN = C.find((p) => existsSync(p));
const profile = mkdtempSync(join(tmpdir(), 'sz2-'));
const edge = spawn(BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9253', `--user-data-dir=${profile}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
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
  await ev(`(async () => {
    const s = window.__store;
    const byTitle = (t) => [...s.nodesMap.values()].find((n) => n.url && n.title === t)?.id;
    const g = byTitle('GitHub'), v = byTitle('Vue.js');
    if (g) s.nodeMeta[g] = { desc: '', tags: ['开发'] };
    if (v) s.nodeMeta[v] = { desc: '', tags: ['开发', '常用'] };
    await new Promise((r) => setTimeout(r, 400));
    return true;
  })()`);
  console.log(JSON.stringify(await ev(`(() => {
    const m = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return { 高: Math.round(b.height), 宽: Math.round(b.width), 字号: cs.fontSize, 内边距: cs.padding, 圆角: cs.borderRadius, 底色: cs.backgroundColor, 字体粗细: cs.fontWeight };
    };
    return { 工具条: m('.board-index'), 胶囊: m('.idx-chip'), 标签: m('.idx-label'), 计数: m('.idx-count') };
  })()`), null, 1));
} finally { try { ws && ws.close(); } catch { /* ignore */ } try { edge.kill('SIGTERM'); } catch { /* ignore */ } try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
