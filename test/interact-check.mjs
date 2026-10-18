/* 验证：单击选中、箭头展开收缩、双击展开收缩 */
import { mkdtempSync, rmSync, existsSync} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9235';
// Edge 可能装在 /Applications 或外置卷；用 EDGE_BIN 可覆盖
const EDGE = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean).find((p) => existsSync(p));
if (!EDGE) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');
const profile = mkdtempSync(join(tmpdir(), 'cardtree-interact-'));
const edge = spawn(EDGE, ['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',`--remote-debugging-port=9235`,`--user-data-dir=${profile}`,'--window-size=1400,1000','about:blank'], { stdio: 'ignore' });
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

  // 1) 单击侧边栏「设计灵感」行 → 选中，但不展开
  await ev(`(${sfDesign}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(100);
  const afterClick = await ev(`({
    sel: JSON.stringify([...window.__store.selection]),
    selectedClass: (${sfDesign}).classList.contains('selected'),
    stillCollapsed: window.__store.collapsed.has('f-design'),
  })`);

  // 2) 单击箭头 → 展开
  await ev(`(${sfDesign}).querySelector('.sf-chev').click()`);
  await sleep(300);
  const afterArrow = await ev(`({ collapsed: window.__store.collapsed.has('f-design') })`);

  // 3) 双击行 → 折叠（toggle）
  await ev(`(${sfDesign}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(300);
  const afterDbl = await ev(`({ collapsed: window.__store.collapsed.has('f-design') })`);

  console.log(JSON.stringify({ afterClick, afterArrow, afterDbl }, null, 2));
} finally {
  try{ws&&ws.close();}catch{}
  try{edge.kill('SIGTERM');}catch{}
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
