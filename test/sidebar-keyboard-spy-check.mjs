/* 侧栏三项补强校验：
 *   K1 键盘可达：整棵树恰好一行 tabindex=0（roving），行有 role/aria
 *   K2 方向键：↓↑ 在可见行间移动；→ 展开/进子项；← 收起/回父级；折叠子树的行不可达
 *   K3 Enter 选中并定位；Shift+F10 开出该行的右键菜单（键盘也能用到全部行操作）
 *   F1 常用区：按打开次数排序、最多 8 个、点一下打开并让次数 +1
 *   S1 滚动联动：主区滚动后，侧栏高亮当前正在看的文件夹；搜索/收起侧栏时清空
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP_HTTP = 'http://127.0.0.1:9267';
const PAGE_URL = 'http://localhost:5199/';
const EDGE_CANDIDATES = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);
const EDGE_BIN = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE_BIN) throw new Error('找不到 Microsoft Edge');

const results = {};
const pageErrors = [];
const profile = mkdtempSync(join(tmpdir(), 'cardtree-sidebar3-'));
const edge = spawn(EDGE_BIN, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9267', `--user-data-dir=${profile}`,
  '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' });

async function waitHttp(url, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { return await (await fetch(url)).json(); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('CDP 未就绪');
}

const T0 = Date.now();
let tStartup = 0;
let ws;
try {
  const list = await waitHttp(CDP_HTTP + '/json');
  ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const timings = [];
  async function run(name, fn) {
    const t0 = Date.now();
    try { results[name] = await fn(); } catch (e) { results[name] = { ERROR: e.message }; }
    timings.push([name, Date.now() - t0]);
  }
  // 真实键盘事件
  const key = async (k, mods = 0) => {
    const code = { ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Home: 36, End: 35, F10: 121 }[k] || 0;
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: mods });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: mods });
    await sleep(90);
  };
  const focusedName = () => ev(`document.activeElement?.querySelector?.('.sf-name')?.textContent.trim() || document.activeElement?.className || null`);
  const treeState = () => ev(`(() => {
    const list = document.querySelector('.sidebar-list');
    const rows = [...list.querySelectorAll('.sf-row')];
    const visible = rows.filter((row) => {
      let p = row.parentElement;
      while (p && p !== list) { if (p.classList.contains('sf-body') && !p.classList.contains('open')) return false; p = p.parentElement; }
      return true;
    });
    return {
      总行数: rows.length,
      可见行数: visible.length,
      可见行: visible.map((r) => r.querySelector('.sf-name').textContent.trim()),
      tabindex0的行: rows.filter((r) => r.getAttribute('tabindex') === '0').map((r) => r.querySelector('.sf-name').textContent.trim()),
      有role的行数: rows.filter((r) => r.getAttribute('role') === 'treeitem').length,
      treeRole: list.getAttribute('role'),
      ariaLevel: rows.slice(0, 3).map((r) => r.getAttribute('aria-level')),
      ariaExpanded: rows.filter((r) => r.getAttribute('aria-expanded') !== null).length,
    };
  })()`);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: PAGE_URL });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (await ev(`!!(window.__store && !window.__store.loading && document.querySelectorAll('.bookmark-item').length > 0)`).catch(() => false)) break;
  }
  await sleep(900);
  tStartup = Date.now() - T0;

  await run('K1_roving_tabindex_and_aria', async () => {
    await ev(`(async () => { window.__store.collapsed = new Set(['f-dev']); await new Promise((r) => setTimeout(r, 400)); return true; })()`);
    const st = await treeState();
    return {
      ...st,
      恰好一行可Tab: st.tabindex0的行.length === 1,
      每行都有role: st.有role的行数 === st.总行数,
    };
  });

  await run('K2_arrow_navigation', async () => {
    // 让第一行拿到焦点
    await ev(`document.querySelector('.sidebar-list .sf-row').focus()`);
    await sleep(150);
    const start = await focusedName();
    await key('ArrowDown');
    const down1 = await focusedName();
    await key('ArrowDown');
    const down2 = await focusedName();
    await key('ArrowUp');
    const up1 = await focusedName();
    // 折叠的 f-dev（前端开发）不应被走到
    const seen = await ev(`(async () => {
      const names = [];
      const list = document.querySelector('.sidebar-list');
      const cur = () => document.activeElement?.querySelector?.('.sf-name')?.textContent.trim();
      for (let i = 0; i < 12; i++) {
        names.push(cur());
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await new Promise((r) => setTimeout(r, 30));
        if (!document.activeElement?.classList?.contains('sf-row')) break;
      }
      return names;
    })()`);
    // → 展开 / 进子项
    await ev(`document.querySelector('.sidebar-list .sf-row').focus()`);
    await sleep(120);
    await key('ArrowRight');   // 第一行（书签栏）应该是展开的 → 进第一个子项
    const afterRight = await focusedName();
    await key('ArrowLeft');    // 回父级
    const afterLeft = await focusedName();
    // 折叠的行的 → 应该是"展开"
    const collapsedRow = await ev(`(() => {
      const r = [...document.querySelectorAll('.sidebar-list .sf-row')].find((x) => x.querySelector('.sf-name').textContent.trim() === '前端开发');
      r.focus(); return true;
    })()`);
    await sleep(120);
    await key('ArrowRight');
    const expandedNow = await ev(`!window.__store.collapsed.has('f-dev')`);
    return {
      start, down1, down2, up1,
      walksDown: down1 && down1 !== start,
      // ↓↓ 之后按一次 ↑，应回到第一次 ↓ 之后的那个位置（不是回到起点）
      goesBackUp: down1 === up1,
      走过的行: seen,
      跳过了折叠子树: !seen.includes('组件库'),
      afterRight, afterLeft, collapsedRow,
      进子项: afterRight && afterRight !== '书签栏',
      // ← 在"已展开且自身有子项"的节点上，标准 ARIA 树行为是**收起**它（不是跳父级）
      左侧键收起: afterLeft === afterRight,
      展开折叠项: expandedNow,
    };
  });

  await run('K3_enter_and_context_menu_key', async () => {
    await ev(`(async () => {
      const r = [...document.querySelectorAll('.sidebar-list .sf-row')].find((x) => x.querySelector('.sf-name').textContent.trim() === '常用工具');
      r.focus();
      await new Promise((x) => setTimeout(x, 120));
      return true;
    })()`);
    await key('Enter');
    const afterEnter = await ev(`({ focusId: window.__store.focusId, selected: [...window.__store.selection] })`);
    // Shift+F10 开菜单
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F10', code: 'F10', windowsVirtualKeyCode: 121, nativeVirtualKeyCode: 121, modifiers: 8 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F10', code: 'F10', windowsVirtualKeyCode: 121, nativeVirtualKeyCode: 121, modifiers: 8 });

    await sleep(300);
    const menu = await ev(`[...document.querySelectorAll('.context-menu-item')].map((e) => e.textContent.trim())`);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    return { afterEnter, menu, 菜单开出来了: menu.length > 0 };
  });

  await run('F1_frequent_by_open_count', async () => {
    // 造打开次数：GitHub 5 次、Notion 3 次、YouTube 1 次
    await ev(`(async () => {
      const s = window.__store;
      const id = (t) => [...s.nodesMap.values()].find((n) => n.url && n.title === t).id;
      s.nodeStats = {};
      s.nodeStats[id('GitHub')] = { count: 5, lastOpenedAt: Date.now() };
      s.nodeStats[id('Notion')] = { count: 3, lastOpenedAt: Date.now() };
      s.nodeStats[id('YouTube')] = { count: 1, lastOpenedAt: Date.now() };
      await new Promise((r) => setTimeout(r, 400));
      return true;
    })()`);
    const inCard = await ev(`(() => {
      const sec = document.querySelector('.freq-section');
      if (!sec) return null;
      return { 在书签栏卡内: !!sec.closest('.root-card'), 紧跟最近浏览: sec.previousElementSibling?.classList.contains('recent-section') || false };
    })()`);
    const list = await ev(`[...document.querySelectorAll('.freq-section .recent-item')].map((e) => ({ name: e.querySelector('.title').textContent.trim(), count: e.querySelector('.freq-count').textContent.trim() }))`);
    // 点第一个 → 打开并让次数 +1
    const before = await ev(`window.__store.nodeStats[[...window.__store.nodesMap.values()].find((n) => n.title === 'GitHub').id].count`);
    await ev(`document.querySelector('.freq-section .recent-item').click()`);
    await sleep(400);
    const after = await ev(`window.__store.nodeStats[[...window.__store.nodesMap.values()].find((n) => n.title === 'GitHub').id].count`);
    return {
      inCard,
      list,
      在书签栏卡内而不是侧栏: !!inCard && inCard.在书签栏卡内,
      按次数降序: list.length === 3 && list[0].name === 'GitHub' && list[1].name === 'Notion' && list[2].name === 'YouTube',
      before, after, 点一下次数加一: after === before + 1,
    };
  });

  await run('S1_scroll_spy', async () => {
    // 先造到"主区真的能滚"：直接加书签会被「前 8 个 + 展开全部」挡住，所以加带子项的文件夹
    await ev(`(async () => {
      const s = window.__store;
      const bar = s.roots.find((r) => (r.title || '').includes('书签栏')) || s.roots[0];
      for (let f = 0; f < 3; f++) {
        const folder = await window.__bm.create(bar.id, { title: '滚动测试文件夹 ' + f });
        for (let i = 0; i < 6; i++) {
          await window.__bm.create(folder.id, { title: '子书签 ' + f + '-' + i, url: 'https://e.com/' + f + '/' + i });
        }
      }
      await new Promise((r) => setTimeout(r, 1400));
      window.__store.collapsed = new Set();
      await new Promise((r) => setTimeout(r, 800));
      return true;
    })()`);
    await sleep(900);
    const canScroll = await ev(`(() => { const m = document.querySelector('.main'); return { scrollH: m.scrollHeight, clientH: m.clientHeight, 可滚: m.scrollHeight > m.clientHeight }; })()`);
    const at0 = await ev(`window.__store.spyId`);
    // 注意：用 main.scrollTop 直接滚，别用 target.scrollIntoView() ——
    // 后者在无头里可能滚到外层容器，.main 的 scrollTop 仍是 0，spy 自然不更新。
    const r = await ev(`(async () => {
      const main = document.querySelector('.main');
      main.scrollTop = main.scrollHeight;
      // 轮询等结果：无头环境下"瞬移"式的滚动可能要到下一帧才派发 scroll 事件，
      // 固定 sleep 会偶发读不到（平滑滚动时则一定会连续派发）
      for (let i = 0; i < 30 && !window.__store.spyId; i++) await new Promise((x) => setTimeout(x, 100));
      const spy = document.querySelector('.sf-row.spy');
      const nodes = [...main.querySelectorAll('.cascade-node[data-id]')];
      return {
        scrollTop: Math.round(main.scrollTop),
        最后一个文件夹: nodes[nodes.length - 1]?.querySelector('.cascade-title')?.textContent.trim() || null,
        高亮的侧栏行: spy?.querySelector('.sf-name')?.textContent.trim() || null,
        spyId: window.__store.spyId,
      };
    })()`);
    // 搜索时清空
    await ev(`(async () => { window.__store.query = 'vue'; await new Promise((x) => setTimeout(x, 400)); return true; })()`);
    const whileSearch = await ev(`window.__store.spyId`);
    await ev(`(async () => {
      window.__store.query = '';
      await new Promise((x) => setTimeout(x, 500));
      const main = document.querySelector('.main');
      main.scrollTop = main.scrollHeight;      // 清完筛选再滚一次，spy 应该回来
      for (let i = 0; i < 30 && !window.__store.spyId; i++) await new Promise((x) => setTimeout(x, 100));
      return true;
    })()`);
    const back = await ev(`window.__store.spyId`);
    return {
      canScroll, at0, ...r,
      滚到底后有高亮: r.spyId !== null && r.高亮的侧栏行 !== null,
      搜索时清空: whileSearch === null,
      搜索后恢复: back !== null,
    };
  });

  results.pageErrors = pageErrors;
  console.log(JSON.stringify(results, null, 2));
  console.error('⏱ 各步耗时(ms):', JSON.stringify(timings));
  console.error('⏱ 启动+就绪:', tStartup, 'ms');
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  try { edge.kill('SIGTERM'); } catch { /* ignore */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
