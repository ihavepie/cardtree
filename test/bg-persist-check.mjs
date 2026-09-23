/* 验证：动态背景在刷新后持久化（customBackgrounds 深度监听修复） */
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9234';
const PAGE = 'http://localhost:5174/';
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const profile = mkdtempSync(join(tmpdir(), 'cardtree-bgpersist-'));
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
  const ready=async()=>{for(let i=0;i<60;i++){await sleep(250);if(await ev(`!!(window.__store && !window.__store.loading)`))return;}throw new Error('not ready');};
  await send('Page.enable');await send('Runtime.enable');

  // 1) 首次加载，设置一个动态背景
  await send('Page.navigate',{url:PAGE});
  await ready(); await sleep(400);

  // 打开背景面板 → 展开自定义背景 → 选「呼吸」效果 → 保存
  await ev(`document.querySelector('.icon-btn[title="背景"]').click()`);
  await sleep(150);
  await ev(`document.querySelector('.bg-advanced').open = true`);
  await sleep(150);
  const before = await ev(`(() => {
    const sel = document.querySelector('.bg-effect-select');
    sel.value = 'breath'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    const row = sel.closest('.bg-custom-row');
    row.querySelector('.btn').click();
    return true;
  })()`);
  await sleep(400);
  const afterSet = await ev(`({
    bg: JSON.parse(JSON.stringify(window.__store.bg)),
    customLen: window.__store.customBackgrounds.length,
    customType: window.__store.customBackgrounds[0]?.type,
    customEffect: window.__store.customBackgrounds[0]?.effect,
    lsBg: localStorage.getItem('cardtree:bg'),
    lsCustom: localStorage.getItem('cardtree:customBackgrounds'),
  })`);

  // 2) 刷新页面
  await send('Page.navigate',{url:PAGE});
  await ready(); await sleep(500);
  const afterReload = await ev(`({
    bg: JSON.parse(JSON.stringify(window.__store.bg)),
    customLen: window.__store.customBackgrounds.length,
    customType: window.__store.customBackgrounds[0]?.type,
    customEffect: window.__store.customBackgrounds[0]?.effect,
    bgElBackground: getComputedStyle(document.querySelector('.bg')).backgroundImage,
    bgElAnim: getComputedStyle(document.querySelector('.bg')).animationName,
  })`);

  console.log(JSON.stringify({ before, afterSet, afterReload }, null, 2));
} finally {
  try{ws&&ws.close();}catch{}
  try{edge.kill('SIGTERM');}catch{}
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
