/* 验证侧边栏：渲染、点击定位、折叠切换 */
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9229';
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const profile = mkdtempSync(join(tmpdir(), 'cardtree-sidebar-'));
const edge = spawn(EDGE, ['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',`--remote-debugging-port=9229`,`--user-data-dir=${profile}`,'--window-size=1400,1000','about:blank'], { stdio: 'ignore' });
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

  const render = await ev(`({
    hasSidebar: !!document.querySelector('.sidebar'),
    sidebarWidth: Math.round(document.querySelector('.sidebar')?.getBoundingClientRect().width || 0),
    sfRows: document.querySelectorAll('.sf-row').length,
  })`);

  // 点击侧边栏「设计灵感」
  await ev(`(() => {
    const row = [...document.querySelectorAll('.sf-row')].find(r => r.querySelector('.sf-name')?.textContent === '设计灵感');
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  const afterPick = await ev(`({
    focusId: window.__store.focusId,
    collapsed: window.__store.collapsed.has('f-design'),
    bodyHeight: (document.querySelector('.main [data-id="f-design"] .cascade-body')?.getBoundingClientRect().height || 0),
  })`);

  // 点击顶栏 sidebar-toggle 隐藏侧边栏
  await ev(`document.querySelector('.sidebar-toggle').click()`);
  await sleep(400);
  const afterToggle = await ev(`({
    hiddenClass: document.querySelector('.sidebar').classList.contains('hidden'),
    sidebarWidth: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
  })`);

  console.log(JSON.stringify({ render, afterPick, afterToggle }, null, 2));
} finally {
  try{ws&&ws.close();}catch{}
  try{edge.kill('SIGTERM');}catch{}
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
