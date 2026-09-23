/* 验证：悬浮面板「自动获取」能抓取网页 meta description 并写进描述框（真实扩展 + host_permissions） */
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const CDP = 'http://127.0.0.1:9237';
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

// 本地测试页，带 meta description
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><html><head><meta name="description" content="自动抓取的网页描述-ABC123"></head><body><h1>Test Page</h1></body></html>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/page`;

const profile = mkdtempSync(join(tmpdir(), 'cardtree-autodesc-'));
const edge = spawn(EDGE, [
  '--headless=new','--no-sandbox','--disable-gpu','--no-first-run',
  `--remote-debugging-port=9237`, `--user-data-dir=${profile}`,
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

  // 创建一个指向本地测试页的书签（书签栏 parentId = '1'）
  await ev(`new Promise(res => chrome.bookmarks.create({ parentId:'1', title:'测试页', url:${JSON.stringify(pageUrl)} }, () => res(true)))`);
  // 等待它出现在界面
  let found=false;
  for(let i=0;i<60;i++){await sleep(250);if(await ev(`[...document.querySelectorAll('.bookmark-item')].some(e => e.querySelector('.bookmark-title')?.textContent === '测试页')`)){found=true;break;}}
  console.log('bookmark rendered:', found);

  // 悬浮 → 面板出现
  await ev(`(() => {
    const el = [...document.querySelectorAll('.bookmark-item')].find(e => e.querySelector('.bookmark-title')?.textContent === '测试页');
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles:false }));
  })()`);
  await sleep(400);
  const btnShown = await ev(`!!document.querySelector('.pop-auto')`);
  console.log('auto button shown:', btnShown);

  // 点击自动获取
  await ev(`document.querySelector('.pop-auto').click()`);
  // 等待抓取完成
  let descVal='';
  for(let i=0;i<40;i++){await sleep(250);descVal=await ev(`document.querySelector('.pop-textarea')?.value || ''`);if(descVal)break;}
  console.log('fetched desc:', JSON.stringify(descVal));

  // 保存并确认落库
  await ev(`document.querySelector('.pop-actions .btn-primary').click()`);
  await sleep(400);
  const meta = await ev(`new Promise(res => chrome.storage.local.get('nodeMeta', v => res(JSON.stringify(v.nodeMeta || {}))))`);
  console.log('saved meta:', meta);
} finally {
  try{ws&&ws.close();}catch{}
  try{edge.kill('SIGTERM');}catch{}
  try{rmSync(profile,{recursive:true,force:true});}catch{}
  try{server.close();}catch{}
}
