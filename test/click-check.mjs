/* 验证：单击书签立即选中（selection 与 class 同步） */
import { mkdtempSync, rmSync, existsSync} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9234';
// Edge 可能装在 /Applications 或外置卷；用 EDGE_BIN 可覆盖
const EDGE = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean).find((p) => existsSync(p));
if (!EDGE) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');
const profile = mkdtempSync(join(tmpdir(), 'cardtree-click2-'));
const edge = spawn(EDGE, ['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',`--remote-debugging-port=9234`,`--user-data-dir=${profile}`,'--window-size=1400,1000','about:blank'], { stdio: 'ignore' });
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

  const yt = `[...document.querySelectorAll('.bookmark-item')].find(e => e.querySelector('.bookmark-title')?.textContent === 'YouTube')`;
  const x = `[...document.querySelectorAll('.bookmark-item')].find(e => e.querySelector('.bookmark-title')?.textContent === 'X / Twitter')`;

  // 单击 YouTube
  await ev(`(${yt}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  const selImmediate = await ev(`JSON.stringify([...window.__store.selection])`);
  await sleep(80);
  const ytSelected = await ev(`(${yt}).classList.contains('selected')`);

  // 单击 X，验证单选切换（YouTube 应取消选中）
  await ev(`(${x}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(80);
  const afterSwitch = await ev(`({ yt: (${yt}).classList.contains('selected'), x: (${x}).classList.contains('selected'), sel: JSON.stringify([...window.__store.selection]) })`);

  console.log(JSON.stringify({ selImmediate, ytSelected, afterSwitch }, null, 2));
} finally {
  try{ws&&ws.close();}catch{}
  try{edge.kill('SIGTERM');}catch{}
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
