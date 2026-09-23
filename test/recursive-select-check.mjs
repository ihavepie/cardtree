/* 验证：选中文件夹递归包含后代（子文件夹 + 书签） */
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9236';
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const profile = mkdtempSync(join(tmpdir(), 'cardtree-recsel-'));
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
  await send('Page.enable');await send('Runtime.enable');
  await send('Page.navigate',{url:'http://localhost:5199/'});
  for(let i=0;i<60;i++){await sleep(250);if(await ev(`!!(window.__store && !window.__store.loading)`))break;}
  await sleep(600);

  // 单击侧边栏「前端开发」行（它有子文件夹「组件库」+ 多个书签）
  await ev(`(() => {
    const row = [...document.querySelectorAll('.sf-row')].find(r => r.querySelector('.sf-name')?.textContent === '前端开发');
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  await sleep(100);
  const sel = await ev(`JSON.stringify([...window.__store.selection].sort())`);
  const count = await ev(`window.__store.selection.size`);

  console.log(JSON.stringify({ count, sel }, null, 2));
} finally {
  try{ws&&ws.close();}catch{}
  try{edge.kill('SIGTERM');}catch{}
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
