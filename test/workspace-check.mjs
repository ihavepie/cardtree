/* 工作区 + 侧栏面板校验：
 *   W1 空态：工作区面板标题、引导文案、新建按钮
 *   W2 用选中的书签新建工作区（弹窗 + note 提示 + 落库 + 渲染）
 *   W3 hover 的「＋」把选中书签加进来；重复项去重提示；没选中时给指引
 *   W4 hover 的「全部打开」= 后台开整组（active:false）+ toast 带「撤销」，撤销真的关掉刚开的标签
 *   W5 落进存储（非扩展环境为 localStorage 的 cardtree:workspaces）
 *   W6 点行 = 展开列出组内每个标签页；点某一个 = 只开这一个；「✕」= 从组里移除
 *   W7 两块面板各自可折叠、互不影响，折叠态持久化
 *   W8 「⋯」菜单：立即打开全部 / 展开收起 / 重命名 / 删除（删除有说明，且不动书签）
 */
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP_HTTP = 'http://127.0.0.1:9232';
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
const profile = mkdtempSync(join(tmpdir(), 'cardtree-ws-'));

const edge = spawn(EDGE_BIN, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=9232`, `--user-data-dir=${profile}`,
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

  // 页面侧小工具
  const selectTitles = (titles) => `(() => {
    const s = window.__store;
    const ids = ${JSON.stringify(titles)}.map((t) => [...s.nodesMap.values()].find((n) => n.url && n.title === t)?.id).filter(Boolean);
    s.selection = new Set(ids);
    return ids.length;
  })()`;
  const typeInto = (selector, text) => `(() => {
    const i = document.querySelector(${JSON.stringify(selector)});
    if (!i) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, ${JSON.stringify(text)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;
  const clickModalBtn = (label) => `(() => {
    const b = [...document.querySelectorAll('.modal-foot .btn')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`;
  const toastInfo = `(() => {
    const t = document.querySelector('.toast');
    return t ? {
      text: t.querySelector('.toast-msg')?.textContent.trim() || t.textContent.trim(),
      action: t.querySelector('.toast-action')?.textContent.trim() || null,
    } : null;
  })()`;
  const wsItems = `window.__store.workspaces.map((w) => ({ name: w.name, icon: w.icon, items: w.items.map((i) => i.title), urls: w.items.map((i) => i.url) }))`;
  // 工作区动作按钮：1=全部打开 2=加选中项 3=更多
  const wsAct = (n) => `document.querySelector('.ws-row .ws-actions .ws-act:nth-child(${n})')`;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: PAGE_URL });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const ready = await ev(`!!(window.__store && !window.__store.loading && document.querySelectorAll('.bookmark-item').length > 0)`).catch(() => false);
    if (ready) break;
  }
  await sleep(800);
  await ev(`(async () => {
    window.__store.workspaces = [];
    window.__store.wsExpanded = new Set();
    localStorage.removeItem('cardtree:workspaces');
    await new Promise(r => setTimeout(r, 200));
    return true;
  })()`);

  await run('W1_panels_and_empty_state', async () => {
    const state = await ev(`({
      panelTitles: [...document.querySelectorAll('.panel .panel-title')].map((e) => e.textContent.trim()),
      collapseButtons: document.querySelectorAll('.panel-chev').length,
      clickableHeaders: document.querySelectorAll('.panel-head[role="button"]').length,
      splitterAlwaysActive: document.querySelector('.sidebar-splitter')?.classList.contains('active') ?? null,
      sizingClasses: [...document.querySelectorAll('.sidebar .panel')].map((p) => [...p.classList].find((c) => c === 'panel--fit' || c === 'panel--fill')),
      empty: document.querySelector('.ws-empty')?.textContent.trim() || null,
      newBtn: document.querySelector('.panel--workspaces .panel-act')?.textContent.trim() || null,
      rows: document.querySelectorAll('.ws-row').length,
      folderRows: document.querySelectorAll('.sf-row').length,
    })`);
    await shot('ws-01-empty.png');
    return state;
  });

  await run('W2_create_from_selection', async () => {
    const selCount = await ev(selectTitles(['YouTube', 'Notion']));
    await ev(`document.querySelector('.panel--workspaces .panel-act').click()`);
    await sleep(260);
    const dialog = await ev(`({
      open: !!document.querySelector('.modal'),
      title: document.querySelector('.modal-head')?.textContent.trim() || null,
      note: document.querySelector('.modal-note')?.textContent.trim() || null,
    })`);
    await ev(typeInto('.modal .field-input', '开始工作'));
    await sleep(80);
    await ev(clickModalBtn('创建'));
    await sleep(400);
    const out = {
      selCount,
      dialog,
      workspaces: await ev(wsItems),
      rows: await ev(`[...document.querySelectorAll('.ws-row .ws-name')].map((e) => e.textContent.trim())`),
      // 表头不再有数量徽标（用户要求去掉那个数字），只留「＋ 新建」
      表头计数徽标: await ev(`!!document.querySelector('.panel--workspaces .panel-count')`),
      表头按钮: await ev(`document.querySelector('.panel--workspaces .panel-act')?.textContent.trim() || null`),
      modalClosed: await ev(`!document.querySelector('.modal')`),
      toast: await ev(toastInfo),
    };
    out.表头只剩新建按钮 = out.表头计数徽标 === false && out.表头按钮 === '新建';
    return out;
  });

  await run('W3_add_selection_via_plus', async () => {
    await ev(selectTitles(['GitHub']));
    await ev(`(() => { ${wsAct(2)}.click(); return true })()`);
    await sleep(400);
    const afterAdd = await ev(`window.__store.workspaces[0].items.map((i) => i.title)`);
    const addToast = await ev(toastInfo);
    const autoExpanded = await ev(`window.__store.wsExpanded.size`);
    await ev(`(() => { ${wsAct(2)}.click(); return true })()`);
    await sleep(250);
    const dupToast = await ev(toastInfo);
    await ev(`window.__store.selection = new Set()`);
    await ev(`(() => { ${wsAct(2)}.click(); return true })()`);
    await sleep(250);
    const noneToast = await ev(toastInfo);
    return { afterAdd, addToast, autoExpanded, dupToast, noneToast };
  });

  await run('W4_open_all_and_undo', async () => {
    // chrome.tabs 桩：isExtension 在模块加载时已定为 false（书签仍走 mock），这里只补 tabs
    await ev(`(() => {
      window.__created = []; window.__removed = [];
      window.chrome = window.chrome || {};
      window.chrome.tabs = {
        create(opts, cb) {
          window.__created.push({ url: opts.url, active: opts.active });
          const t = { id: window.__created.length };
          if (cb) cb(t);
          return Promise.resolve(t);
        },
        remove(ids) { window.__removed.push(...[].concat(ids)); },
      };
      return true;
    })()`);
    await ev(`(() => { ${wsAct(1)}.click(); return true })()`);
    await sleep(600);
    const opened = await ev(`window.__created`);
    const toast = await ev(toastInfo);
    await shot('ws-02-open-toast.png');
    await ev(`document.querySelector('.toast-action')?.click()`);
    await sleep(350);
    const removed = await ev(`window.__removed`);
    const afterUndo = await ev(toastInfo);
    return {
      openedCount: opened.length,
      allBackground: opened.every((o) => o.active === false),
      toast,
      removed,
      afterUndo,
      undoClosedEverything: removed.length === opened.length && removed.length > 0,
    };
  });

  await run('W5_persisted_to_storage', async () => {
    await sleep(400);
    return await ev(`(() => {
      const raw = localStorage.getItem('cardtree:workspaces');
      const rawExpanded = localStorage.getItem('cardtree:wsExpanded');
      if (!raw) return { persisted: false };
      const arr = JSON.parse(raw);
      return {
        persisted: true,
        count: arr.length,
        names: arr.map((w) => w.name),
        itemCounts: arr.map((w) => (w.items || []).length),
        keys: arr[0] ? Object.keys(arr[0]).sort() : [],
        firstItemKeys: arr[0]?.items?.[0] ? Object.keys(arr[0].items[0]).sort() : [],
        expandedPersisted: rawExpanded,
      };
    })()`);
  });

  await run('W6_expand_shows_each_tab', async () => {
    // 从"全部收起"的确定状态开始（W3 加项时会顺手展开）
    await ev(`(async () => {
      window.__store.wsExpanded = new Set();
      window.__store.toast = null;
      window.__created = [];
      await new Promise(r => setTimeout(r, 300));
      return true;
    })()`);
    const collapsedStart = await ev(`document.querySelector('.ws-body')?.classList.contains('open')`);
    // 点行 = 展开（不是打开全部）
    await ev(`(() => { document.querySelector('.ws-row').click(); return true })()`);
    await sleep(380);
    const expanded = await ev(`({
      bodyOpen: document.querySelector('.ws-body')?.classList.contains('open'),
      tabs: [...document.querySelectorAll('.ws-tab .ws-tab-name')].map((e) => e.textContent.trim()),
      expandedIds: [...window.__store.wsExpanded].length,
      openedNothingYet: window.__created.length,
      // 每个图标位都必须有东西：要么真图标已加载，要么铺着地球图标打底（不能是空位）
      favSlots: [...document.querySelectorAll('.ws-tab-fav')].map((s) => {
        const img = s.querySelector('img');
        return {
          visibleIcon: (!!img && img.naturalWidth > 0 && img.classList.contains('ready')) || !!s.querySelector('svg'),
          globe: !!s.querySelector('svg'),
          imgLoaded: !!img && img.naturalWidth > 0,
        };
      }),
    })`);
    await shot('ws-04-expanded.png');

    // 点某一个标签页 = 只开这一个
    await ev(`(() => { document.querySelectorAll('.ws-tab')[1].click(); return true })()`);
    await sleep(400);
    const single = await ev(`window.__created`);

    // 「✕」从组里移除（不动书签）
    const beforeRemove = await ev(`window.__store.workspaces[0].items.map((i) => i.title)`);
    await ev(`(() => { document.querySelectorAll('.ws-tab')[1].querySelector('.ws-tab-x').click(); return true })()`);
    await sleep(350);
    const afterRemove = await ev(`window.__store.workspaces[0].items.map((i) => i.title)`);
    const bookmarksStill = await ev(`document.querySelectorAll('.bookmark-item').length`);

    // 收起
    await ev(`(() => { document.querySelector('.ws-row').click(); return true })()`);
    await sleep(350);
    const collapsed = await ev(`({
      bodyOpen: document.querySelector('.ws-body')?.classList.contains('open'),
      pointerEvents: getComputedStyle(document.querySelector('.ws-body')).pointerEvents,
    })`);

    return {
      collapsedStart,
      expanded,
      single,
      singleOnlyOpenedOne: single.length === 1,
      beforeRemove,
      afterRemove,
      bookmarksStill,
      collapsed,
    };
  });

  // 折叠功能已整体移除：卡片永远展开，所以分隔条永远有高度可分配（不会再出现"拖了没反应"）
  await run('W7_no_collapse_so_splitter_always_works', async () => {
    const state = await ev(`({
      chevrons: document.querySelectorAll('.panel-chev').length,
      roleButtonHeaders: document.querySelectorAll('.panel-head[role="button"]').length,
      splitterActive: document.querySelector('.sidebar-splitter').classList.contains('active'),
      splitterCursor: getComputedStyle(document.querySelector('.sidebar-splitter')).cursor,
      panelsStateInStore: 'panels' in window.__store,
      panelsInStorage: localStorage.getItem('cardtree:panels'),
      bothPanelsHaveBody: [...document.querySelectorAll('.sidebar .panel')].every((p) => !!p.querySelector('.panel-body')),
      noCollapsedClass: document.querySelectorAll('.sidebar .panel.collapsed').length === 0,
    })`);
    // 分隔条必须真的能拖（折叠态下曾经拖不动）
    const read = () => ev(`(() => {
      const w = document.querySelector('.panel--workspaces').getBoundingClientRect();
      const sp = document.querySelector('.sidebar-splitter').getBoundingClientRect();
      return { wsH: Math.round(w.height), split: window.__store.panelSplit, x: Math.round(sp.left + sp.width / 2), y: Math.round(sp.top + sp.height / 2) };
    })()`);
    const before = await read();
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x, y: before.y, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x, y: before.y + Math.round(70 * i / 6), button: 'left', buttons: 1 });
      await sleep(35);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x, y: before.y + 70, button: 'left', buttons: 0 });
    await sleep(350);
    const after = await read();
    await shot('ws-05-no-collapse.png');
    return {
      state,
      splitterWorks: after.split > before.split && after.wsH > before.wsH,
      before: { wsH: before.wsH, split: before.split },
      after: { wsH: after.wsH, split: after.split },
    };
  });

  await run('W8_menu_rename_and_delete', async () => {
    await ev(`(() => { ${wsAct(3)}.click(); return true })()`);
    await sleep(240);
    const menu = await ev(`[...document.querySelectorAll('.context-menu-item')].map((e) => e.textContent.trim())`);
    await shot('ws-03-menu.png');
    await ev(`[...document.querySelectorAll('.context-menu-item')].find((e) => e.textContent.trim() === '重命名').click()`);
    await sleep(260);
    const renameTitle = await ev(`document.querySelector('.modal-head')?.textContent.trim() || null`);
    await ev(typeInto('.modal .field-input', '早上第一件事'));
    await sleep(80);
    await ev(clickModalBtn('保存'));
    await sleep(350);
    const renamedRow = await ev(`document.querySelector('.ws-row .ws-name')?.textContent.trim() || null`);

    await ev(`(() => { ${wsAct(3)}.click(); return true })()`);
    await sleep(240);
    await ev(`[...document.querySelectorAll('.context-menu-item')].find((e) => e.textContent.trim() === '删除工作区').click()`);
    await sleep(260);
    const deleteNote = await ev(`document.querySelector('.modal-note')?.textContent.trim() || null`);
    await ev(clickModalBtn('删除'));
    await sleep(450);
    return {
      menu,
      renameTitle,
      renamedRow,
      deleteNote,
      remaining: await ev(`window.__store.workspaces.length`),
      emptyBlockBack: await ev(`!!document.querySelector('.ws-empty')`),
      bookmarksUntouched: await ev(`document.querySelectorAll('.bookmark-item').length`),
    };
  });

  // 塞满工作区：面板应有自己的滚动条，而不是把「文件夹」面板挤出视野
  await run('W9_workspace_panel_scrolls_internally', async () => {
    await ev(`(async () => {
      const s = window.__store;
      s.workspaces = Array.from({ length: 14 }, (_, i) => ({
        id: 'wstest' + i,
        name: '工作区 ' + (i + 1),
        icon: 'briefcase',
        items: [
          { title: 'YouTube', url: 'https://www.youtube.com' },
          { title: 'Notion', url: 'https://www.notion.so' },
        ],
      }));
      s.wsExpanded = new Set();
      await new Promise((r) => setTimeout(r, 450));
      return s.workspaces.length;
    })()`);
    const layout = await ev(`(() => {
      const body = document.querySelector('.panel--workspaces .panel-body');
      const wsPanel = document.querySelector('.panel--workspaces');
      const foldersPanel = document.querySelector('.panel--folders');
      const sidebar = document.querySelector('.sidebar');
      return {
        wsPanelHeight: Math.round(wsPanel.getBoundingClientRect().height),
        foldersPanelHeight: Math.round(foldersPanel.getBoundingClientRect().height),
        sidebarInnerHeight: Math.round(sidebar.clientHeight),
        wsCount: document.querySelectorAll('.ws-row').length,
        bodyScrolls: body.scrollHeight > body.clientHeight + 1,
        bodyScrollHeight: body.scrollHeight,
        bodyClientHeight: body.clientHeight,
      };
    })()`);
    await shot('ws-06-many-workspaces.png');
    return {
      ...layout,
      foldersPanelStillUsable: layout.foldersPanelHeight >= 104,
      wsPanelCapped: layout.wsPanelHeight <= layout.sidebarInnerHeight * 0.46,
    };
  });

  // 深色主题下的观感
  await run('W10_dark_theme_look', async () => {
    await ev(`(async () => {
      const s = window.__store;
      s.workspaces = s.workspaces.slice(0, 2);
      s.wsExpanded = new Set(s.workspaces.map((w) => w.id));
      s.theme = 'dark';
      await new Promise((r) => setTimeout(r, 600));
      return true;
    })()`);
    const state = await ev(`({
      theme: document.body.dataset.theme || document.documentElement.dataset.theme || null,
      rows: document.querySelectorAll('.ws-row').length,
      tabs: document.querySelectorAll('.ws-tab').length,
      panelBg: getComputedStyle(document.querySelector('.panel--workspaces')).backgroundColor,
      panelHeadBg: getComputedStyle(document.querySelector('.panel--workspaces .panel-head')).backgroundColor,
      toastText: document.querySelector('.toast .toast-msg')?.textContent.trim() || null,
    })`);
    await shot('ws-07-dark.png');
    return state;
  });


  // 面板换位已整体移除：卡片顺序固定（工作区在上、文件夹在下）
  await run('W11_panel_reorder_removed', async () => {
    await ev(`(async () => {
      window.__store.theme = 'light';
      window.__store.workspaces = [{
        id: 'wsA', name: '开始工作', icon: 'briefcase',
        items: [{ title: 'YouTube', url: 'https://www.youtube.com' }],
      }];
      window.__store.wsExpanded = new Set();
      await new Promise((r) => setTimeout(r, 400));
      return true;
    })()`);
    const state = await ev(`(() => {
      const panels = [...document.querySelectorAll('.sidebar .panel')];
      return {
        顺序: panels.map((p) => [...p.classList].find((c) => c.startsWith('panel--') && c !== 'panel--fit' && c !== 'panel--fill')),
        sizing: panels.map((p) => [...p.classList].find((c) => c === 'panel--fit' || c === 'panel--fill')),
        拖拽条数量: document.querySelectorAll('.panel-dragbar').length,
        幽灵块: !!document.querySelector('.panel-ghost'),
        可拖标题栏: document.querySelectorAll('.panel-head[draggable="true"]').length,
        store里还有panelOrder: 'panelOrder' in window.__store,
        localStorage里还有panelOrder: localStorage.getItem('cardtree:panelOrder'),
        分隔条仍然在: !!document.querySelector('.sidebar-splitter'),
      };
    })()`);
    return {
      ...state,
      顺序固定: state.顺序[0] === 'panel--workspaces' && state.顺序[1] === 'panel--folders',
      高度分配不变: state.sizing[0] === 'panel--fit' && state.sizing[1] === 'panel--fill',
      无任何拖拽入口: state.拖拽条数量 === 0 && !state.幽灵块 && state.可拖标题栏 === 0,
    };
  });

  // 拖动分隔条调高度：--panel-split 跟着变，且落在合理区间
  await run('W12_drag_splitter_resizes_cards', async () => {
    // 换回工作区在上，并塞满内容，让"高度上限"真的可见
    await ev(`(async () => {
      const s = window.__store;
      s.panelOrder = ['workspaces', 'folders'];
      s.workspaces = Array.from({ length: 12 }, (_, i) => ({
        id: 'wsS' + i, name: '工作区 ' + (i + 1), icon: 'briefcase',
        items: [{ title: 'YouTube', url: 'https://www.youtube.com' }],
      }));
      s.wsExpanded = new Set();
      s.panelSplit = 0.4;
      await new Promise((r) => setTimeout(r, 450));
      return true;
    })()`);
    const geo = await ev(`(() => {
      const sp = document.querySelector('.sidebar-splitter');
      const r = sp.getBoundingClientRect();
      const ws = document.querySelector('.panel--workspaces');
      return {
        splitterActive: sp.classList.contains('active'),
        splitterCursor: getComputedStyle(sp).cursor,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        wsHeightBefore: Math.round(ws.getBoundingClientRect().height),
        flexBasisBefore: getComputedStyle(ws).flexBasis,
      };
    })()`);
    const before = await ev(`window.__store.panelSplit`);
    // 往下拖 130px → 上面那张卡的上限变大
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x, y: geo.y + 130, button: 'left', buttons: 1 });
    await sleep(120);
    const midCursor = await ev(`getComputedStyle(document.body).cursor`);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x, y: geo.y + 130, button: 'left', buttons: 0 });
    await sleep(350);
    const after = await ev(`window.__store.panelSplit`);
    const layout = await ev(`(() => {
      const ws = document.querySelector('.panel--workspaces');
      const folders = document.querySelector('.panel--folders');
      return {
        wsHeight: Math.round(ws.getBoundingClientRect().height),
        foldersHeight: Math.round(folders.getBoundingClientRect().height),
        flexBasis: getComputedStyle(ws).flexBasis,
        bodyScrolls: (() => { const b = document.querySelector('.panel--workspaces .panel-body'); return b.scrollHeight > b.clientHeight + 1; })(),
      };
    })()`);
    const persisted = await ev(`localStorage.getItem('cardtree:panelSplit')`);
    await shot('ws-09-split.png');
    // 越界拖动必须被夹住
    // 越界拖动必须被夹住：拖到侧栏底部 / 顶部
    const dragSplitBy = async (dy) => {
      const g = await ev(`(() => {
        const r = document.querySelector('.sidebar-splitter').getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', clickCount: 1, buttons: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.x, y: g.y + dy, button: 'left', buttons: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: g.y + dy, button: 'left', buttons: 0 });
      await sleep(300);
      return ev(`window.__store.panelSplit`);
    };
    const tooHigh = await dragSplitBy(900);
    const atHigh = await ev(`(() => {
      const ws = document.querySelector('.panel--workspaces').getBoundingClientRect();
      const fd = document.querySelector('.panel--folders').getBoundingClientRect();
      return { wsHeight: Math.round(ws.height), foldersHeight: Math.round(fd.height) };
    })()`);
    await shot('ws-10-split-max.png');
    const tooLow = await dragSplitBy(-1600);
    const clampCheck = { tooHigh, tooLow, highOk: tooHigh <= 0.8 + 1e-6, lowOk: tooLow >= 0.15 - 1e-6, atHigh };
    await ev(`(async () => { window.__store.panelSplit = 0.4; await new Promise((r) => setTimeout(r, 200)); return true })()`);
    return {
      before,
      after,
      geo,
      layout,
      midCursor,
      persisted,
      grew: after > before,
      visibleChange: layout.wsHeight > geo.wsHeightBefore,
      clampCheck,
    };
  });

  // 回归：工作区列表为空（内容比任何上限都短）时，拖分隔条也必须"肉眼可见地动"。
  // 之前用 max-height 当上限，这种情况下数据变了但像素不动 —— 用户只会觉得"拖不动"。
  await run('W13_splitter_visibly_moves_with_short_content', async () => {
    await ev(`(async () => {
      const s = window.__store;
      s.workspaces = [];
      s.wsExpanded = new Set();
      s.panelSplit = 0.3;
      await new Promise((r) => setTimeout(r, 500));
      return true;
    })()`);
    const read = () => ev(`(() => {
      const w = document.querySelector('.panel--workspaces').getBoundingClientRect();
      const f = document.querySelector('.panel--folders').getBoundingClientRect();
      const sp = document.querySelector('.sidebar-splitter').getBoundingClientRect();
      return {
        wsH: Math.round(w.height), fdH: Math.round(f.height),
        split: window.__store.panelSplit,
        flexBasis: getComputedStyle(document.querySelector('.panel--workspaces')).flexBasis,
        contentH: document.querySelector('.panel--workspaces .panel-body').scrollHeight,
        x: Math.round(sp.left + sp.width / 2), y: Math.round(sp.top + sp.height / 2),
      };
    })()`);
    const before = await read();
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x, y: before.y, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 8; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x, y: before.y + Math.round(110 * i / 8), button: 'left', buttons: 1 });
      await sleep(35);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x, y: before.y + 110, button: 'left', buttons: 0 });
    await sleep(400);
    const after = await read();
    await shot('ws-11-split-short-content.png');
    await ev(`(async () => { window.__store.panelSplit = 0.35; await new Promise((r) => setTimeout(r, 200)); return true })()`);
    return {
      before: { wsH: before.wsH, fdH: before.fdH, split: before.split, flexBasis: before.flexBasis, contentH: before.contentH },
      after: { wsH: after.wsH, fdH: after.fdH, split: after.split, flexBasis: after.flexBasis },
      splitGrew: after.split > before.split,
      visibleChange: after.wsH > before.wsH + 20 && after.fdH < before.fdH - 20,
    };
  });

  // 回归：老工作区数据只有 {title,url}（没有 id），书签明明还在却被标成「已删除」。
  // 现在按 url 兜底认领：能找到书签的就是活的，只有真的找不到才打「已删除」。
  await run('W14_legacy_idless_items_are_live', async () => {
    await ev(`(async () => {
      const s = window.__store;
      s.workspaces = [{
        id: 'wsLegacy', name: '老数据', icon: 'briefcase',
        items: [
          { title: 'YouTube', url: 'https://www.youtube.com' },   // 没有 id，但书签还在
          { title: 'Notion', url: 'https://www.notion.so' },
          { title: '已下线的站', url: 'https://gone.example/x' },  // 书签真的没了
        ],
      }];
      s.wsExpanded = new Set(['wsLegacy']);
      await new Promise((r) => setTimeout(r, 450));
      return true;
    })()`);
    const render = await ev(`({
      tabs: [...document.querySelectorAll('.ws-tab')].map((t) => ({
        name: t.querySelector('.ws-tab-name').textContent.trim(),
        gone: !!t.querySelector('.ws-tab-gone'),
        dim: t.classList.contains('missing'),
      })),
      badges: document.querySelectorAll('.ws-tab-gone').length,
    })`);
    await shot('ws-13-legacy-items.png');

    // 触发一次真实重载（书签改名 = onChanged → 重建索引）：老条目应按 url 认领到 id，
    // 并把快照刷成当前标题
    await ev(`(async () => {
      const s = window.__store;
      const yt = [...s.nodesMap.values()].find((n) => n.url === 'https://www.youtube.com');
      await window.__bm.update(yt.id, { title: 'YouTube 主站' });
      await new Promise((r) => setTimeout(r, 700));
      return true;
    })()`);
    const adopted = await ev(`window.__store.workspaces[0].items.map((i) => ({ title: i.title, id: i.id || null }))`);
    const persisted = await ev(`(JSON.parse(localStorage.getItem('cardtree:workspaces') || '[]')[0]?.items || []).map((i) => i.id || null)`);
    await shot('ws-14-legacy-adopted.png');
    return {
      render,
      adopted,
      persisted,
      只有真删的才打标: render.badges === 1 && render.tabs[2].gone === true,
      活条目没打标: render.tabs[0].gone === false && render.tabs[1].gone === false,
      活条目不置灰: render.tabs[0].dim === false && render.tabs[1].dim === false,
      认领到id: !!adopted[0].id && !!adopted[1].id,
      认领后持久化: !!persisted[0] && !!persisted[1],
      快照跟上改名: adopted[0].title === 'YouTube 主站',
      真删的仍无id: !adopted[2].id,
    };
  });

  // 控件尺寸回归：用户反馈「新建工作区的按钮和工作区的按钮都比较小」。
  // 这里把"够不够大"钉成断言（命中面积 + 表头按钮 + 标签页行 + 名称可用宽度 + 两张卡按钮一致），
  // 免得以后改 CSS 又缩回去。数值口径见 test/sidebar-workspace-metrics.mjs。
  await run('W15_controls_are_comfortable', async () => {
    await ev(`(async () => {
      const s = window.__store;
      s.workspaces = [{ id: 'wsSize', name: '开始工作', icon: 'briefcase', items: [
        { id: 'b-youtube', title: 'YouTube', url: 'https://www.youtube.com' },
      ] }];
      s.wsExpanded = new Set(['wsSize']);
      await new Promise((r) => setTimeout(r, 450));
      return true;
    })()`);
    const m = await ev(`(() => {
      const box = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height) };
      };
      const iconW = (sel) => {
        const e = document.querySelector(sel);
        return e ? Math.round(e.getBoundingClientRect().width) : null;
      };
      const css = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
      return {
        行内按钮: box('.ws-act'),
        行内图标: iconW('.ws-act svg'),
        表头新建: box('.panel--workspaces .panel-act'),
        表头新建字号: css('.panel--workspaces .panel-act', 'fontSize'),
        标签行: box('.ws-tab'),
        标签移除: box('.ws-tab-x'),
        行高: box('.ws-row').h,
        名称宽: Math.round(document.querySelector('.ws-row .ws-name').getBoundingClientRect().width),
        文件夹按钮: box('.sf-act'),
      };
    })()`);
    await shot('ws-15-controls.png');
    return {
      ...m,
      行内按钮够大: m.行内按钮.w >= 22 && m.行内按钮.h >= 22,
      行内图标够大: m.行内图标 >= 14,
      表头按钮够大: m.表头新建.h >= 26 && parseFloat(m.表头新建字号) >= 12,
      标签行够高: m.标签行.h >= 28,
      移除按钮够大: m.标签移除.w >= 20 && m.标签移除.h >= 20,
      名称仍有空间: m.名称宽 >= 78,
      两卡按钮一致: m.行内按钮.w === m.文件夹按钮.w && m.行内按钮.h === m.文件夹按钮.h,
    };
  });

  results.pageErrors = pageErrors;
  console.log(JSON.stringify(results, null, 2));
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  try { edge.kill('SIGTERM'); } catch { /* ignore */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
