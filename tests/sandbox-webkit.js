import { format } from "prettier";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { buildEngine } from "./helpers/engine-harness.js";
import {
	initialValues,
	isolationScripts,
	probeCount,
} from "./helpers/isolation-scenarios.js";
const source = `(() => {
 const finish = window.webkit.messageHandlers.result.postMessage.bind(window.webkit.messageHandlers.result);
 const scripts = ${JSON.stringify(isolationScripts())};
 const data = ${JSON.stringify(initialValues)};
 const handlers = new Set(), storageHandlers = new Set(), errors = [];
 window.addEventListener('error',event=>errors.push(String(event.message)));
 const originalConsole = console.error;
 console.error=(...args)=>{errors.push(args.map(x=>String(x?.message ?? x)).join(' '));originalConsole(...args);};
 window.browser = {
  runtime:{id:'enhanced',onMessage:{addListener:fn=>handlers.add(fn),removeListener:fn=>handlers.delete(fn)},sendMessage:async message=>{
   if(message.name==='REQ_USERSCRIPTS')return {files:{js:scripts,css:[],menu:[]},scriptHandler:'Userscripts Enhanced',scriptHandlerVersion:'0.1.0'};
   if(message.name==='UE_MENU_CHANGED') return {ok:true};throw Error('Unexpected message '+message.name);
  }},
  storage:{local:{get:async()=>structuredClone(data),set:async items=>{
   const changed={};for(const [key,value]of Object.entries(items)){changed[key]={oldValue:data[key],newValue:structuredClone(value)};data[key]=structuredClone(value);}
   for(const fn of storageHandlers)fn(changed,'local');
  }},onChanged:{addListener:fn=>storageHandlers.add(fn),removeListener:fn=>storageHandlers.delete(fn)}}
 };
 ${await buildEngine()}
 const message = async value => {for(const fn of handlers){const result=fn(value,{id:'enhanced'});if(result!==undefined)return await result;}};
 const timer=setInterval(async()=>{
  const output=document.getElementById('isolation-result');if(!output)return;
  clearInterval(timer);
  try{
   const evidence=JSON.parse(output.textContent), snapshot=await message({name:'UE_MENU_SNAPSHOT'});
   const state=snapshot.scripts[0];
   const send=(commandId,value)=>message({name:'UE_MENU_EXECUTE',documentId:snapshot.documentId,scriptId:'attacker',commandId,value});
   const menu=await send(state.commands.find(c=>c.title==='Isolated callback').commandId);
   const panel=await send(state.panel.controls[0].commandId,true);
   const el=document.getElementById('isolation-dom');
   const callbacks=menu.ok&&panel.ok&&el.dataset.clicked==='yes'&&el.dataset.enabled==='true';
   const passed=evidence.completed&&evidence.results.length===${probeCount}&&evidence.results.every(x=>x.blocked)&&callbacks&&
    JSON.stringify(evidence.own)===JSON.stringify({allowed:[1,true]})&&JSON.stringify(evidence.stored)===JSON.stringify({array:[1,{ok:true}]})&&
    window.privateMarker===undefined&&Object.prototype.uePollution===undefined;
   finish({passed,evidence,callbacks,errors,engine:'WKWebView isolated WKContentWorld',safariVerified:false,method:'Unmodified compiled production entry and DOM membrane. Synthetic WebExtension APIs; real WebKit realms, DOM, menu and panel callbacks.'});
  }catch(e){finish({passed:false,error:String(e.message),errors});}
 },25);
 setTimeout(()=>finish({passed:false,error:'Script did not complete',errors}),5000);
})();`;
await mkdir("tests/local", { recursive: true });
await writeFile("tests/local/sandbox-webkit.js", source);
const compile = spawnSync(
	"swiftc",
	["tests/sandbox-webkit.swift", "-o", "tests/local/sandbox-webkit"],
	{ encoding: "utf8" },
);
if (compile.status !== 0) throw new Error(compile.stderr);
const run = spawnSync(
	"tests/local/sandbox-webkit",
	["tests/local/sandbox-webkit.js"],
	{ encoding: "utf8", timeout: 25000 },
);
process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
let report;
try {
	report = JSON.parse(run.stdout);
} catch {
	report = {
		passed: false,
		error: run.error?.message ?? "No valid WebKit report",
	};
}
report.checkedAt = new Date().toISOString();
await writeFile(
	"docs/reports/sandbox-webkit.json",
	await format(JSON.stringify(report), { parser: "json", useTabs: true }),
);
if (run.status !== 0 || !report.passed) process.exitCode = 1;
