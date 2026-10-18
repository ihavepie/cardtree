/* 验证：单一顶层、顶层唯一蓝、点空白取消选中 */
import { mkdtempSync, rmSync, existsSync} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9240';
// Edge 可能装在 /Applications 或外置卷；用 EDGE_BIN 可覆盖
const EDGE = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean).find((p) => existsSync(p));
if (!EDGE) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');
const profile = mkdtempSync(join(tmpdir(), 'cardtree-top1-'));
const edge = spawn(EDGE, ['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',`--remote-debugging-port=9240`,`--user-data-dir=${profile}`,'--window-size=1400,1000','about:blank'], { stdio: 'ignore' });
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

  // 1) 顶层数量 + 其他书签是否成为书签栏子文件夹
  const rootsInfo = await ev(`(async () => {
    const roots = await window.__bm.getRoots();
    const bar = window.__store.roots[0];
    return {
      displayRootCount: window.__store.roots.length,
      displayRootTitle: bar && bar.title,
      barChildTitles: bar ? bar.children.map(c => c.title) : [],
    };
  })()`);

  // 2) 展开前端开发 + 组件库，选中前端开发，再选中组件库，检查只有组件库蓝（父被取消）
  await ev(`(() => { const r = [...document.querySelectorAll('.sf-row')].find(x => x.querySelector('.sf-name')?.textContent === '前端开发'); r.querySelector('.sf-chev').click(); return true; })()`);
  await sleep(300);
  await ev(`(() => { const r = [...document.querySelectorAll('.sf-row')].find(x => x.querySelector('.sf-name')?.textContent === '组件库'); r.querySelector('.sf-chev').click(); return true; })()`);
  await sleep(300);
  // 先点前端开发
  await ev(`(() => { const r = [...document.querySelectorAll('.sf-row')].find(x => x.querySelector('.sf-name')?.textContent === '前端开发'); r.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await sleep(80);
  const devSelected = await ev(`document.querySelector('.main [data-id="f-dev"] .cascade-card').classList.contains('selected')`);
  const uiSelectedWhenDev = await ev(`document.querySelector('.main [data-id="f-dev-ui"] .cascade-card').classList.contains('selected')`);
  // 再点组件库
  await ev(`(() => { const r = [...document.querySelectorAll('.sf-row')].find(x => x.querySelector('.sf-name')?.textContent === '组件库'); r.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await sleep(80);
  const uiSelectedAfter = await ev(`document.querySelector('.main [data-id="f-dev-ui"] .cascade-card').classList.contains('selected')`);
  const devSelectedAfter = await ev(`document.querySelector('.main [data-id="f-dev"] .cascade-card').classList.contains('selected')`);

  // 3) 点击空白取消选中
  await ev(`document.querySelector('.main-inner').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(80);
  const selAfterBlank = await ev(`window.__store.selection.size`);

  console.log(JSON.stringify({ rootsInfo, devSelected, uiSelectedWhenDev, uiSelectedAfter, devSelectedAfter, selAfterBlank }, null, 2));
} finally {
  try{ws&&ws.close();}catch{}
  try{edge.kill('SIGTERM');}catch{}
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
