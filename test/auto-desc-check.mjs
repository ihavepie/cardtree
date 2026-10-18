/* 详情抽屉的「自动获取描述」：点一下 → 抓网页 <meta description> → 填进描述框 → 保存落库。
 * （老版本这功能在"悬浮面板"里，那时测 .pop-auto；面板早已被详情抽屉取代，脚本跟着重写到 .dd-auto。
 *   fetch 用桩替换，不依赖外网，也不依赖扩展的 host_permissions。）
 * 用法：node test/auto-desc-check.mjs
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9280';
const PAGE = 'http://localhost:5199/';
const C = [process.env.EDGE_BIN, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].filter(Boolean);
const BIN = C.find((p) => existsSync(p));
if (!BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');
const profile = mkdtempSync(join(tmpdir(), 'autodesc-'));
const edge = spawn(BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=9280`, `--user-data-dir=${profile}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const pageErrors = [];

let ws;
try {
  let list; const t0 = Date.now();
  while (Date.now() - t0 < 15000) { try { list = await (await fetch(CDP + '/json')).json(); break; } catch { await sleep(250); } }
  ws = new WebSocket(list.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: PAGE });
  for (let i = 0; i < 60; i++) { await sleep(250); if (await ev(`document.querySelectorAll('.bookmark-item').length > 0`)) break; }
  await sleep(400);

  // 1) 单击书签 → 详情抽屉打开
  await ev(`(async () => {
    document.querySelectorAll('.bookmark-item')[0].click();
    await new Promise((r) => setTimeout(r, 300));
    return true;
  })()`);
  const drawer = await ev(`({
    打开: !!document.querySelector('.detail-drawer'),
    有自动按钮: !!document.querySelector('.dd-auto'),
    有描述框: !!document.querySelector('.dd-textarea'),
  })`);

  // 2) fetch 打桩：返回带 <meta name="description"> 的页面（连续空白应被压成一个）
  await ev(`(() => {
    window.__fetchCalls = [];
    window.fetch = (u) => {
      window.__fetchCalls.push(String(u));
      const html = '<html><head><meta name="description" content="  这是个   测试描述  "></head><body>x</body></html>';
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(html) });
    };
    return true;
  })()`);

  // 3) 点「自动获取」→ 描述框被填上
  await ev(`document.querySelector('.dd-auto').click()`);
  await sleep(700);
  const fetched = await ev(`({
    描述框内容: document.querySelector('.dd-textarea')?.value ?? null,
    请求了: window.__fetchCalls.slice(),
    toast: document.querySelector('.toast .toast-msg')?.textContent.trim() || null,
  })`);

  // 4) 保存 → 落进 nodeMeta
  await ev(`document.querySelector('.dd-actions .btn-primary').click()`);
  await sleep(400);
  const saved = await ev(`(() => {
    const s = window.__store;
    const id = s.selection.size ? [...s.selection][0] : null;
    const meta = id ? s.nodeMeta[id] : null;
    return { id, desc: meta?.desc ?? null, toast: document.querySelector('.toast .toast-msg')?.textContent.trim() || null };
  })()`);

  results.drawer = drawer;
  results.fetched = fetched;
  results.saved = saved;
  results.pageErrors = pageErrors;
  results.断言 = {
    抽屉里有自动获取: drawer.打开 && drawer.有自动按钮 && drawer.有描述框,
    描述被填上: (fetched.描述框内容 || '').trim() === '这是个 测试描述',
    真的发了请求: (fetched.请求了 || []).length >= 1,
    存进nodeMeta了: (saved.desc || '').trim() === '这是个 测试描述',
    有保存提示: /已保存/.test(saved.toast || ''),
  };
  console.log(JSON.stringify(results, null, 2));
  if (Object.values(results.断言).some((v) => v === false) || pageErrors.length) process.exitCode = 1;
} finally { try { ws && ws.close(); } catch { /* ignore */ } try { edge.kill('SIGTERM'); } catch { /* ignore */ } try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
