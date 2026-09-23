/* 验证：背景系统、侧边栏右键菜单、拖拽到侧边栏 */
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9231';
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const profile = mkdtempSync(join(tmpdir(), 'cardtree-feat-'));
const edge = spawn(EDGE, ['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',`--remote-debugging-port=9231`,`--user-data-dir=${profile}`,'--window-size=1400,1000','about:blank'], { stdio: 'ignore' });
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
  await send('Page.enable');await send('Runtime.enable');
  await send('Page.navigate',{url:'http://localhost:5199/'});
  for(let i=0;i<60;i++){await sleep(250);if(await ev(`!!(window.__store && !window.__store.loading)`))break;}
  await sleep(600);

  // 1) 背景面板 + 预设
  await ev(`document.querySelector('.icon-btn[title="背景"]').click()`);
  await sleep(200);
  const panelOpen = await ev(`!!document.querySelector('.bg-panel')`);
  await ev(`document.querySelectorAll('.bg-preset')[1].click()`);
  await sleep(200);
  const bgAfterPreset = await ev(`({ bg: JSON.stringify(window.__store.bg), hasBgStyle: !!document.querySelector('.bg').getAttribute('style') })`);
  // 随机
  await ev(`document.querySelector('.icon-btn[title="背景"]').click()`);
  await sleep(200);
  await ev(`[...document.querySelectorAll('.bg-actions .btn')].find(b => b.textContent.includes('随机')).click()`);
  await sleep(200);
  const bgAfterRandom = await ev(`JSON.stringify(window.__store.bg)`);
  await ev(`window.__store.bgPanelOpen = false`);

  // 2) 侧边栏右键菜单
  await ev(`(() => {
    const row = [...document.querySelectorAll('.sf-row')].find(r => r.querySelector('.sf-name')?.textContent === '设计灵感');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 300 }));
    return true;
  })()`);
  await sleep(150);
  const menuItems = await ev(`[...document.querySelectorAll('.context-menu-item')].map(b => b.innerText.trim())`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

  // 3) 拖拽主区书签到侧边栏文件夹
  await ev(`(() => {
    const src = [...document.querySelectorAll('.bookmark-item')].find(e => e.querySelector('.bookmark-title')?.textContent === '知乎');
    const dst = [...document.querySelectorAll('.sf-row')].find(r => r.querySelector('.sf-name')?.textContent === '设计灵感');
    const r = dst.getBoundingClientRect();
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width/2, clientY: r.top + r.height/2 }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width/2, clientY: r.top + r.height/2 }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return true;
  })()`);
  await sleep(800);
  const designChildren = await ev(`(async () => { const roots = await window.__bm.getRoots(); const bar = roots.find(r => r.title === '书签栏'); const d = bar.children.find(c => c.title === '设计灵感'); return d.children.map(c => c.title); })()`);

  console.log(JSON.stringify({ panelOpen, bgAfterPreset, bgAfterRandom, menuItems, designChildren }, null, 2));
} finally {
  try{ws&&ws.close();}catch{}
  try{edge.kill('SIGTERM');}catch{}
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
