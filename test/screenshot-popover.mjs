/* 截取悬浮面板用于视觉检查 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP = 'http://127.0.0.1:9238';
const PAGE = 'http://localhost:4173/';
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const OUT = fileURLToPath(new URL('./screens/popover.png', import.meta.url));
const profile = mkdtempSync(join(tmpdir(), 'cardtree-shot-'));
const edge = spawn(EDGE, ['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',`--remote-debugging-port=9238`,`--user-data-dir=${profile}`,'--window-size=1400,1000','about:blank'], { stdio: 'ignore' });
async function waitHttp(u,t=15000){const t0=Date.now();while(Date.now()-t0<t){try{return await (await fetch(u)).json();}catch{await new Promise(r=>setTimeout(r,250));}}throw new Error('CDP');}
let ws;
try {
  const list = await waitHttp(CDP + '/json');
  ws = new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  let id=0;const pending=new Map();
  ws.onmessage=(ev)=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
  const send=(method,params={})=>new Promise((res,rej)=>{const i=++id;pending.set(i,m=>m.error?rej(new Error(m.error.message)):res(m.result));ws.send(JSON.stringify({id:i,method,params}));});
  const ev=async e=>(await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true})).result.value;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  await send('Page.enable');await send('Runtime.enable');
  await send('Page.navigate',{url:PAGE});
  for(let i=0;i<60;i++){await sleep(250);if(await ev(`document.querySelectorAll('.bookmark-item').length > 0`))break;}
  await sleep(500);
  await ev(`(() => { const el = document.querySelectorAll('.bookmark-item')[0]; el.dispatchEvent(new MouseEvent('mouseenter', { bubbles:false })); })()`);
  await sleep(500);
  const r = await send('Page.captureScreenshot',{ format:'png' });
  writeFileSync(OUT, Buffer.from(r.data,'base64'));
  console.log('saved', OUT);
} finally {
  try{ws&&ws.close();}catch{}
  try{edge.kill('SIGTERM');}catch{}
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
