/* 吸顶索引条必须"遮得住"：它是 position: sticky，主卡片会从下面滚过去。
 * 背景一旦不够实（比如改成 --card-bg 的 26% 白），滚动的卡片就会透出来，
 * 看起来像"卡片和标签重叠"—— 这是真实发生过的 bug（v5.4.0 那次视觉统一引入的），这条守住它。
 * 用法：node test/board-index-sticky-check.mjs
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9278';
const SHOT_DIR = fileURLToPath(new URL('./screens/', import.meta.url));
const C = [process.env.EDGE_BIN, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].filter(Boolean);
const BIN = C.find((p) => existsSync(p));
if (!BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');
const profile = mkdtempSync(join(tmpdir(), 'stick-'));
const edge = spawn(BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', `--remote-debugging-port=9278`, `--user-data-dir=${profile}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alphaOf = `(() => {
  const cs = getComputedStyle(document.querySelector('.board-index'));
  const m = cs.backgroundColor.match(/rgba?\\(([^)]+)\\)/);
  const p = m ? m[1].split(',').map(Number) : [255, 255, 255, 1];
  return { color: cs.backgroundColor, alpha: p.length > 3 ? p[3] : 1, blur: cs.backdropFilter || cs.webkitBackdropFilter, top: cs.top, pos: cs.position };
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
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://localhost:5199/' });
  for (let i = 0; i < 60; i++) { await sleep(250); if (await ev(`!!(window.__store && !window.__store.loading && document.querySelectorAll('.bookmark-item').length > 0)`).catch(() => false)) break; }
  await sleep(700);

  // 打标签让索引条出现；侧栏收起（索引条的常驻场景）
  await ev(`(async () => {
    const s = window.__store;
    const bms = [...s.nodesMap.values()].filter((n) => n.url).slice(0, 3);
    bms.forEach((n, i) => { s.nodeMeta[n.id] = { desc: '', tags: [i ? '文档' : '开发'] }; });
    s.sidebarOpen = false;
    await new Promise((r) => setTimeout(r, 600));
    return true;
  })()`);

  const bar = await ev(alphaOf);
  // 给主区垫一段空白，保证真的能滚（内容本来就比视口矮时 scrollTop 会一直是 0，测不到重叠）
  await ev(`(() => { const inner = document.querySelector('.main-inner'); if (inner) inner.style.paddingBottom = '900px'; return true })()`);
  await sleep(300);
  // 往下滚 320px：主卡片会滑到吸顶条下面
  await ev(`(async () => {
    const m = document.querySelector('.main');
    m.style.scrollBehavior = 'auto';
    m.scrollTop = 320;
    await new Promise((r) => setTimeout(r, 300));
    return m.scrollTop;
  })()`);
  const scrolled = await ev(`(() => {
    const bar = document.querySelector('.board-index').getBoundingClientRect();
    const card = document.querySelector('.root-card').getBoundingClientRect();
    const cx = Math.round(bar.left + bar.width / 2), cy = Math.round(bar.top + bar.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    return {
      scrollTop: document.querySelector('.main').scrollTop,
      barTop: Math.round(bar.top), barBottom: Math.round(bar.bottom),
      cardTop: Math.round(card.top), cardBottom: Math.round(card.bottom),
      卡片确实在条下面: card.top < bar.bottom && card.bottom > bar.top,
      条挡住了卡片: !!hit && !!hit.closest('.board-index'),
    };
  })()`);

  const clip = await ev(`(() => {
    const b = document.querySelector('.board-index').getBoundingClientRect();
    return { x: Math.round(b.left) - 4, y: Math.round(b.top) - 4, width: Math.round(b.width) + 8, height: Math.round(b.height) + 40 };
  })()`);
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 2 } });
  writeFileSync(SHOT_DIR + 'board-index-sticky.png', Buffer.from(shot.data, 'base64'));

  const nearOpaque = bar.alpha >= 0.6;
  console.log(JSON.stringify({ bar, scrolled, 判定: { '近实底(alpha≥0.6)': nearOpaque, '吸顶挡住了卡片': scrolled.条挡住了卡片, '粘住了(position=sticky)': bar.pos === 'sticky' } }, null, 1));
  console.log('截图: test/screens/board-index-sticky.png');
  if (!nearOpaque || !scrolled.条挡住了卡片) process.exitCode = 1;
} finally { try { ws && ws.close(); } catch { /* ignore */ } try { edge.kill('SIGTERM'); } catch { /* ignore */ } try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
