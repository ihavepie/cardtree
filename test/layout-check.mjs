/* 布局校验：确认分区横向多列、搜索横跨全宽 */
import { mkdtempSync, rmSync, existsSync} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP_HTTP = 'http://127.0.0.1:9227';
const PAGE_URL = 'http://localhost:5199/';
// Edge 可能装在 /Applications 或外置卷；用 EDGE_BIN 可覆盖
const EDGE_BIN = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean).find((p) => existsSync(p));
if (!EDGE_BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');

const profile = mkdtempSync(join(tmpdir(), 'cardtree-layout-'));
const edge = spawn(EDGE_BIN, [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  '--no-first-run', `--remote-debugging-port=9227`, `--user-data-dir=${profile}`,
  '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' });

async function waitHttp(url, t = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    try { return await (await fetch(url)).json(); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('CDP 未就绪');
}

let ws;
try {
  const list = await waitHttp(CDP_HTTP + '/json');
  const target = list.find((t) => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: PAGE_URL });
  for (let i = 0; i < 60; i++) { await sleep(250); if (await ev(`!!(window.__store && !window.__store.loading)`)) break; }
  await sleep(600);

  const layout = await ev(`(() => {
    const inner = document.querySelector('.main-inner');
    const main = document.querySelector('.main');
    const sections = [...document.querySelectorAll('.root-section')];
    const lefts = sections.map(s => Math.round(s.getBoundingClientRect().left));
    const distinctColumns = new Set(lefts).size;
    const innerW = Math.round(inner.getBoundingClientRect().width);
    return {
      innerWidth: innerW,
      sectionCount: sections.length,
      sectionLefts: lefts,
      distinctColumns,
      colCount: distinctColumns,
      mainScrollHeight: main.scrollHeight,
      mainClientHeight: main.clientHeight,
    };
  })()`);
  console.log('布局:', JSON.stringify(layout, null, 2));

  // 搜索横跨全宽
  const search = await ev(`(async () => {
    const i = document.querySelector('.search-input'); i.value = 'vue'; i.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 350));
    const box = document.querySelector('.search-results');
    const inner = document.querySelector('.main-inner');
    return box ? {
      searchWidth: Math.round(box.getBoundingClientRect().width),
      innerWidth: Math.round(inner.getBoundingClientRect().width),
      spansFull: Math.abs(box.getBoundingClientRect().width - inner.getBoundingClientRect().width) < 4,
    } : { noResults: true };
  })()`);
  console.log('搜索:', JSON.stringify(search, null, 2));
} finally {
  try { ws && ws.close(); } catch {}
  try { edge.kill('SIGTERM'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
