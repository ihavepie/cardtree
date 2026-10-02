/* 主卡片里的三个小标题（书签栏卡片顶部）：
 *   S1 「最近浏览」：种子数据 → 渲染条目；「常用」按打开次数排序，**只保留 10 个**（原来 8 个）
 *   S2 「文件夹」：现在**只是标题**（给它下面那块内容起名）—— 下面直接是网址网格 + 文件夹卡片；
 *      曾经在这里列过一排"点一下跳过去"的文件夹胶囊，已按要求删除，这里守住"不再出现胶囊"
 *   S3 深浅两套主题的观感
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9268';
const SHOT_DIR = fileURLToPath(new URL('./screens/', import.meta.url));
const C = [process.env.EDGE_BIN, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].filter(Boolean);
const BIN = C.find((p) => existsSync(p));
if (!BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');
const profile = mkdtempSync(join(tmpdir(), 'main-sections-'));
const edge = spawn(BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', `--remote-debugging-port=9268`, `--user-data-dir=${profile}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
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
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const run = async (name, fn) => { try { results[name] = await fn(); } catch (e) { results[name] = { ERROR: e.message }; } };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOT_DIR + name, Buffer.from(r.data, 'base64'));
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://localhost:5199/' });
  for (let i = 0; i < 60; i++) { await sleep(250); if (await ev(`!!(window.__store && !window.__store.loading && document.querySelectorAll('.bookmark-item').length > 0)`).catch(() => false)) break; }
  await sleep(800);

  // 种子：12 条"打开过多次"的书签 + 6 条最近浏览，用来验证「常用只留 10 个」
  await run('S1_sections_render', async () => {
    const seeded = await ev(`(async () => {
      const s = window.__store;
      const bms = [...s.nodesMap.values()].filter((n) => n.url);
      s.recent = bms.slice(0, 6).map((n, i) => ({ id: 'r' + i, title: n.title, url: n.url }));
      // 前 12 条各记一次打开次数（越多越靠前）
      s.nodeStats = {};
      bms.slice(0, 12).forEach((n, i) => { s.nodeStats[n.id] = { count: 100 - i, lastOpenedAt: 1000 + i } });
      await new Promise((r) => setTimeout(r, 600));
      return { bookmarks: bms.length };
    })()`);
    const dom = await ev(`(() => {
      const heads = [...document.querySelectorAll('.root-card > section')];
      const folderSec = document.querySelector('.folder-section');
      const next = folderSec?.nextElementSibling;
      const headRect = document.querySelector('.folder-section .section-head')?.getBoundingClientRect();
      const nextRect = next?.getBoundingClientRect();
      return {
        sections: heads.map((s) => s.className),
        labels: heads.map((s) => s.querySelector('.section-label')?.textContent.trim() || null),
        recentItems: document.querySelectorAll('.recent-section .recent-item').length,
        freqItems: document.querySelectorAll('.freq-section .recent-item').length,
        // 跳转胶囊必须已经没了
        chips: document.querySelectorAll('.folder-chip, .folder-section .recent-item').length,
        folderSub: document.querySelector('.folder-section .freq-sub')?.textContent.trim() || null,
        紧跟的元素: next ? next.className : null,
        标题到内容的间距: headRect && nextRect ? Math.round(nextRect.top - headRect.bottom) : null,
      };
    })()`);
    await shot('main-sections-light.png');
    return {
      seeded,
      ...dom,
      顺序是_最近_常用_文件夹: dom.labels[0] === '最近浏览' && dom.labels[1] === '常用' && dom.labels[2] === '文件夹',
      最近浏览渲染了: dom.recentItems === 6,
      常用只留10个: dom.freqItems === 10,
      跳转胶囊已删除: dom.chips === 0 && dom.folderSub === null,
      标题下面就是内容: /bookmark-grid|cascade-children/.test(dom.紧跟的元素 || ''),
      标题贴着自己的内容: dom.标题到内容的间距 !== null && dom.标题到内容的间距 <= 14,
    };
  });

  await run('S2_heading_belongs_to_content_below', async () => {
    // 标题必须紧贴它命名的那块内容：中间不能夹别的 section/标题
    const rel = await ev(`(() => {
      const sec = document.querySelector('.folder-section');
      if (!sec) return null;
      const next = sec.nextElementSibling;
      const between = [];
      let el = sec.nextElementSibling;
      while (el && between.length < 3) { between.push(el.className); el = el.nextElementSibling; }
      const grid = document.querySelector('.root-card .bookmark-grid');
      const cascade = document.querySelector('.root-card > .cascade-children');
      return {
        紧随: next?.className || null,
        紧随的若干个: between,
        有网址网格: !!grid,
        有文件夹卡片: !!cascade,
        网址数: document.querySelectorAll('.root-card .bookmark-grid .bookmark-item').length,
        文件夹卡片数: document.querySelectorAll('.root-card > .cascade-children > .cascade-node').length,
      };
    })()`);
    await shot('main-sections-heading.png');
    return {
      rel,
      下面就是网址和文件夹: (/bookmark-grid/.test(rel.紧随) || /cascade-children/.test(rel.紧随)),
      中间没有别的分组: !rel.紧随的若干个.slice(0, 2).some((c) => /section/.test(c)),
      内容还在: rel.网址数 > 0 && rel.文件夹卡片数 > 0,
    };
  });

  await run('S3_dark_theme_look', async () => {
    await ev(`(async () => { window.__store.theme = 'dark'; window.__store.sidebarOpen = false; await new Promise((r) => setTimeout(r, 600)); return true })()`);
    const state = await ev(`({
      labelColor: getComputedStyle(document.querySelector('.folder-section .section-label')).color,
      sectionMarginBottom: getComputedStyle(document.querySelector('.folder-section')).marginBottom,
      firstGridTop: Math.round(document.querySelector('.root-card .bookmark-grid').getBoundingClientRect().top),
    })`);
    await shot('main-sections-dark.png');
    return state;
  });

  results.pageErrors = pageErrors;
  console.log(JSON.stringify(results, null, 2));
} finally { try { ws && ws.close(); } catch { /* ignore */ } try { edge.kill('SIGTERM'); } catch { /* ignore */ } try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
