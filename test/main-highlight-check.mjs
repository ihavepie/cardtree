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
  // 页面里的异常要暴露出来，否则 e.result.value 只是 undefined，问题会被吞掉
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('页面异常: '+(r.exceptionDetails.exception?.description||r.exceptionDetails.text));return r.result.value};
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

  // 取消选中（点主区空白处 → clearSelection）：主卡片上**不该留下任何高亮**
  const readMark = `(() => {
    const card = document.querySelector('.main [data-id="f-dev"] .cascade-card');
    return {
      focused: document.querySelectorAll('.main .cascade-card.focused').length,
      selected: document.querySelectorAll('.main .cascade-card.selected').length,
      bg: card ? getComputedStyle(card).backgroundColor : null,
      focusId: window.__store.focusId,
      selectionSize: window.__store.selection.size,
    };
  })()`;
  const marked = await ev(readMark);
  await ev(`(() => { document.querySelector('.main').dispatchEvent(new MouseEvent('click', { bubbles: true })); return true })()`);
  await sleep(250);
  const cleared = await ev(readMark);

  // 选中时的高亮底色必须是"主题色淡层"，不能是白色高光（浅色 --hover-bg = rgba(255,255,255,.5)）
  const whiteish = (c) => /^rgba?\(255, 255, 255/.test(c);

  console.log(JSON.stringify({
    ...result,
    选中时: marked,
    取消选中后: cleared,
    // 侧栏单击现在**只选中/高亮**（不再 revealNode → 不设 focusId、不展开、不滚动）
    选中时确实有高亮: marked.selected === 1,
    侧栏单击不再设定位标记: marked.focused === 0,
    选中时底色不是白印子: !whiteish(marked.bg || ''),
    取消选中后没有残留高亮: cleared.focused === 0 && cleared.selected === 0,
    取消选中后底色透明: /rgba\(0, 0, 0, 0\)/.test(cleared.bg || ''),
    定位状态被一起清掉: cleared.focusId === null && cleared.selectionSize === 0,
  }, null, 2));
} finally {
  try{ws&&ws.close();}catch{}
  try{edge.kill('SIGTERM');}catch{}
  try{rmSync(profile,{recursive:true,force:true});}catch{}
}
