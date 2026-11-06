// Runs the .user.js files of a directory you choose through the
// unmodified production engine inside a real WKWebView isolated content world.
// Reports per-script startup errors, registered menu commands and DOM effects.
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { buildEngine } from "./helpers/engine-harness.js";

const dir = process.argv[2];
if (!dir) {
	console.error(
		"Usage: node tests/user-scripts-webkit.js <directory of .user.js files>",
	);
	process.exit(64);
}
const files = (await readdir(dir)).filter((f) => f.endsWith(".user.js"));
const scripts = [];
for (const [index, file] of files.entries()) {
	const code = await readFile(`${dir}/${file}`, "utf8");
	const meta = code.match(/==UserScript==([\s\S]*?)==\/UserScript==/)[1];
	const values = (key) =>
		[...meta.matchAll(new RegExp(`@${key}\\s+(.+)`, "g"))].map((m) =>
			m[1].trim(),
		);
	const name = values("name")[0];
	scripts.push({
		code,
		weight: "1",
		scriptMetaStr: meta,
		scriptObject: {
			scriptId: `s${index}`,
			filename: file,
			name,
			revision: "r1",
			grant: values("grant"),
			metadata: { name: [name], grant: values("grant") },
			"run-at": values("run-at")[0] ?? "document-end",
			"inject-into": values("inject-into")[0] ?? "auto",
		},
	});
}
const source = `(() => {
 const finish = window.webkit.messageHandlers.result.postMessage.bind(window.webkit.messageHandlers.result);
 const scripts = ${JSON.stringify(scripts)};
 const handlers = new Set(), storageHandlers = new Set(), errors = [], data = {};
 window.addEventListener('error',event=>errors.push('window.error: '+String(event.message)));
 window.addEventListener('unhandledrejection',event=>errors.push('rejection: '+String(event.reason?.stack ?? event.reason)));
 const oe = console.error, ow = console.warn;
 console.error=(...args)=>{errors.push(args.map(x=>String(x?.message ? x.message+' @ '+x.stack : x)).join(' '));oe(...args);};
 const warns=[];console.warn=(...args)=>{warns.push(args.map(String).join(' '));ow(...args);};
 const nativeAttach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(o){return nativeAttach.call(this,{...o,mode:'open'});}; // test-only: count closed roots
 window.browser = {
  i18n:{getMessage:()=>''},
  runtime:{id:'enhanced',onMessage:{addListener:fn=>handlers.add(fn),removeListener:fn=>handlers.delete(fn)},sendMessage:async message=>{
   if(message.name==='REQ_USERSCRIPTS')return {files:{js:scripts,css:[],menu:[]},scriptHandler:'Userscripts Enhanced',scriptHandlerVersion:'0.1.0'};
   if(message.name==='UE_MENU_CHANGED') return {ok:true};
   if(message.name==='UE_PAGE_SETTINGS') return {};
   throw Error('Unexpected message '+message.name);
  }},
  storage:{local:{get:async(k)=>structuredClone(data),set:async items=>{
   const changed={};for(const [key,value]of Object.entries(items)){changed[key]={oldValue:data[key],newValue:structuredClone(value)};data[key]=structuredClone(value);}
   for(const fn of storageHandlers)fn(changed,'local');
  }},onChanged:{addListener:fn=>storageHandlers.add(fn),removeListener:fn=>storageHandlers.delete(fn)}}
 };
 ${await buildEngine()}
 const message = async value => {for(const fn of handlers){const result=fn(value,{id:'enhanced'});if(result!==undefined)return await result;}};
 const attackOut=()=>document.body.dataset.attack;const count=()=>{let n=0;const walk=r=>{for(const e of r.querySelectorAll('*')){n++;if(e.shadowRoot)walk(e.shadowRoot);}};walk(document);return n;};
 setTimeout(async()=>{
  try{
   const before=count();
   const html0=document.body.innerHTML.length;
   const el=document.elementFromPoint(100,100)??document.body;
   el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:100,clientY:100}));
   el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,composed:true,clientX:100,clientY:100,isPrimary:true,pointerType:'mouse',button:0}));
   el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:100,clientY:100}));
   await new Promise(r=>setTimeout(r,150));
   const afterClick=count();
   for (const t of [window, document, document.body]) {}
   document.body.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'\`',code:'Backquote'}));
   await new Promise(r=>setTimeout(r,300));
   const afterKey=count();
   const snapshot=await message({name:'UE_MENU_SNAPSHOT'});
   const runs={};
   for(const s of snapshot.scripts)for(const c of s.commands){if(!/^(显示|打开)/.test(c.title))continue;const b=count();const r=await message({name:'UE_MENU_EXECUTE',documentId:snapshot.documentId,scriptId:s.scriptId,commandId:c.commandId});await new Promise(r=>setTimeout(r,200));runs[c.title]={result:r,added:count()-b};}
   finish({passed:true,attack:attackOut()?JSON.parse(attackOut()):null,before,afterClick,afterKey,html0,htmlAfter:document.body.innerHTML.length,ds:{...document.body.dataset},
    runs,menus:snapshot.scripts.map(s=>({scriptId:s.scriptId,commands:s.commands.map(c=>c.title),panel:!!s.panel})),
    errors,warns:warns.slice(0,20)});
  }catch(e){finish({passed:false,error:String(e.stack??e),errors});}
 },1500);
 setTimeout(()=>finish({passed:false,error:'timeout',errors}),8000);
})();`;
await mkdir("tests/local", { recursive: true });
await writeFile("tests/local/user-scripts-webkit.js", source);
const compile = spawnSync(
	"swiftc",
	["tests/sandbox-webkit.swift", "-o", "tests/local/sandbox-webkit"],
	{ encoding: "utf8" },
);
if (compile.status !== 0) throw new Error(compile.stderr);
const run = spawnSync(
	"tests/local/sandbox-webkit",
	["tests/local/user-scripts-webkit.js"],
	{ encoding: "utf8", timeout: 25000 },
);
console.log(
	scripts
		.map((s) => `${s.scriptObject.scriptId}: ${s.scriptObject.name}`)
		.join("\n"),
);
process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr.slice(0, 4000));
