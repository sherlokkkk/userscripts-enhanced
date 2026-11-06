import { script } from "./engine-harness.js";

export const privateKey = "UE_VALUE:another-script:private";
export const initialValues = {
	[privateKey]: { v: 1, data: "synthetic-other-script-secret", writer: "test" },
	"UE_VALUE:attacker:own": {
		v: 1,
		data: { allowed: [1, true] },
		writer: "test",
	},
};

// Same attack as the original gate, plus alternate realm/constructor/descriptor
// paths. Completion and positive controls are mandatory: startup failure cannot
// accidentally turn a failed security check green.
export const attackSource = `
const results = [];
const probe = async (name, fn) => {
  try {
    const value = await fn();
    results.push({name, blocked: value !== 'synthetic-other-script-secret'});
  } catch { results.push({name, blocked:true}); }
};
const read = async root => (await root.browser.storage.local.get(null))[${JSON.stringify(privateKey)}]?.data;
await probe('ambient browser.storage', async () => (await browser.storage.local.get(null))[${JSON.stringify(privateKey)}]?.data);
await probe('globalThis', () => read(globalThis));
await probe('window', () => read(window));
await probe('Function constructor', () => read(Function('return this')()));
await probe('GM function constructor', () => read(GM_getValue.constructor('return this')()));
await probe('async constructor', async () => read(await (async()=>{}).constructor('return this')()));
await probe('DOM constructor', () => read(document.createElement.constructor('return this')()));
await probe('DOM defaultView', () => read(document.body.ownerDocument.defaultView));
await probe('descriptor', async () => {
  const api = Object.getOwnPropertyDescriptor(window, 'browser');
  const root = api?.value ?? api?.get?.call(window);
  return (await root.storage.local.get(null))[${JSON.stringify(privateKey)}]?.data;
});
await probe('foreign frame', async () => {
  const frame=document.createElement('iframe'); document.body.append(frame);
  try {return await read(frame.contentWindow);} finally {frame.remove();}
});
await probe('event view', () => read(new MouseEvent('click',{view:window}).view));
await probe('window.top', () => read(window.top));
await probe('bare top', () => read(top));
await probe('realm top', () => read(Function('return top')()));
await probe('top descriptor', () => read(Object.getOwnPropertyDescriptor(Function('return this')(), 'top').get.call(Function('return this')())));
await probe('parent', () => read(window.parent));
await probe('bare top', () => read(top));
await probe('realm Function', () => read(Function('return top')()));
await probe('Function this', () => read(Function('return this')().top));
await probe('indirect eval', () => read((0, eval)('top')));
await probe('function constructor', () => read((function () {}).constructor('return top')()));
await probe('async constructor', async () => read(await Object.getPrototypeOf(async function () {}).constructor('return top')()));
await probe('generator constructor', () => read(Object.getPrototypeOf(function* () {}).constructor('yield top')().next().value));
await probe('host constructor', () => read(document.createElement.constructor('return top')()));
await probe('sloppy this', () => read(Reflect.apply(function () { return this; }, undefined, []).top));
await probe('defaultView top', () => read(document.defaultView.top));
await probe('top descriptor getter', () => { const d = Object.getOwnPropertyDescriptor(window, 'top'); return read(d.get ? d.get.call(undefined) : d.value); });
await probe('globalThis descriptor', () => read(Object.getOwnPropertyDescriptor(window, 'globalThis').value.top));
await probe('string timer', () => new Promise((resolve) => {
  setTimeout("document.documentElement.dataset.ueTimer = typeof browser === 'object' && browser && browser.storage ? 'leak' : 'safe'", 0);
  setTimeout(() => resolve(document.documentElement.dataset.ueTimer === 'leak' ? 'synthetic-other-script-secret' : 'blocked'), 30);
}));
await probe('dynamic import', async () => read((await import('data:text/javascript,export default top')).default));
const own = GM_getValue('own');
await GM.setValue('nested', {array:[1,{ok:true}]});
const stored = GM_getValue('nested');
const el = document.createElement('strong'); el.id='isolation-dom'; el.textContent='DOM works'; document.body.append(el);
GM_registerMenuCommand('Isolated callback', () => {
  el.dataset.clicked='yes';
});
UE.registerPanel({version:1,title:'Isolated panel',controls:[
 {id:'enabled',type:'toggle',label:'Enabled',value:false,onChange(value){el.dataset.enabled=String(value);}},
 {id:'choice',type:'select',label:'Choice',value:'a',options:[{value:'a',label:'A'}],onChange(){}}
]});
globalThis.privateMarker = 'attacker-only';
Object.prototype.uePollution = 'attacker-only';
const report = {completed:true,results,own,stored,dom:el.textContent};
const output=document.createElement('pre'); output.id='isolation-result';output.textContent=JSON.stringify(report);document.body.append(output);
`;

// Every probe must report; the audits require exactly this many results.
export const probeCount = attackSource.match(/await probe\(/g).length;

export function isolationScripts() {
	return [
		script(
			[
				"GM_getValue",
				"GM.setValue",
				"GM_registerMenuCommand",
				"UE.registerPanel",
			],
			attackSource,
			"attacker",
		),
	];
}
