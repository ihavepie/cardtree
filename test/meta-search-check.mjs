/* 验证：悬浮面板编辑描述/标签、按标签搜索、改名「书签板」、选中不破坏 */
import { mkdtempSync, rmSync, existsSync} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9236';
const PAGE = 'http://localhost:5175/';
// Edge 可能装在 /Applications 或外置卷；用 EDGE_BIN 可覆盖
const EDGE = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean).find((p) => existsSync(p));
if (!EDGE) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');
const profile = mkdtempSync(join(tmpdir(), 'cardtree-meta-'));
const edge = spawn(EDGE, ['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',`--remote-debugging-port=9236`,`--user-data-dir=${profile}`,'--window-size=1400,1000','about:blank'], { stdio: 'ignore' });
async function waitHttp(u,t=15000){const t0=Date.now();while(Date.now()-t0<t){try{return await (await fetch(u)).json();}catch{await new Promise(r=>setTimeout(r,250));}}throw new Error('CDP');}
let ws;
try {
  const list = await waitHttp(CDP + '/json');
  ws = new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  let id=0;const pending=new Map();
  ws.onmessage=(ev)=>{const m=JSON.parse(ev.data);if(m.method==='Runtime.exceptionThrown')console.log('EXC',m.params.exceptionDetails?.exception?.description||'');if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
  const send=(method,params={})=>new Promise((res,rej)=>{const i=++id;pending.set(i,m=>m.error?rej(new Error(m.error.message)):res(m.result));ws.send(JSON.stringify({id:i,method,params}));});
  const ev=async e=>(await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true})).result.value;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const ready=async()=>{for(let i=0;i<60;i++){await sleep(250);if(await ev(`!!(window.__store && !window.__store.loading && document.querySelectorAll('.bookmark-item').length > 0)`))return;}};
  await send('Page.enable');await send('Runtime.enable');
  await send('Page.navigate',{url:PAGE});
  await ready(); await sleep(500);

  // 1) 改名
  const brand = await ev(`document.querySelector('.brand-name')?.textContent`);
  console.log('brand:', brand);

  // 2) 悬浮一个书签 → 面板出现
  const hovered = await ev(`(async () => {
    const el = document.querySelectorAll('.bookmark-item')[0];
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    await new Promise(r => setTimeout(r, 400));
    const pop = document.querySelector('.bookmark-popover');
    return { popupShown: !!pop, title: pop ? pop.querySelector('.pop-title')?.textContent : '' };
  })()`);
  console.log('hover:', JSON.stringify(hovered));

  // 3) 在面板里填描述 + 标签并保存
  const saved = await ev(`(async () => {
    const id = document.querySelector('.bookmark-item').getAttribute('data-id');
    const ta = document.querySelector('.pop-textarea');
    const inp = document.querySelector('.pop-input');
    ta.value = '一个用于测试的标签页'; ta.dispatchEvent(new Event('input'));
    inp.value = '灵感, 测试'; inp.dispatchEvent(new Event('input'));
    document.querySelector('.pop-actions .btn-primary').click();
    await new Promise(r => setTimeout(r, 300));
    const meta = window.__store.nodeMeta[id];
    return { id, meta: JSON.parse(JSON.stringify(meta || null)), ls: localStorage.getItem('cardtree:nodeMeta') };
  })()`);
  console.log('saved:', JSON.stringify(saved));

  // 4) 按标签搜索
  const searchHit = await ev(`(async () => {
    const i = document.querySelector('.search-input');
    i.value = '灵感'; i.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 400));
    const titles = [...document.querySelectorAll('.search-result .sr-title')].map(e => e.textContent);
    const tags = [...document.querySelectorAll('.search-result .tag-chip')].map(e => e.textContent);
    i.value = ''; i.dispatchEvent(new Event('input'));
    return { titles, tags };
  })()`);
  console.log('search:', JSON.stringify(searchHit));

  // 5) 按描述搜索
  const searchDesc = await ev(`(async () => {
    const i = document.querySelector('.search-input');
    i.value = '测试'; i.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 400));
    const titles = [...document.querySelectorAll('.search-result .sr-title')].map(e => e.textContent);
    i.value = ''; i.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 200));
    return titles;
  })()`);
  console.log('search-desc:', JSON.stringify(searchDesc));

  // 6) 选中不破坏
  const selectOk = await ev(`(async () => {
    const el = document.querySelectorAll('.bookmark-item')[1];
    el.click();
    await new Promise(r => setTimeout(r, 100));
    return el.classList.contains('selected');
  })()`);
  console.log('select-ok:', selectOk);

  // 7) 刷新后 meta 持久化
  await send('Page.navigate',{url:PAGE});
  await ready(); await sleep(500);
  const afterReload = await ev(`(() => {
    const metas = Object.values(window.__store.nodeMeta || {});
    return { count: metas.length, first: JSON.parse(JSON.stringify(metas[0] || null)) };
  })()`);
  console.log('after-reload:', JSON.stringify(afterReload));
} finally {
  try{ws&&ws.close();}catch{}
  try{edge.kill('SIGTERM');}catch{}
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
