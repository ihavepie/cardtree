/* 在**真正的扩展环境**里验证侧栏两个把手（之前所有验证都跑在 mock 模式）。
 * store.js 里 window.__store 只在 !isExtension 时暴露 —— 也就是说扩展路径一直没被测过。
 * 这里用 --load-extension 加载 dist、直接开 chrome-extension://<id>/index.html，
 * 断言只用 DOM + chrome.storage（扩展页自己有权限，工作区本来就存在 chrome.storage.local）。
 *
 *   E1 环境自检：真扩展、__store 不暴露、两块面板顺序固定、换位那套入口一个都没有、两个把手都在
 *   E2 宽度把手：真实鼠标横拖 → 侧栏变宽、首帧镜像 cardtree:sync:sidebarWidth 落上、拖拽中给反馈
 *   E3 高度分隔条：**用 chrome.storage 塞进工作区内容**后重载，真实鼠标竖拖 → panelSplit 落库、
 *      上面那张卡跟着变高变矮、下面那张卡始终留着空间；内容短时手柄也必须跟手（不能"拖了不动"）
 *   E4 下限/上限夹住（宽度 150、比例 0.15/0.8）
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP_HTTP = 'http://127.0.0.1:9234';
const DIST = fileURLToPath(new URL('../dist', import.meta.url));

const EDGE_CANDIDATES = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);
const EDGE_BIN = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE_BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');

const results = {};
const pageErrors = [];
const profile = mkdtempSync(join(tmpdir(), 'cardtree-ext-'));

const edge = spawn(EDGE_BIN, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--no-first-run', '--no-default-browser-check',
  `--disable-extensions-except=${DIST}`,
  `--load-extension=${DIST}`,
  `--remote-debugging-port=9234`, `--user-data-dir=${profile}`,
  '--window-size=1400,1000',
  'about:blank',
], { stdio: 'ignore' });

async function waitHttp(url, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { return await (await fetch(url)).json(); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('CDP 未就绪');
}

let ws;
try {
  await waitHttp(CDP_HTTP + '/json');

  // 直接打开扩展页，而不是依赖 edge://newtab 的 override ——
  // headless Edge 里那个 override 不稳定（时好时坏），会让测试假失败。
  // 扩展 ID 由"未打包扩展的绝对路径"推导（sha256 前 32 位十六进制，逐位映射到 a-p）。
  const extId = createHash('sha256').update(DIST).digest('hex').slice(0, 32)
    .split('').map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  const pageUrl = `chrome-extension://${extId}/index.html`;
  let list = [];
  let target = null;
  for (let attempt = 0; attempt < 15 && !target; attempt++) {
    await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    list = await waitHttp(CDP_HTTP + '/json');
    target = list.find((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${extId}`));
  }
  if (!target) {
    throw new Error('扩展页没打开：' + JSON.stringify(list.map((t) => t.url)) + '\n（扩展 ID 推算是 ' + extId + '）');
  }

  ws = new WebSocket(target.webSocketDebuggerUrl);
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
  const run = async (name, fn) => {
    try { results[name] = await fn(); } catch (e) { results[name] = { ERROR: e.message }; }
  };

  const handleBox = (sel) => ev(`(() => {
    const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  async function dragMouse(from, dx, dy, steps = 8) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= steps; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + dx * i / steps),
        y: Math.round(from.y + dy * i / steps),
        button: 'left', buttons: 1,
      });
      await sleep(30);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x + dx, y: from.y + dy, button: 'left', buttons: 0 });
    await sleep(350);
  }
  const geom = () => ev(`(() => {
    const sb = document.querySelector('.sidebar');
    const p = document.querySelector('.panel--workspaces');
    const f = document.querySelector('.panel--folders');
    return {
      sidebarW: Math.round(sb.getBoundingClientRect().width),
      sidebarH: Math.round(sb.clientHeight),
      wsH: Math.round(p.getBoundingClientRect().height),
      foldersH: Math.round(f.getBoundingClientRect().height),
      flexBasis: getComputedStyle(p).flexBasis,
      maxHeight: getComputedStyle(p).maxHeight,
      wsRows: document.querySelectorAll('.ws-row').length,
      foldRows: document.querySelectorAll('.sf-row').length,
    };
  })()`);
  const storeGet = (keys) => ev(`chrome.storage.local.get(${JSON.stringify(keys)})`);
  // 重载页面并等到指定条件成立（用 chrome.storage 塞数据后必须重载才生效）
  async function reloadUntil(cond, tries = 60) {
    await send('Page.reload', { ignoreCache: true });
    for (let i = 0; i < tries; i++) {
      await sleep(250);
      const ok = await ev(cond).catch(() => false);
      if (ok) return true;
    }
    return false;
  }
  const seedWorkspaces = (n, split) => ev(`(async () => {
    await chrome.storage.local.set({
      panelSplit: ${split},
      wsExpanded: [],
      workspaces: Array.from({ length: ${n} }, (_, i) => ({
        id: 'extWs' + i, name: '工作区 ' + (i + 1), icon: 'briefcase',
        items: [{ title: '快照条目 ' + (i + 1), url: 'https://snapshot.example/' + i }],
      })),
    });
    return true;
  })()`);

  await send('Page.enable');
  await send('Runtime.enable');

  // 等首屏渲染（扩展里没有 window.__store，只能看 DOM）
  let ready = false;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    ready = await ev(`!!document.querySelector('.sidebar .panel--folders .sidebar-list') && !!document.querySelector('.sidebar-resizer')`).catch(() => false);
    if (ready) break;
  }

  await run('E1_env_and_handles', async () => {
    const state = await ev(`({
      url: location.href,
      是扩展: typeof chrome !== 'undefined' && !!chrome.bookmarks && !!chrome.runtime,
      store暴露了: !!window.__store,
      面板顺序: [...document.querySelectorAll('.sidebar .panel')].map((p) => [...p.classList].find((c) => c.startsWith('panel--') && c !== 'panel--fit' && c !== 'panel--fill').replace('panel--', '')),
      宽度把手: !!document.querySelector('.sidebar-resizer'),
      高度分隔条: !!document.querySelector('.sidebar-splitter'),
      拖拽条: document.querySelectorAll('.panel-dragbar').length,
      幽灵块: !!document.querySelector('.panel-ghost'),
      可拖元素: document.querySelectorAll('.sidebar [draggable="true"]').length,
      侧栏可见: getComputedStyle(document.querySelector('.sidebar')).display !== 'none',
    })`);
    return { ready, ...state, 无换位入口: state.拖拽条 === 0 && !state.幽灵块 && state.可拖元素 === 0 };
  });

  await run('E2_width_handle', async () => {
    await ev(`(async () => { await chrome.storage.local.set({ sidebarWidth: 230 }); return true })()`);
    await reloadUntil(`!!document.querySelector('.sidebar-resizer') && Math.round(document.querySelector('.sidebar').getBoundingClientRect().width) === 230`);
    const before = await geom();
    const start = await handleBox('.sidebar-resizer');
    const idlePill = await ev(`getComputedStyle(document.querySelector('.sidebar-resizer'), '::after').backgroundColor`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, buttons: 0 });
    await sleep(300);
    const hoverPill = await ev(`getComputedStyle(document.querySelector('.sidebar-resizer'), '::after').backgroundColor`);

    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + 40, y: start.y, button: 'left', buttons: 1 });
    await sleep(90);
    const mid = await ev(`({
      bodyClass: document.body.classList.contains('is-resizing-sidebar'),
      cursor: getComputedStyle(document.body).cursor,
      width: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
    })`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + 80, y: start.y, button: 'left', buttons: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x + 80, y: start.y, button: 'left', buttons: 0 });
    await sleep(400);
    const after = await geom();
    const mirror = await ev(`localStorage.getItem('cardtree:sync:sidebarWidth')`);
    const released = await ev(`document.body.classList.contains('is-resizing-sidebar')`);
    // 越界：往左拖 900 必须夹在 150
    await dragMouse(await handleBox('.sidebar-resizer'), -900, 0, 6);
    const minW = (await geom()).sidebarW;
    await ev(`(async () => { await chrome.storage.local.set({ sidebarWidth: 230 }); return true })()`);
    await reloadUntil(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().width) === 230`);
    return {
      before: { sidebarW: before.sidebarW },
      mid,
      after: { sidebarW: after.sidebarW },
      mirror,
      minW,
      released,
      idlePill,
      hoverPill,
      拖宽了: after.sidebarW > before.sidebarW + 40,
      首帧镜像落上: Number(mirror) === after.sidebarW,
      拖拽中给反馈: mid.bodyClass === true && mid.cursor === 'col-resize' && mid.width > before.sidebarW,
      松手清状态: released === false,
      悬停才浮出: idlePill === 'rgba(0, 0, 0, 0)' && hoverPill !== idlePill,
      下限夹住: minW === 150,
    };
  });

  await run('E3_height_handle_with_content', async () => {
    // 塞 10 组工作区：内容足够长，比例上限这件事在像素上看得见
    await seedWorkspaces(10, 0.35);
    const loaded = await reloadUntil(`document.querySelectorAll('.ws-row').length === 10`);
    const before = await geom();
    const start = await handleBox('.sidebar-splitter');

    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y + 60, button: 'left', buttons: 1 });
    await sleep(90);
    const mid = await ev(`({
      bodyClass: document.body.classList.contains('is-resizing-panel'),
      cursor: getComputedStyle(document.body).cursor,
      wsH: Math.round(document.querySelector('.panel--workspaces').getBoundingClientRect().height),
    })`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y + 120, button: 'left', buttons: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x, y: start.y + 120, button: 'left', buttons: 0 });
    await sleep(400);
    const after = await geom();
    const { panelSplit } = await storeGet(['panelSplit']);
    const released = await ev(`document.body.classList.contains('is-resizing-panel')`);
    // 越界：一直往下拖 → 夹在 0.8；再一直往上拖 → 夹在 0.15
    await dragMouse(await handleBox('.sidebar-splitter'), 0, 900, 6);
    const maxSplit = (await storeGet(['panelSplit'])).panelSplit;
    await dragMouse(await handleBox('.sidebar-splitter'), 0, -1600, 6);
    const minSplit = (await storeGet(['panelSplit'])).panelSplit;
    const atMin = await geom();

    return {
      loaded,
      before: { wsH: before.wsH, foldersH: before.foldersH, sidebarH: before.sidebarH, flexBasis: before.flexBasis, maxHeight: before.maxHeight },
      mid,
      after: { wsH: after.wsH, foldersH: after.foldersH },
      panelSplit,
      released,
      maxSplit,
      minSplit,
      atMin,
      分隔条可拖: panelSplit > 0.35 && after.wsH > before.wsH + 20,
      固定比例高度: Math.abs(before.wsH - 0.35 * before.sidebarH) <= 4 && before.maxHeight === 'none',
      文件夹仍有空间: after.foldersH >= 104,
      落库: Math.abs(panelSplit - 0.35) > 0.01 && panelSplit <= 0.8,
      拖拽中给反馈: mid.bodyClass === true && mid.cursor === 'row-resize' && mid.wsH > before.wsH,
      松手清状态: released === false,
      上限夹住: maxSplit === 0.8,
      下限夹住: minSplit === 0.15,
      夹到下限后仍是正高度: atMin.wsH > 60 && atMin.foldersH >= 104,
    };
  });

  // 内容很短（一组、没展开）时，手柄也必须跟手 —— 这正是 max-height 方案翻车的地方：
  // 数据变了但像素不动，用户只会觉得"手柄坏了"。
  await run('E4_handle_moves_even_with_short_content', async () => {
    await seedWorkspaces(1, 0.5);
    const loaded = await reloadUntil(`document.querySelectorAll('.ws-row').length === 1`);
    const before = await geom();
    const start = await handleBox('.sidebar-splitter');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y + Math.round(90 * i / 6), button: 'left', buttons: 1 });
      await sleep(35);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x, y: start.y + 90, button: 'left', buttons: 0 });
    await sleep(400);
    const after = await geom();
    const { panelSplit } = await storeGet(['panelSplit']);
    // 收尾：清掉测试塞进去的数据，别把脏数据留在 profile 里（虽然 profile 会被删）
    await ev(`(async () => { await chrome.storage.local.remove(['workspaces', 'wsExpanded', 'panelSplit']); return true })()`);
    return {
      loaded,
      before: { wsH: before.wsH, foldersH: before.foldersH, sidebarH: before.sidebarH },
      after: { wsH: after.wsH, foldersH: after.foldersH },
      panelSplit,
      手柄跟手: after.wsH > before.wsH + 20 && after.foldersH < before.foldersH - 20,
      比例落库: panelSplit > 0.5,
      文件夹仍有空间: after.foldersH >= 104,
    };
  });

  results.pageErrors = pageErrors;
  console.log(JSON.stringify(results, null, 2));
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  try { edge.kill('SIGTERM'); } catch { /* ignore */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
