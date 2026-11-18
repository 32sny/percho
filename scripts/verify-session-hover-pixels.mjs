// 会话悬停卡（SESSION-HOVER-01）像素验收：真实 Electron + 真实构建 CSS，对照定稿原型。
// 用法：npm run build -w packages/desktop && node scripts/verify-session-hover-pixels.mjs
// 产物写入 .local/design/session-hover/verify/（本地验收目录，不入库）。
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = process.cwd();
const outDir = resolve(root, ".local/design/session-hover/verify");
const protoHtml = "D:/Project/Percho/功能/会话悬停详情功能/redesign-preview.html";
const assets = resolve(root, "packages/desktop/out/renderer/assets");

await mkdir(outDir, { recursive: true });
let css;
for (const file of await readdir(assets)) {
	if (
		/^index-.*\.css$/.test(file) &&
		(await readFile(join(assets, file), "utf8")).includes("--color-surface")
	)
		css = file;
}
if (!css) throw new Error("先构建 renderer：npm run build -w packages/desktop");

const temp = await mkdtemp(join(tmpdir(), "percho-hover-pixels-"));

// 与定稿原型同文案的 fixture：角色 1/1/50（合计 52），最新一条 Fixer。
const src = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SessionHoverProvider } from './packages/desktop/src/renderer/src/components/sidebar/SessionHoverProvider';
import { SessionRow } from './packages/desktop/src/renderer/src/components/sidebar/SessionRow';
import { useSessionsStore } from './packages/desktop/src/renderer/src/stores/sessions';
import { useProjectsStore } from './packages/desktop/src/renderer/src/stores/projects';
import { useTranscriptStore } from './packages/desktop/src/renderer/src/stores/transcript';
import { useSettingsStore } from './packages/desktop/src/renderer/src/stores/settings';
import { useI18nStore } from './packages/desktop/src/renderer/src/i18n';

const TASKS = [
  '执行本轮有限G5及G4的SDK自动测试准备，当前Percho…',
  '复跑G2真实auto3mode+G3 manual保护，前端修复…',
  'G2真实UI确证缺陷最小修复：Composer/use-compo…',
  '执行G2/G3/G4真实Electron/provider补验，只写仓…',
  '只读方案评审，不改代码/跑测试。Percho G2剩余…',
];
const AGENTS = ['Fixer','Fixer','Fixer','Fixer','Fibemd'].map((a,i)=>i===4?'Fixer':a);
const children = TASKS.map((task,i)=>({sessionFile:'C:/fixture/child-'+i+'.jsonl',agent:'Fixer',status:'done',taskFirstLine:task}));
while (children.length < 6) children.push({sessionFile:'C:/fixture/child-'+children.length+'.jsonl',agent:'Oracle',status:'done',taskFirstLine:'只读方案评审，不改代码/跑测试。Percho G2剩余…'});

const meta = {
  sessionId:'A',
  cwd:'C:/Users/Administrator/Desktop/Percho',
  sessionFile:'C:/fixture/hover.jsonl',
  name:'1113 | 优化 | SDK升级迁移与验收 | ACK边界方案定稿中',
  active:false,
  messageCount:12,
  modelLabel:'claude-opus-4-6',
  createdAt: new Date('2026-11-13T10:28:00+08:00').getTime(),
  modifiedAt: new Date('2026-11-15T15:54:00+08:00').getTime(),
};

window.pi = new Proxy({
  getSessionHoverPreview: async (request) => ({
    status:'ok',
    source:'current-branch-first-user-text',
    sessionId:request.sessionId,
    text:'@…/percho-transcripts/01a1cf77…9e32.md',
    relations:{
      children: children.slice(0,6),
      hidden: 46,
      total: 52,
      offset: 0,
      revision: 'pixel-rev-1',
      roleCounts: [
        {label:'Oracle', count:1, status:'done'},
        {label:'Verifier', count:1, status:'done'},
        {label:'Fixer', count:50, status:'done'},
      ],
    },
  }),
}, { get:(t,k)=>t[k] ?? (()=>Promise.resolve()) });

useI18nStore.setState({language:'zh'});
useSettingsStore.setState({open:false});
useSessionsStore.setState({sessions:[meta], activeSessionId:'OTHER', openSubagentSessionFrom:async()=>({ok:false}), returnToParent:async()=>true});
useProjectsStore.setState({allSessions:[meta]});
useTranscriptStore.setState({bySession:{}});

createRoot(document.getElementById('root')).render(
  <SessionHoverProvider sessions={[meta]}>
    <div id="row" style={{width:224, marginTop:120}}>
      <SessionRow session={meta} active={false} onSelect={()=>{}} onContextMenu={()=>{}} />
    </div>
  </SessionHoverProvider>
);
`;
await build({
	stdin: { contents: src, loader: "tsx", resolveDir: root },
	bundle: true,
	platform: "browser",
	format: "iife",
	jsx: "automatic",
	outfile: join(temp, "renderer.js"),
	define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
	join(temp, "index.html"),
	`<!doctype html><html lang="zh" data-app-ready data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(join(assets, css))}"></head><body class="bg-canvas text-ink"><div id="root"></div><script src="renderer.js"></script></body></html>`,
);

// 对比图：每张只放一对（本仓 | 定稿原型），按 2x 自然尺寸铺满一屏内可截范围。
const shot = (name) => pathToFileURL(join(outDir, name)).href;
const pairPage = (left, right, llabel, rlabel) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;padding:14px 18px;background:#f6f6f8;font-family:"Microsoft YaHei",sans-serif}
  h1{font-size:13px;font-weight:600;color:#3f3f46;margin:0 0 10px}
  .row{display:flex;gap:18px;align-items:flex-start}
  .col{display:flex;flex-direction:column;gap:4px}
  .lbl{font-size:10px;color:#71717a}
  img{display:block;width:440px;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.08);background:#fff}
</style></head><body><h1>会话悬停卡 SESSION-HOVER-01 · 本仓实现 vs 定稿原型</h1>
<div class="row">
  <div class="col"><span class="lbl">${llabel}</span><img src="${shot(left)}"></div>
  <div class="col"><span class="lbl">${rlabel}</span><img src="${shot(right)}"></div>
</div></body></html>`;
await writeFile(
	join(temp, "compare-collapsed.html"),
	pairPage("ours-collapsed.png", "proto-collapsed.png", "本仓 · 默认收起", "原型 · 默认收起"),
);
await writeFile(
	join(temp, "compare-expanded.html"),
	pairPage("ours-expanded.png", "proto-expanded.png", "本仓 · 展开", "原型 · 展开"),
);

await writeFile(
	join(temp, "main.cjs"),
	`
const {app,BrowserWindow}=require('electron');
const {join}=require('node:path');
const {writeFileSync}=require('node:fs');
app.setPath('userData',join(__dirname,'profile'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor','2');
const PAD=14;
const out=(name)=>join(${JSON.stringify(outDir)},name);
app.whenReady().then(async()=>{
 const make=async(file,width,height,opts={})=>{
  const win=new BrowserWindow({width,height,show:true,skipTaskbar:true,backgroundColor:'#f6f6f8',webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,...opts}});
  win.webContents.on('console-message',(event)=>{if(event.level==='error')console.error('[renderer]',event.message)});
  await win.loadFile(file);
  return win;
 };
 const js=(win,expr)=>win.webContents.executeJavaScript(expr,true);
 const wait=async(win,expr)=>{for(let i=0;i<150;i++){if(await js(win,expr))return;await new Promise(r=>setTimeout(r,40));}throw new Error('timeout: '+expr)};
 const grab=async(win,name,rect)=>{
  const img=await win.webContents.capturePage({x:Math.max(0,Math.floor(rect.x-PAD)),y:Math.max(0,Math.floor(rect.y-PAD)),width:Math.ceil(rect.width+PAD*2),height:Math.ceil(rect.height+PAD*2)});
  writeFileSync(out(name),img.toPNG());
 };
 const metrics=async(win)=>js(win,\`(()=>{
   const card=document.querySelector('[data-session-hover-card]');
   const q=(s)=>card.querySelector(s);
   const cs=(el)=>el?getComputedStyle(el):null;
   const rect=(el)=>{const r=el.getBoundingClientRect();return {w:+r.width.toFixed(1),h:+r.height.toFixed(1)}};
   const metaRow=card.querySelector('[data-session-hover-status]');
   const title=card.querySelector('h2');
   const section=card.querySelector('section');
   const chips=section&&section.querySelector('ul li');
   const toggle=section&&[...section.querySelectorAll('button')].find(b=>b.getAttribute('aria-expanded')!==null);
   const list=[...card.querySelectorAll('li')].find(li=>li.querySelector('[role]')===null&&li.querySelector('button.grid'));
   const row=list&&list.querySelector('button.grid');
   const time=card.lastElementChild;
   const mcs=cs(metaRow), tcs=cs(title), ccs=cs(chips), gcs=cs(toggle), rcs=cs(row);
   if(!ccs) return {error:'chips missing',body:card.outerHTML.slice(0,1200)};
   return {
     cardW:rect(card).w, cardH:rect(card).h, pad:cs(card).padding, radius:cs(card).borderRadius, border:cs(card).borderTopWidth, shadow:cs(card).boxShadow,
     titleFont:[tcs.fontSize,tcs.fontWeight,tcs.lineHeight].join('/'),
     meta:{mt:mcs.marginTop,gap:mcs.columnGap,font:mcs.fontSize,dot:rect(metaRow.firstElementChild).w},
     chip:{pad:ccs.padding,radius:ccs.borderRadius,font:ccs.fontSize},
     toggle:{pad:gcs.padding,radius:gcs.borderRadius,bg:gcs.backgroundColor,font:gcs.fontSize,weight:gcs.fontWeight},
     row:{h:rcs?rect(row).h:0,pad:rcs?rcs.paddingLeft:0,gap:rcs?rcs.columnGap:0,cols:rcs?rcs.gridTemplateColumns:''},
     timeFont:cs(time).fontSize,
     geom:[...card.children].map(el=>{const b=el.getBoundingClientRect();const t=card.getBoundingClientRect();return [el.tagName.toLowerCase(),+(b.top-t.top).toFixed(1),+b.height.toFixed(1)]}),
     metaText:metaRow.textContent,
   };
 })()\`);
 const protoMetrics=(win)=>js(win,\`(()=>{
   const card=document.querySelectorAll('.hover-card')[0];
   const g=(el)=>el?getComputedStyle(el):null; const r=(el)=>{const b=el.getBoundingClientRect();return {w:+b.width.toFixed(1),h:+b.height.toFixed(1)}};
   const title=card.querySelector('h2'), metaRow=card.children[1], q=card.children[2], chipsRow=card.children[4], chip=chipsRow.querySelector('span'), toggle=chipsRow.lastElementChild, latest=card.children[5], time=card.children[6];
   const tcs=g(title), mcs=g(metaRow), ccs=g(chip), gcs=g(toggle), lcs=g(latest);
   return {cardW:r(card).w,cardH:r(card).h,pad:g(card).padding,radius:g(card).borderRadius,border:g(card).borderTopWidth,
     titleFont:[tcs.fontSize,tcs.fontWeight,tcs.lineHeight].join('/'),
     meta:{mt:mcs.marginTop,gap:mcs.columnGap,font:mcs.fontSize,dot:r(metaRow.firstElementChild).w},
     chip:{pad:ccs.padding,radius:ccs.borderRadius,font:ccs.fontSize},
     toggle:{pad:gcs.padding,radius:gcs.borderRadius,bg:gcs.backgroundColor,font:gcs.fontSize,weight:gcs.fontWeight},
     row:{h:0,pad:0,gap:0,cols:''}, timeFont:g(time).fontSize, latestPad:lcs.padding,
     geom:[...card.children].map(el=>{const b=el.getBoundingClientRect();const t=card.getBoundingClientRect();return [el.tagName.toLowerCase(),+(b.top-t.top).toFixed(1),+b.height.toFixed(1)]})};
 })()\`);
 try{
  const ours=await make(join(__dirname,'index.html'),900,820);
  await wait(ours,"!!document.querySelector('#row button')");
  await js(ours,"document.querySelector('#row button').focus()");
  await wait(ours,"(()=>{const c=document.querySelector('[data-session-hover-card]');return !!c&&getComputedStyle(c).visibility==='visible'})()");
  await wait(ours,"!!document.querySelector('[data-session-hover-card] section ul li')");
  await new Promise(r=>setTimeout(r,350));
  let rect=await js(ours,"(()=>{const r=document.querySelector('[data-session-hover-card]').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
  await grab(ours,'ours-collapsed.png',rect);
  const ourMetrics=await metrics(ours);
  await js(ours,"[...document.querySelectorAll('[data-session-hover-card] button')].find(b=>b.getAttribute('aria-expanded')==='false').click()");
  await wait(ours,"(()=>{const u=document.querySelector('[data-session-hover-card] ul[id$=\\"children-list\\"]');return !!u&&u.querySelectorAll('li').length===6})()");
  await new Promise(r=>setTimeout(r,250));
  rect=await js(ours,"(()=>{const r=document.querySelector('[data-session-hover-card]').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
  await grab(ours,'ours-expanded.png',rect);
  const ourExpanded=await js(ours,"(()=>{const c=document.querySelector('[data-session-hover-card]');const list=c.querySelector('ul[id$=\\"children-list\\"]');const row=list.querySelector('button');const cs=getComputedStyle(row);const r=row.getBoundingClientRect();return {h:+r.height.toFixed(1),pad:cs.paddingLeft,gap:cs.columnGap,cols:cs.gridTemplateColumns,cardH:+c.getBoundingClientRect().height.toFixed(1)}})()");

  const proto=await make(${JSON.stringify(protoHtml)},1560,1200);
  await wait(proto,"document.querySelectorAll('.hover-card').length===2");
  await new Promise(r=>setTimeout(r,400));
  for (const [i,name] of [[0,'proto-collapsed.png'],[1,'proto-expanded.png']]) {
   await js(proto,"document.querySelectorAll('.hover-card')["+i+"].scrollIntoView({block:'center'})");
   await new Promise(r=>setTimeout(r,220));
   const r=await js(proto,"(()=>{const b=document.querySelectorAll('.hover-card')["+i+"].getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}})()");
   await grab(proto,name,r);
  }
  const protoStyle=await protoMetrics(proto);
  const protoExpanded=await js(proto,"(()=>{const c=document.querySelectorAll('.hover-card')[1];const row=c.querySelector('div[style*=\\"grid-template-columns\\"]');const cs=getComputedStyle(row);const r=row.getBoundingClientRect();return {h:+r.height.toFixed(1),pad:cs.paddingLeft,gap:cs.columnGap,cols:cs.gridTemplateColumns,cardH:+c.getBoundingClientRect().height.toFixed(1)}})()");

  for (const name of ['compare-collapsed','compare-expanded']) {
   const win=await make(join(__dirname,name+'.html'),960,560);
   await js(win,"Promise.all([...document.images].map(i=>i.complete?1:new Promise(r=>{i.onload=r;i.onerror=r})))");
   await new Promise(r=>setTimeout(r,350));
   const size=await js(win,"({w:Math.max(document.body.scrollWidth,document.documentElement.scrollWidth),h:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)})");
   const img=await win.webContents.capturePage({x:0,y:0,width:Math.min(size.w,940),height:Math.min(size.h,520)});
   writeFileSync(out(name+'.png'),img.toPNG());
   win.destroy();
  }

  const report={ourMetrics,ourExpanded,protoMetrics:protoStyle,protoExpanded};
  writeFileSync(out('metrics.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  app.exit(0);
 }catch(e){console.error(e.stack);app.exit(1);}
});
`,
);

try {
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	const code = await new Promise((yes, no) => {
		const child = spawn(require("electron"), [join(temp, "main.cjs")], { env, stdio: "inherit" });
		const timer = setTimeout(() => {
			child.kill();
			no(new Error("Electron pixels timeout"));
		}, 90000);
		child.on("error", (e) => {
			clearTimeout(timer);
			no(e);
		});
		child.on("exit", (c) => {
			clearTimeout(timer);
			yes(c);
		});
	});
	if (code !== 0) process.exitCode = 1;
} finally {
	await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
