/* 侧边栏投放与 hover 反馈校验：
 *   D1 拖拽一开始，整栏进入投放态（.sidebar.dragging + 两张卡都亮成投放区 + 提示条）
 *   D2 悬停侧栏某一行 → 该行高亮 .drop-inside（且只有这一行）
 *   D3 在该行松手 → 书签真的被移进那个文件夹，拖拽状态被清干净
 *   D4 把文件夹拖到它自己的侧栏行 → 该行 .drop-invalid，且松手后条目没动
 *   D5 hover 行 → 快捷动作浮出（opacity 1，计数淡出）
 *   D6 把书签拖到**工作区行**上 → 该行高亮 + 表头提示「松手加进 N 项」+ 松手后登记进这一组，
 *      且书签**没有被移动**（工作区是清单，不是文件夹）
 *   D7 把**文件夹**拖到工作区行上 → 递归收集里面的书签加进去
 *   E1 侧栏收起时贴边唤出  E2 拖拽期间整棵树临时展开、拖完还原
 */
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP_HTTP = 'http://127.0.0.1:9231';
const PAGE_URL = 'http://localhost:5199/';
const SHOT_DIR = fileURLToPath(new URL('./screens/', import.meta.url));

const EDGE_CANDIDATES = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);
const EDGE_BIN = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE_BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定：\n' + EDGE_CANDIDATES.join('\n'));

const results = {};
const pageErrors = [];
const profile = mkdtempSync(join(tmpdir(), 'cardtree-sdrop-'));

const edge = spawn(EDGE_BIN, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=9231`, `--user-data-dir=${profile}`,
  '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' });

async function waitHttp(url, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { return await (await fetch(url)).json(); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('CDP 未就绪: ' + url);
}

let ws;
try {
  const list = await waitHttp(CDP_HTTP + '/json');
  const target = list.find((t) => t.type === 'page' && t.url === 'about:blank') || list.find((t) => t.type === 'page');
  if (!target) throw new Error('no page target');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push('exception: ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'unknown'));
    }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  async function ev(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function run(name, fn) {
    try { results[name] = await fn(); } catch (e) { results[name] = { ERROR: e.message }; }
  }
  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOT_DIR + name, Buffer.from(r.data, 'base64'));
  }

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: PAGE_URL });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const ready = await ev(`!!(window.__store && !window.__store.loading && document.querySelectorAll('.bookmark-item').length > 0)`).catch(() => false);
    if (ready) break;
  }
  await sleep(800);

  // 定位辅助
  const sfRow = (name) => `[...document.querySelectorAll('.sf-row')].find(r => r.querySelector('.sf-name')?.textContent === '${name}')`;
  const wsRow = (name) => `[...document.querySelectorAll('.ws-row')].find(r => r.querySelector('.ws-name')?.textContent === '${name}')`;
  // 整棵书签栏的标题清单（用来断言"拖进工作区没有移动任何书签"）
  const barTree = `(async () => {
    const roots = await window.__bm.getRoots();
    const walk = (n, out = []) => { out.push(n.title); (n.children || []).forEach((c) => walk(c, out)); return out };
    const bar = roots.find((r) => (r.title || '').includes('书签栏')) || roots[0];
    return walk(bar);
  })()`;
  const bmEl = (name) => `[...document.querySelectorAll('.bookmark-item')].find(e => e.querySelector('.bookmark-title')?.textContent === '${name}')`;
  const folderHead = (name) => `[...document.querySelectorAll('.cascade-node')].find(n => n.querySelector('.cascade-title')?.textContent.includes('${name}'))?.querySelector('.cascade-heading')`;

  // 在页面里发起拖拽：dragstart → (可选 dragover 目标) → 返回可复用的 dt
  const dragStart = (srcExpr) => `(() => {
    const src = ${srcExpr};
    if (!src) return { err: 'src not found' };
    const dt = new DataTransfer();
    window.__dt = dt;
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return { ok: true, count: window.__store.dragging?.count ?? null };
  })()`;
  const dragOver = (dstExpr, dy = 0.5) => `(() => {
    const dst = ${dstExpr};
    if (!dst) return { err: 'dst not found' };
    const r = dst.getBoundingClientRect();
    dst.dispatchEvent(new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer: window.__dt,
      clientX: r.left + r.width / 2, clientY: r.top + r.height * ${dy},
    }));
    return { ok: true };
  })()`;
  const dropOn = (dstExpr) => `(() => {
    const dst = ${dstExpr};
    const r = dst.getBoundingClientRect();
    dst.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: window.__dt,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    dst.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt }));
    return { ok: true };
  })()`;

  const treeOf = (name) => `(() => {
    const walk = (n, out = []) => { if (n.url) out.push(n.title); (n.children || []).forEach((c) => walk(c, out)); return out };
    let hit = null;
    const rec = (n) => { if ((n.title || '') === ${JSON.stringify(name)}) hit = n; (n.children || []).forEach(rec) };
    window.__store.roots.forEach(rec);
    return hit ? walk(hit) : null;
  })()`;

  await run('D1_dragstart_enters_drop_mode', async () => {
    const started = await ev(dragStart(bmEl('YouTube')));
    await sleep(150);
    const state = await ev(`({
      sidebarDragging: !!document.querySelector('.sidebar.dragging'),
      hintText: document.querySelector('.panel-hint')?.textContent.replace(/\\s+/g, ' ').trim() || null,
      folderPanelTitle: document.querySelector('.panel--folders .panel-title')?.textContent.trim() || null,
      // 两张卡现在都是投放区：文件夹卡 = 移动进去，工作区卡 = 加进某一组
      folderPanelBorder: getComputedStyle(document.querySelector('.panel--folders')).borderColor,
      wsPanelBorder: getComputedStyle(document.querySelector('.panel--workspaces')).borderColor,
      wsPanelOpacity: getComputedStyle(document.querySelector('.panel--workspaces')).opacity,
      wsPanelPointerEvents: getComputedStyle(document.querySelector('.panel--workspaces')).pointerEvents,
    })`);
    await shot('sdrop-01-dragging.png');
    return {
      ...started,
      ...state,
      两张卡都亮着: state.folderPanelBorder === state.wsPanelBorder && state.wsPanelOpacity === '1' && state.wsPanelPointerEvents !== 'none',
    };
  });

  await run('D2_hover_row_highlights', async () => {
    await ev(dragOver(sfRow('设计灵感')));
    await sleep(120);
    const state = await ev(`(() => {
      const row = ${sfRow('设计灵感')};
      const cs = getComputedStyle(row);
      return {
        dropInside: row.classList.contains('drop-inside'),
        highlightedRows: document.querySelectorAll('.sf-row.drop-inside').length,
        boxShadow: cs.boxShadow,
        background: cs.backgroundColor,
        dropTargetFolder: window.__store.dropTarget?.folderId || null,
      };
    })()`);
    await shot('sdrop-02-hover-row.png');
    return state;
  });

  await run('D3_drop_into_sidebar_row_moves', async () => {
    const before = await ev(treeOf('设计灵感'));
    await ev(dropOn(sfRow('设计灵感')));
    await sleep(900);
    const after = await ev(treeOf('设计灵感'));
    const cleaned = await ev(`({
      dragging: window.__store.dragging,
      dropTarget: window.__store.dropTarget,
      sidebarDragging: !!document.querySelector('.sidebar.dragging'),
      hintGone: !document.querySelector('.panel-hint'),
      anyHighlight: document.querySelectorAll('.sf-row.drop-inside').length,
    })`);
    return { before, after, movedIn: after.includes('YouTube'), cleaned };
  });

  await run('D4_invalid_target_is_marked_and_rejected', async () => {
    await ev(dragStart(folderHead('常用工具')));
    await sleep(120);
    await ev(dragOver(sfRow('常用工具')));
    await sleep(120);
    const marked = await ev(`(() => {
      const row = ${sfRow('常用工具')};
      return {
        dropInvalid: row.classList.contains('drop-invalid'),
        dropInside: row.classList.contains('drop-inside'),
        opacity: getComputedStyle(row).opacity,
        dropTarget: window.__store.dropTarget,
      };
    })()`);
    await shot('sdrop-03-invalid.png');
    const before = await ev(treeOf('常用工具'));
    await ev(dropOn(sfRow('常用工具')));
    await sleep(700);
    const after = await ev(treeOf('常用工具'));
    return { marked, unchanged: JSON.stringify(before) === JSON.stringify(after) };
  });

  await run('D5_hover_shows_quick_actions', async () => {
    const row = await ev(`(() => {
      const r = ${sfRow('设计灵感')};
      const b = r.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    const idle = await ev(`(() => {
      const a = ${sfRow('设计灵感')}.querySelector('.sf-actions');
      return { actions: getComputedStyle(a).opacity, count: getComputedStyle(${sfRow('设计灵感')}.querySelector('.sf-count')).opacity };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y, buttons: 0 });
    await sleep(320);
    const hovered = await ev(`(() => {
      const r = ${sfRow('设计灵感')};
      return {
        actions: getComputedStyle(r.querySelector('.sf-actions')).opacity,
        count: getComputedStyle(r.querySelector('.sf-count')).opacity,
        actionButtons: r.querySelectorAll('.sf-act').length,
        titles: [...r.querySelectorAll('.sf-act')].map((b) => b.title),
      };
    })()`);
    await shot('sdrop-04-hover-actions.png');
    return { idle, hovered };
  });

  // 拖书签进工作区行：登记进这一组，且**不移动**书签本体
  await run('D6_drop_bookmark_into_workspace_row', async () => {
    await ev(`(async () => {
      const s = window.__store;
      s.workspaces = [{ id: 'wsDrop', name: '拖拽测试组', icon: 'briefcase', items: [] }];
      s.wsExpanded = new Set();
      await new Promise((r) => setTimeout(r, 450));
      return true;
    })()`);
    const treeBefore = await ev(barTree);
    const afterYt = await ev(treeOf('设计灵感'));   // D3 把 YouTube 移进了「设计灵感」
    const started = await ev(dragStart(bmEl('Notion')));
    await sleep(140);
    await ev(dragOver(wsRow('拖拽测试组')));
    await sleep(420);   // 等计数淡出（0.2s 过渡）走完再量
    const hovering = await ev(`(() => {
      const row = ${wsRow('拖拽测试组')};
      return {
        dropInside: row.classList.contains('drop-inside'),
        highlightedRows: document.querySelectorAll('.ws-row.drop-inside').length,
        countHidden: getComputedStyle(row.querySelector('.ws-count')).opacity,
        // 注意：reactive proxy 整体取值经 CDP 会被序列化成 {}，只能逐字段取原始值
        dropTargetType: window.__store.dropTarget?.type || null,
        dropTargetWsId: window.__store.dropTarget?.wsId || null,
        headerHint: document.querySelector('.panel--workspaces .panel-hint')?.textContent.replace(/\\s+/g, ' ').trim() || null,
        newBtnHidden: !document.querySelector('.panel--workspaces .panel-act'),
      };
    })()`);
    await shot('sdrop-06-ws-row-hover.png');
    await ev(dropOn(wsRow('拖拽测试组')));
    await sleep(900);
    const after = await ev(`({
      items: window.__store.workspaces[0].items.map((i) => i.title),
      itemIds: window.__store.workspaces[0].items.map((i) => !!i.id),
      expanded: window.__store.wsExpanded.size,
      tabs: [...document.querySelectorAll('.ws-tab-name')].map((e) => e.textContent.trim()),
      toast: document.querySelector('.toast .toast-msg')?.textContent.trim() || null,
      dragging: window.__store.dragging,
      dropTarget: window.__store.dropTarget,
      hintGone: !document.querySelector('.panel--workspaces .panel-hint'),
      newBtnBack: !!document.querySelector('.panel--workspaces .panel-act'),
    })`);
    const treeAfter = await ev(barTree);
    await shot('sdrop-07-ws-added.png');
    return {
      started,
      hovering,
      after,
      treeChanged: JSON.stringify(treeBefore) !== JSON.stringify(treeAfter),
      高亮了: hovering.dropInside && hovering.highlightedRows === 1
        && hovering.dropTargetType === 'workspace' && hovering.dropTargetWsId === 'wsDrop'
        && hovering.countHidden === '0',
      表头给了提示: hovering.headerHint === '松手加进 1 项' && hovering.newBtnHidden,
      登记进组了: after.items.includes('Notion') && after.expanded === 1 && after.tabs.includes('Notion'),
      给了反馈: /已加进「拖拽测试组」/.test(after.toast || ''),
      书签没被移动: JSON.stringify(treeBefore) === JSON.stringify(treeAfter),
      拖拽态清干净: !after.dragging && !after.dropTarget && after.hintGone && after.newBtnBack,
    };
  });

  // 拖文件夹进工作区行：递归把里面的书签都加进来（和选中文件夹点「＋」一致）
  await run('D7_drop_folder_into_workspace_row', async () => {
    const expected = await ev(`(() => {
      const f = [...window.__store.nodesMap.values()].find((n) => !n.url && n.title === '常用工具');
      const out = [];
      const walk = (n) => { for (const c of n.children || []) { if (c.url) out.push(c.title); else walk(c) } };
      walk(f);
      return out;
    })()`);
    const treeBefore = await ev(barTree);
    await ev(`(async () => {
      window.__store.workspaces[0].items = [];
      await new Promise((r) => setTimeout(r, 350));
      return true;
    })()`);
    await ev(dragStart(folderHead('常用工具')));
    await sleep(140);
    await ev(dragOver(wsRow('拖拽测试组')));
    await sleep(160);
    await ev(dropOn(wsRow('拖拽测试组')));
    await sleep(900);
    const after = await ev(`({
      titles: window.__store.workspaces[0].items.map((i) => i.title),
      toast: document.querySelector('.toast .toast-msg')?.textContent.trim() || null,
    })`);
    const treeAfter = await ev(barTree);
    return {
      文件夹内书签: expected,
      after,
      递归都加进来了: expected.length > 0 && expected.every((t) => after.titles.includes(t)),
      反馈带条数: new RegExp('已加进「拖拽测试组」：' + expected.length + ' 项').test(after.toast || ''),
      书签没被移动: JSON.stringify(treeBefore) === JSON.stringify(treeAfter),
    };
  });

  // 侧栏收起时贴边唤出：否则"收起侧栏"状态下根本没有投放区，这条路是断的
  await run('E1_peek_reveals_collapsed_sidebar', async () => {
    await ev(`(async () => { window.__store.sidebarOpen = false; await new Promise(r => setTimeout(r, 500)); return true })()`);
    const collapsedWidth = await ev(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)`);
    await ev(dragStart(bmEl('Notion')));
    await ev(`(() => {
      document.body.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: 6, clientY: 400,
      }));
      return true;
    })()`);
    await sleep(120);
    const immediatelyOpen = await ev(`window.__store.sidebarOpen`);   // 停留不够，还不该唤出
    await sleep(320);
    const afterDwell = await ev(`window.__store.sidebarOpen`);
    await sleep(500);
    const peekWidth = await ev(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)`);
    return { collapsedWidth, immediatelyOpen, afterDwell, peekWidth, revealed: afterDwell === true && peekWidth > 100 };
  });

  // 拖拽期间整棵树临时展开（落点不漂移），拖完还原
  await run('E2_drag_expand_all_then_restore', async () => {
    const during = await ev(`({
      dragExpandAll: window.__store.dragExpandAll,
      bodies: document.querySelectorAll('.sf-body').length,
      openBodies: [...document.querySelectorAll('.sf-body')].filter((b) => b.classList.contains('open')).length,
    })`);
    await shot('sdrop-05-peek-expanded.png');
    await ev(`window.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt }))`);
    await sleep(500);
    const after = await ev(`({
      dragExpandAll: window.__store.dragExpandAll,
      sidebarOpen: window.__store.sidebarOpen,
      openBodies: [...document.querySelectorAll('.sf-body')].filter((b) => b.classList.contains('open')).length,
    })`);
    return {
      during,
      duringAllOpen: during.bodies > 0 && during.openBodies === during.bodies,
      after,
      restored: after.dragExpandAll === false && after.sidebarOpen === false && after.openBodies < during.bodies,
    };
  });

  results.pageErrors = pageErrors;
  console.log(JSON.stringify(results, null, 2));
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  try { edge.kill('SIGTERM'); } catch { /* ignore */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
