/* 验证：卡片显示标签/描述 + 右侧抽屉编辑保存 + 点空白关闭 */
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CDP='http://127.0.0.1:9242', PAGE='http://localhost:5199/';
const EDGE='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const profile=mkdtempSync(join(tmpdir(),'ct-'));
const edge=spawn(EDGE,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',`--remote-debugging-port=9242`,`--user-data-dir=${profile}`,'--window-size=1400,1000','about:blank'],{stdio:'ignore'});
async function wh(u,t=15000){const t0=Date.now();while(Date.now()-t0<t){try{return await(await fetch(u)).json();}catch{await new Promise(r=>setTimeout(r,250));}}throw new Error('CDP');}
let ws;
try{
  const l=await wh(CDP+'/json');ws=new WebSocket(l.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  let id=0;const p=new Map();
  ws.onmessage=(ev)=>{const m=JSON.parse(ev.data);if(m.method==='Runtime.exceptionThrown')console.log('EXC',m.params.exceptionDetails?.exception?.description||'');if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}};
  const send=(method,params={})=>new Promise((res,rej)=>{const i=++id;p.set(i,m=>m.error?rej(new Error(m.error.message)):res(m.result));ws.send(JSON.stringify({id:i,method,params}));});
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  await send('Page.enable');await send('Runtime.enable');
  await send('Page.navigate',{url:PAGE});
  for(let i=0;i<60;i++){await sleep(250);if(await ev(`document.querySelectorAll('.bookmark-item').length>0`))break;}
  await sleep(300);

  const r=await ev(`(async()=>{
    // 1) 单击书签 → 抽屉出现
    const el=document.querySelectorAll('.bookmark-item')[0];
    el.click();
    await new Promise(r=>setTimeout(r,250));
    const drawerShown=!!document.querySelector('.detail-drawer');

    // 2) 在抽屉里编辑描述/标签并保存
    const ta=document.querySelector('.dd-textarea');
    const inp=document.querySelector('.dd-input');
    ta.value='抽屉写入的描述'; ta.dispatchEvent(new Event('input'));
    inp.value='灵感, 工作'; inp.dispatchEvent(new Event('input'));
    document.querySelector('.dd-actions .btn-primary').click();
    await new Promise(r=>setTimeout(r,300));

    // 3) 卡片上应显示描述与标签
    const cardDesc=el.querySelector('.bookmark-desc')?.textContent || '';
    const cardTags=[...el.querySelectorAll('.bookmark-tags .tag-chip')].map(e=>e.textContent);

    // 4) 点空白 → 抽屉关闭
    document.querySelector('.main').dispatchEvent(new MouseEvent('click',{bubbles:true}));
    await new Promise(r=>setTimeout(r,500));
    const drawerGone=!document.querySelector('.detail-drawer');

    return { drawerShown, cardDesc, cardTags, drawerGone };
  })()`);
  console.log(JSON.stringify(r));
}finally{try{ws&&ws.close();}catch{}try{edge.kill('SIGTERM');}catch{}try{rmSync(profile,{recursive:true,force:true});}catch{}}
