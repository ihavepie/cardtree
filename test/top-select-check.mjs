/* 验证：选中文件夹只高亮顶层，子文件夹/后代不高亮 */
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9237';
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const profile = mkdtempSync(join(tmpdir(), 'cardtree-topsel-'));
const edge = spawn(EDGE, ['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',`--remote-debugging-port=9237`,`--user-data-dir=${profile}`,'--window-size=1400,1000','about:blank'], { stdio: 'ignore' });
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

  // 展开前端开发（侧边栏单击箭头），以便主区能看到组件库
  await ev(`(() => { const r = [...document.querySelectorAll('.sf-row')].find(x => x.querySelector('.sf-name')?.textContent === '前端开发'); r.querySelector('.sf-chev').click(); return true; })()`);
  await sleep(300);

  // 单击侧边栏「前端开发」行选中
  await ev(`(() => { const r = [...document.querySelectorAll('.sf-row')].find(x => x.querySelector('.sf-name')?.textContent === '前端开发'); r.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await sleep(100);

  const result = await ev(`({
    selSize: window.__store.selection.size,
    topLevel: JSON.stringify(window.__store.selection.size ? [...window.__store.selection].filter(id => { const n = window.__store.nodesMap.get(id); return n && n.parentId ? !window.__store.selection.has(n.parentId) : true; }) : []),
    // 主区「前端开发」heading 高亮
    devHeading: (() => { const n = document.querySelector('.main [data-id="f-dev"] .cascade-heading'); return n.classList.contains('selected'); })(),
    // 子文件夹「组件库」heading 不高亮
    uiHeading: (() => { const n = document.querySelector('.main [data-id="f-dev-ui"] .cascade-heading'); return n.classList.contains('selected'); })(),
    // 后代书签「Vue.js」不高亮
    vueSelected: (() => { const b = [...document.querySelectorAll('.bookmark-item')].find(e => e.querySelector('.bookmark-title')?.textContent === 'Vue.js'); return b.classList.contains('selected'); })(),
  })`);

  console.log(JSON.stringify(result, null, 2));
} finally {
  try{ws&&ws.close();}catch{}
  try{edge.kill('SIGTERM');}catch{}
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
