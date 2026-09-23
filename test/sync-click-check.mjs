/* 验证：侧边栏/主区单击展开收缩同步 + 顶层分区可折叠 */
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9232';
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const profile = mkdtempSync(join(tmpdir(), 'cardtree-click-'));
const edge = spawn(EDGE, ['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',`--remote-debugging-port=9232`,`--user-data-dir=${profile}`,'--window-size=1400,1000','about:blank'], { stdio: 'ignore' });
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

  const sfDesign = `[...document.querySelectorAll('.sf-row')].find(r => r.querySelector('.sf-name')?.textContent === '设计灵感')`;
  const barHead = `[...document.querySelectorAll('.root-section')].find(s => s.querySelector('.section-label')?.textContent.includes('书签栏')).querySelector('.section-head')`;
  const st = () => ev(`({
    fdesign: window.__store.collapsed.has('f-design'),
    bar: window.__store.collapsed.has('bar'),
    barCardHidden: (() => { const inner = ${barHead}.parentElement.querySelector('.root-body-inner'); return Math.round(inner.getBoundingClientRect().height) === 0; })(),
  })`);

  const init = await st();
  // 单击侧边栏「设计灵感」→ 展开
  await ev(`(${sfDesign}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(250);
  const afterSideClick = await st();
  // 再单击 → 折叠
  await ev(`(${sfDesign}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(250);
  const afterSideClick2 = await st();
  // 双击 → 定位（展开 + focusId）
  await ev(`(${sfDesign}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(400);
  const afterDbl = await ev(`({ fdesign: window.__store.collapsed.has('f-design'), focusId: window.__store.focusId })`);
  // 单击主区书签栏标题 → 折叠整个分区
  await ev(`(${barHead}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(250);
  const afterBarClick = await st();

  console.log(JSON.stringify({ init, afterSideClick, afterSideClick2, afterDbl, afterBarClick }, null, 2));
} finally {
  try{ws&&ws.close();}catch{}
  try{edge.kill('SIGTERM');}catch{}
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
