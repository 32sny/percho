// Isolated Electron component smoke test, not a full-app/backend end-to-end test.
// Run after `npm run build -w packages/desktop`. No user profile or real session is opened.
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = process.cwd();
const temp = await mkdtemp(join(tmpdir(), "percho-hover-dom-"));
const assets = resolve(root, "packages/desktop/out/renderer/assets");
let css;
for (const file of await readdir(assets)) {
	if (
		/^index-.*\.css$/.test(file) &&
		(await readFile(join(assets, file), "utf8")).includes("--color-surface")
	)
		css = file;
}
if (!css) throw new Error("Build the desktop renderer first");
const src = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { emptyTranscript } from '@percho/shared';
import { emptyStreaming } from './packages/shared/src/transcript/helpers';
import { SessionHoverProvider } from './packages/desktop/src/renderer/src/components/sidebar/SessionHoverProvider';
import { SessionRow } from './packages/desktop/src/renderer/src/components/sidebar/SessionRow';
import { useSessionsStore } from './packages/desktop/src/renderer/src/stores/sessions';
import { useProjectsStore } from './packages/desktop/src/renderer/src/stores/projects';
import { useTranscriptStore } from './packages/desktop/src/renderer/src/stores/transcript';
import { useSettingsStore } from './packages/desktop/src/renderer/src/stores/settings';
import { useSubagentReturnStore } from './packages/desktop/src/renderer/src/stores/subagent-return';
import { useI18nStore } from './packages/desktop/src/renderer/src/i18n';
const meta={sessionId:'A',cwd:'C:/fixture',sessionFile:'C:/fixture/parent-secret.jsonl',name:'悬停目标（非当前会话）',active:true,messageCount:1,createdAt:1};
const metaB={...meta,sessionId:'B',sessionFile:'C:/fixture/secret-b.jsonl',name:'未载入的历史会话'};
// 9 条假分页 fixture：按 childrenOffset 切 6 条页，固定 revision/offset/total/hidden（非真实后端）。
const children=Array.from({length:9},(_,i)=>({sessionFile:'C:/fixture/secret-child-'+i+'.jsonl',agent:'scout',status:i===0?'running':i===1?'error':'done',taskFirstLine:'需要在窄窗口中完整换行显示并保留两行截断的任务文本'.repeat(5)}));
const parentDto={sessionId:'P',sessionFile:'C:/fixture/secret-parent.jsonl',cwd:'C:/fixture',name:'DTO父名（应被历史标题盖住）'};
window.requests=[]; window.navigations=[]; window.parentLinked=true;
window.pi = new Proxy({getSessionHoverPreview: async (request)=>{window.requests.push(request);if(request.sessionId!=='A')return {status:'empty',sessionId:request.sessionId};const offset=request.childrenOffset??0;const page=children.slice(offset,offset+6);return {status:'empty',sessionId:'A',dependencySessionIds:['P'],relations:{children:page,hidden:Math.max(0,9-offset-page.length),offset,total:9,revision:'fixture-rev-1',parent:window.parentLinked?parentDto:undefined}};}}, {get:(target,key)=>target[key]??(()=>Promise.resolve())});
useI18nStore.setState({language:'zh'});
useSessionsStore.setState({sessions:[meta],activeSessionId:'OTHER',openSubagentSessionFrom:async(parent,file)=>{window.navigations.push({kind:'child',parent,file,cardOpen:!!document.querySelector('[data-session-hover-card]')});return {ok:false};},returnToParent:async(id,fallback)=>{window.navigations.push({kind:'parent',id,fallback});return true;}});
useProjectsStore.setState({allSessions:[meta,{...meta,sessionId:'P',name:'已卸载父会话的历史标题'}]});
useTranscriptStore.setState({bySession:{A:{...emptyTranscript(),pendingPermissions:[],pendingDialogs:[]}}});
// 冷启动：不 remember 任何关系，父入口只能来自后端验证的 parent DTO。
useSubagentReturnStore.setState({relations:{}});
window.returnRelationCount=()=>Object.keys(useSubagentReturnStore.getState().relations).length;
window.updateParent=linked=>{window.parentLinked=linked;useTranscriptStore.setState(state=>({bySession:{...state.bySession,P:{...emptyTranscript(),pendingPermissions:[],pendingDialogs:[],messages:[{kind:'user',id:'parent-change',text:String(linked),timestamp:1,images:[]}]}}}))};
useSettingsStore.setState({open:false});
window.updateLive=()=>useTranscriptStore.setState(state=>({bySession:{...state.bySession,A:{...state.bySession.A,streaming:{...emptyStreaming(),subagentRuns:[{key:'t:0',sessionFile:'C:/fixture/secret-live.jsonl',agent:'scout',status:'running'}]}}}}));
window.updateToken=()=>useTranscriptStore.setState(state=>({bySession:{...state.bySession,A:{...state.bySession.A,streaming:{...state.bySession.A.streaming,text:'more tokens'}}}}));
window.openSettings=()=>useSettingsStore.setState({open:true});
createRoot(document.getElementById('root')).render(<SessionHoverProvider sessions={[meta,metaB]}><div id='row' style={{width:210,marginTop:320}}><SessionRow session={meta} active={false} onSelect={()=>{}} onContextMenu={()=>{}} /></div><div id='row-b' style={{width:210}}><SessionRow session={metaB} active={false} onSelect={()=>{}} onContextMenu={()=>{}} /></div><button id='after'>之后的按钮</button></SessionHoverProvider>);
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
	`<!doctype html><html lang="zh" data-app-ready data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(join(assets, css))}"></head><body class="bg-surface text-ink"><div id="root"></div><script src="renderer.js"></script></body></html>`,
);
await writeFile(
	join(temp, "main.cjs"),
	`
const {app,BrowserWindow}=require('electron');
const {join}=require('node:path');
app.setPath('userData',join(__dirname,'profile'));
app.commandLine.appendSwitch('disable-gpu');
const assertions=[];
const assert=(v,label)=>{if(!v)throw new Error(label);assertions.push(label);};
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:600,height:560,show:true,skipTaskbar:true,title:'Percho 悬停卡隔离验收',webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message)});
 const js=expression=>win.webContents.executeJavaScript(expression,true);
 const wait=async(expression)=>{for(let i=0;i<100;i++){if(await js(expression))return;await new Promise(r=>setTimeout(r,30));}throw new Error('DOM timeout: '+expression)};
 const key=async(keyCode,modifiers=[])=>{win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});if(keyCode==='Enter')win.webContents.sendInputEvent({type:'char',keyCode:'\\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await new Promise(r=>setTimeout(r,80));};
 try{
  await win.loadFile(join(__dirname,'index.html'));
  await wait("!!document.querySelector('#row button')");
  await new Promise(r=>setTimeout(r,500));
  await js("document.querySelector('#after').focus();document.querySelector('#row button').focus()");
  await wait("!!document.querySelector('[data-session-hover-card] li button')");
  assert(await js("document.querySelectorAll('[data-session-hover-card] li').length===6 && document.body.textContent.includes('还有 3')"),'six rows and hidden count');
  // 不等待 TTL、不关闭卡片：父变化使已缓存子关系失效，负结果也能恢复。
  await js('window.updateParent(false)');
  await wait("document.querySelectorAll('[data-session-hover-card] li').length===6 && ![...document.querySelectorAll('[data-session-hover-card] button')].some(b=>(b.getAttribute('aria-label')||'').startsWith('返回父会话'))");
  assert(true,'parent invalidation removes cached child parent entry without waiting for TTL');
  await js('window.updateParent(true)');
  await wait("[...document.querySelectorAll('[data-session-hover-card] button')].some(b=>(b.getAttribute('aria-label')||'').startsWith('返回父会话'))");
  assert(true,'negative parent dependency restores the entry on a later parent change');
  // 显示更多 → 9 行 → 收起 → 6 行；键盘 Enter 操作，焦点在卡片内合理归还、不关卡。
  await js("[...document.querySelectorAll('[data-session-hover-card] button')].find(b=>b.textContent.includes('显示更多')).focus()");
  await key('Enter');
  await wait("document.querySelectorAll('[data-session-hover-card] li').length===9");
  assert(await js("window.requests.some(r=>r.childrenOffset===6)"),'show more requests page at offset 6');
  assert(await js("document.activeElement?.textContent==='收起子会话列表' && !!document.querySelector('[data-session-hover-card]')"),'focus moves to collapse button after last page, card stays open');
  await key('Enter');
  await wait("document.querySelectorAll('[data-session-hover-card] li').length===6");
  assert(await js("document.activeElement?.textContent?.includes('显示更多')"),'focus returns to show-more button after collapse');
  await key('Escape');
  await wait("!document.querySelector('[data-session-hover-card]')");
  await js("document.querySelector('#after').focus();document.querySelector('#row button').focus()");
  await wait("!!document.querySelector('[data-session-hover-card]')");
  assert(await js("(()=>{const d=document.querySelector('[data-session-hover-card] .bg-err');return !!d && !['transparent','rgba(0, 0, 0, 0)'].includes(getComputedStyle(d).backgroundColor)})()"),'error dot has a real theme color');
  assert(await js("document.body.textContent.includes('已卸载父会话的历史标题')"),'parent title from history');
  assert(await js("!document.body.innerHTML.includes('secret-child') && !document.body.innerHTML.includes('secret-parent')"),'no navigation paths in DOM');
  assert(await js("(()=>{const b=document.querySelector('[data-session-hover-card] li button');return document.getElementById(b.getAttribute('aria-describedby')).textContent==='运行中'})()"),'accessible status description');
  assert(await js("(()=>{const p=document.querySelector('[data-session-hover-card] .line-clamp-2');const s=getComputedStyle(p);return s.webkitLineClamp==='2' && s.display!=='block'})()"),'built CSS two-line clamp');
  await wait("(()=>{const e=document.querySelector('[data-session-hover-card]');if(!e||getComputedStyle(e).visibility==='hidden')return false;const r=e.getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()");
  assert(await js("(()=>{const r=document.querySelector('[data-session-hover-card]').getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()"),'600px viewport placement');
  await key('Tab');
  assert(await js("document.activeElement.matches('[data-session-hover-card]')"),'Tab enters portal card');
  await key('Tab');
  assert(await js("document.activeElement.getAttribute('aria-label')==='复制完整标题'"),'Tab reaches first action');
  await key('Tab',['shift']);
  assert(await js("document.activeElement===document.querySelector('#row button')"),'Shift+Tab returns anchor');
  await js("document.querySelector('[data-session-hover-card] li button').focus()");
  await key('Enter');
  await wait('window.navigations.length===1');
  assert(await js("window.navigations[0].parent.sessionId==='A'"),'Enter navigates with hovered parent');
  await wait("!document.querySelector('[data-session-hover-card]')");
  // 冷 parentDTO：无 remember 关系也显示返回入口，点击带 DTO 映射的 fallback，且不写 store。
  await js("document.querySelector('#row button').focus()");
  await wait("!!document.querySelector('[data-session-hover-card]')");
  await js("[...document.querySelectorAll('[data-session-hover-card] button')].find(b=>(b.getAttribute('aria-label')||'').startsWith('返回父会话')).focus()");
  await key('Enter');
  await wait('window.navigations.length===2');
  assert(await js("window.navigations[1].kind==='parent' && window.navigations[1].id==='A' && window.navigations[1].fallback?.parentSessionId==='P' && window.navigations[1].fallback?.parentFile==='C:/fixture/secret-parent.jsonl' && window.navigations[1].fallback?.cwd==='C:/fixture'"),'cold parent DTO navigates with mapped fallback');
  assert(await js('window.returnRelationCount()===0'),'hover does not remember parent relation in store');
  await wait("!document.querySelector('[data-session-hover-card]')");
  // 未载入会话显示历史会话文案，不伪装实时状态。
  await js("document.querySelector('#row-b button').focus()");
  await wait("document.querySelector('[data-session-hover-card]')?.dataset.sessionHoverCard==='B'");
  assert(await js("document.body.textContent.includes('历史会话') && !document.body.textContent.includes('未加载')"),'historical session copy for unloaded session');
  await key('Escape');
  await wait("!document.querySelector('[data-session-hover-card]')");
  await js("document.querySelector('#row button').focus()");
  await wait("!!document.querySelector('[data-session-hover-card]')");
  await key('Escape');
  assert(await js("!document.querySelector('[data-session-hover-card]')"),'Escape closes card');
  await js("document.querySelector('#after').focus();document.querySelector('#row button').focus()");
  await wait("!!document.querySelector('[data-session-hover-card]')");
  await js('window.updateLive()');
  await wait('window.requests.at(-1).liveRuns?.some(r=>r.source==="streaming")');
  const before=await js('window.requests.length');
  await js('window.updateToken()');
  await new Promise(r=>setTimeout(r,100));
  assert((await js('window.requests.length'))===before,'unrelated token causes no preview request');
  await js("document.querySelector('[data-session-hover-card] > section:last-of-type button').focus()");
  await key('Tab');
  assert(await js("document.activeElement===document.querySelector('#row-b button') && document.querySelector('[data-session-hover-card]')?.dataset.sessionHoverCard==='B'"),'last Tab exits current card to next session row');
  // 注：以上为隔离 fixture 验收，不代表完整重启或真实后端链路。
  await js("document.querySelector('#row button').focus()");
  await wait("!!document.querySelector('[data-session-hover-card]')");
  await js('window.openSettings()');
  await wait("!document.querySelector('[data-session-hover-card]')");
  console.log(JSON.stringify({status:'PASS',assertions}));
  app.exit(0);
 }catch(e){console.error(e.stack);console.error(await js("JSON.stringify({focus:document.activeElement?.outerHTML,body:document.body.innerText,requests:window.requests?.length,nav:window.navigations})"));console.error(assertions);app.exit(1);}
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
			no(new Error("Electron smoke timeout"));
		}, 45000);
		child.on("error", (e) => {
			clearTimeout(timer);
			no(e);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			yes(code);
		});
	});
	if (code !== 0) process.exitCode = 1;
} finally {
	await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
