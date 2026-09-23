/* 验证：真实扩展环境（chrome.storage.local）下背景能否持久化 + Proxy 序列化假设 */
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const CDP = 'http://127.0.0.1:9235';
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const profile = mkdtempSync(join(tmpdir(), 'cardtree-extpersist-'));
const edge = spawn(EDGE, [
  '--headless=new','--no-sandbox','--disable-gpu','--no-first-run',
  `--remote-debugging-port=9235`, `--user-data-dir=${profile}`,
  `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`,
  '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' });

async function waitHttp(u,t=20000){const t0=Date.now();while(Date.now()-t0<t){try{return await (await fetch(u)).json();}catch{await new Promise(r=>setTimeout(r,250));}}throw new Error('CDP not ready');}
let ws;
try {
  const list = await waitHttp(CDP + '/json');
  ws = new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  let id=0;const pending=new Map();
  ws.onmessage=(ev)=>{const m=JSON.parse(ev.data);if(m.method==='Runtime.exceptionThrown')console.log('EXC',m.params.exceptionDetails?.exception?.description||'');if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
  const send=(method,params={})=>new Promise((res,rej)=>{const i=++id;pending.set(i,m=>m.error?rej(new Error(m.error.message)):res(m.result));ws.send(JSON.stringify({id:i,method,params}));});
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  await send('Page.enable');await send('Runtime.enable');

  await send('Page.navigate',{url:'chrome://newtab/'});
  await sleep(2500);
  console.log('href:', await ev(`location.href`));

  // 等待书签渲染完成
  let ready=false;
  for(let i=0;i<60;i++){await sleep(250);if(await ev(`document.querySelectorAll('.bookmark-item').length > 0`)){ready=true;break;}}
  console.log('app rendered:', ready);

  // A) 直接验证 Proxy 能否被 chrome.storage.local 正确序列化
  const proxyTest = await ev(`new Promise(res => {
    const plain = [{ id:'x', type:'flow', effect:'breath' }];
    const proxy = new Proxy(plain, {});
    chrome.storage.local.set({ __proxytest: proxy }, () => {
      chrome.storage.local.get('__proxytest', (v) => res(JSON.stringify(v.__proxytest)));
    });
  })`);
  console.log('proxy roundtrip:', proxyTest);

  // B) 通过 UI 设置动态背景
  await ev(`document.querySelector('.icon-btn[title="背景"]').click()`);
  await sleep(200);
  await ev(`document.querySelector('.bg-advanced').open = true`);
  await sleep(200);
  await ev(`(() => {
    const sel = document.querySelector('.bg-effect-select');
    sel.value = 'breath'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.closest('.bg-custom-row').querySelector('.btn').click();
    return true;
  })()`);
  await sleep(800);

  const stored = await ev(`new Promise(res => chrome.storage.local.get(null, v => res(JSON.stringify(v))))`);
  console.log('stored after set:', stored);

  // C) 刷新
  await send('Page.navigate',{url:'chrome://newtab/'});
  await sleep(2500);
  ready=false;
  for(let i=0;i<60;i++){await sleep(250);if(await ev(`document.querySelectorAll('.bookmark-item').length > 0`)){ready=true;break;}}
  const after = await ev(`({
    bgAnim: getComputedStyle(document.querySelector('.bg')).animationName,
    bgImage: getComputedStyle(document.querySelector('.bg')).backgroundImage,
  })`);
  console.log('after reload:', JSON.stringify(after));
} finally {
  try{ws&&ws.close();}catch{}
  try{edge.kill('SIGTERM');}catch{}
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
