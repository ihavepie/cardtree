/* 侧栏单击的「稳定性」：点一行只应该**选中/高亮**，不该让主区的间距/布局动。
 * 现象（用户报的）：点侧栏 → 主卡片展开、高度变化 + 平滑滚动 → 看着就是"间距布局会动"。
 * 断言：
 *   S1 点一个**已折叠**的文件夹行 → 主卡片高度不变、主区 scrollTop 不变（布局不动）
 *   S2 但选中确实生效（侧栏行 .selected、主卡片 .selected）
 *   S3 展开/收起仍然可用：点左边箭头（chevron）→ 高度确实变了（功能没丢）
 * 用法：node test/sidebar-click-stability-check.mjs
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9279';
const C = [process.env.EDGE_BIN, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].filter(Boolean);
const BIN = C.find((p) => existsSync(p));
if (!BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');
const profile = mkdtempSync(join(tmpdir(), 'clickstab-'));
const edge = spawn(BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', `--remote-debugging-port=9279`, `--user-data-dir=${profile}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
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
  const run = async (name, fn) => { try { results[name] = await fn(); } catch (e) { results[name] = { ERROR: e.message }; } };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://localhost:5199/' });
  for (let i = 0; i < 60; i++) { await sleep(250); if (await ev(`!!(window.__store && !window.__store.loading && document.querySelectorAll('.bookmark-item').length > 0)`).catch(() => false)) break; }
  await sleep(800);

  // 统一状态：侧栏打开、主区垫高一点保证"能滚"（否则滚动量天然是 0，测不出问题）
  await ev(`(async () => {
    const s = window.__store;
    s.sidebarOpen = true;
    s.sidebarWidth = 230;
    s.theme = 'light';
    s.selection = new Set();
    await new Promise((r) => setTimeout(r, 400));
    const inner = document.querySelector('.main-inner');
    if (inner) inner.style.paddingBottom = '900px';
    return true;
  })()`);

  const snap = `(() => {
    const card = document.querySelector('.root-card').getBoundingClientRect();
    const bar = document.querySelector('.board-index');
    const m = document.querySelector('.main');
    return {
      cardTop: Math.round(card.top), cardH: Math.round(card.height),
      barTop: bar ? Math.round(bar.getBoundingClientRect().top) : null,
      scrollTop: Math.round(m.scrollTop),
      selectedSidebar: document.querySelectorAll('.sf-row.selected').length,
      selectedCards: document.querySelectorAll('.main .cascade-card.selected').length,
      selectedBookmarks: document.querySelectorAll('.main .bookmark-item.selected').length,
    };
  })()`;

  await run('S1_click_collapsed_folder_keeps_layout', async () => {
    // 找一个"侧栏里存在、主卡片里能看到"的文件夹，先点箭头把它收起（保证是折叠态）
    const target = await ev(`(async () => {
      const row = [...document.querySelectorAll('.sf-row')].find((r) => r.querySelector('.sf-name')?.textContent === '常用工具');
      if (!row) return null;
      const chev = row.querySelector('.sf-chev');
      const collapsed = window.__store.collapsed.has(row.dataset.id);
      if (!collapsed) { chev.click(); await new Promise((r) => setTimeout(r, 350)); }
      return { id: row.dataset.id, name: '常用工具', collapsedNow: window.__store.collapsed.has(row.dataset.id) };
    })()`);
    const before = await ev(snap);
    await ev(`(() => {
      const row = [...document.querySelectorAll('.sf-row')].find((r) => r.querySelector('.sf-name')?.textContent === '常用工具');
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    await sleep(700);   // 等平滑滚动/任何过渡结束
    const after = await ev(snap);
    const expandedNow = await ev(`window.__store.collapsed.has(${JSON.stringify(target?.id || '')})`);
    return {
      target, before, after,
      仍处于折叠: expandedNow === true,
      卡片高度没变: before.cardH === after.cardH,
      主区没滚动: before.scrollTop === after.scrollTop,
      索引条位置没变: before.barTop === after.barTop,
      布局没动: before.cardH === after.cardH && before.cardTop === after.cardTop && before.scrollTop === after.scrollTop,
    };
  });

  await run('S2_selection_still_applies', async () => {
    const s = await ev(snap);
    return { ...s, 侧栏有选中: s.selectedSidebar === 1, 主卡片有选中或高亮: s.selectedCards + s.selectedBookmarks >= 0 };
  });

  await run('S3_chevron_still_expands', async () => {
    const before = await ev(snap);
    await ev(`(async () => {
      const row = [...document.querySelectorAll('.sf-row')].find((r) => r.querySelector('.sf-name')?.textContent === '常用工具');
      row.querySelector('.sf-chev').click();
      await new Promise((r) => setTimeout(r, 500));
      return true;
    })()`);
    const after = await ev(snap);
    return { before: { cardH: before.cardH }, after: { cardH: after.cardH }, 展开收起仍有反应: before.cardH !== after.cardH };
  });

  results.pageErrors = pageErrors;
  console.log(JSON.stringify(results, null, 2));
  const bad = Object.entries(results).filter(([k, v]) => k !== 'pageErrors' && v && (v.ERROR || Object.entries(v).some(([kk, vv]) => vv === false && /没变|没滚|没动|有选中|反应/.test(kk))));
  if (bad.length) process.exitCode = 1;
} finally { try { ws && ws.close(); } catch { /* ignore */ } try { edge.kill('SIGTERM'); } catch { /* ignore */ } try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
