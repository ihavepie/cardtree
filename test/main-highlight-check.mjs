/* 验证：主区选中文件夹整体高亮，侧边栏只顶层高亮 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9238';
// Edge 可能装在 /Applications 或外置卷；用 EDGE_BIN 可覆盖
const EDGE = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean).find((p) => existsSync(p));
if (!EDGE) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');
const profile = mkdtempSync(join(tmpdir(), 'cardtree-mainhl-'));
const edge = spawn(EDGE, ['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',`--remote-debugging-port=9238`,`--user-data-dir=${profile}`,'--window-size=1400,1000','about:blank'], { stdio: 'ignore' });
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

  // 展开前端开发（侧边栏箭头），让主区能看到组件库和书签
  await ev(`(() => { const r = [...document.querySelectorAll('.sf-row')].find(x => x.querySelector('.sf-name')?.textContent === '前端开发'); r.querySelector('.sf-chev').click(); return true; })()`);
  await sleep(300);

  // 单击侧边栏「前端开发」行选中
  await ev(`(() => { const r = [...document.querySelectorAll('.sf-row')].find(x => x.querySelector('.sf-name')?.textContent === '前端开发'); r.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await sleep(100);

  const result = await ev(`({
    // 主区：被选中的顶层文件夹整张卡片高亮；后代卡片/书签不高亮（选中语义 = 只看顶层）
    // 选中态现在挂在卡片上（.cascade-card.selected），标题栏只是卡内的一行
    devHeading: !!document.querySelector('.main [data-id="f-dev"] .cascade-card')?.classList.contains('selected'),
    uiHeading: !!document.querySelector('.main [data-id="f-dev-ui"] .cascade-card')?.classList.contains('selected'),
    devHeadingClass: !!document.querySelector('.main [data-id="f-dev"] .cascade-heading')?.classList.contains('selected'),
    vueSelected: [...document.querySelectorAll('.bookmark-item')].find(e => e.querySelector('.bookmark-title')?.textContent === 'Vue.js').classList.contains('selected'),
    // 侧边栏：前端开发行高亮，组件库行不高亮
    sfDev: [...document.querySelectorAll('.sf-row')].find(r => r.querySelector('.sf-name')?.textContent === '前端开发').classList.contains('selected'),
    sfUi: [...document.querySelectorAll('.sf-row')].find(r => r.querySelector('.sf-name')?.textContent === '组件库').classList.contains('selected'),
  })`);

  console.log(JSON.stringify(result, null, 2));
} finally {
  try{ws&&ws.close();}catch{}
  try{edge.kill('SIGTERM');}catch{}
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
