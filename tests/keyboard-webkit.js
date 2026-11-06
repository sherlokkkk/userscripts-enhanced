// Keyboard shortcut control in a real WKWebView isolated world, through the
// unmodified production engine: detection, run-time observation, disabling
// and remapping (applied live from storage), for document and window
// listeners.
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { buildEngine, script } from "./helpers/engine-harness.js";

const probe = script(
	["GM_getValue"],
	`
	const D = document.body.dataset;
	document.addEventListener("keydown", (e) => {
		if (e.key === "q" && !e.altKey) { e.preventDefault(); D.q = String(Number(D.q || 0) + 1); }
	});
	window.addEventListener("keydown", (e) => {
		if (e.altKey && e.shiftKey && e.code === "KeyM") { e.preventDefault(); D.m = String(Number(D.m || 0) + 1); D.mKey = e.key; }
	}, true);
	const handler = { handleEvent(e) { if (e.code === "KeyX") { e.stopPropagation(); D.x = String(Number(D.x || 0) + 1); } } };
	document.addEventListener("keyup", handler);
	const hidden = ["K", "e", "y", "J"].join("");
	document.addEventListener("keydown", (e) => { if (e.code === hidden && e.ctrlKey) { e.preventDefault(); D.j = "1"; } });
	const removed = (e) => { D.removed = "called"; };
	document.addEventListener("keydown", removed);
	document.removeEventListener("keydown", removed);
`,
	"keys",
);
const source = `(() => {
 const finish = window.webkit.messageHandlers.result.postMessage.bind(window.webkit.messageHandlers.result);
 const scripts = ${JSON.stringify([probe])};
 const handlers = new Set(), storageHandlers = new Set(), errors = [], data = {};
 const oe = console.error; console.error = (...a) => { errors.push(a.map((x) => String(x?.message ?? x)).join(" ")); oe(...a); };
 window.browser = {
  i18n: { getMessage: () => "" },
  runtime: { id: "enhanced", onMessage: { addListener: (fn) => handlers.add(fn), removeListener: (fn) => handlers.delete(fn) },
   sendMessage: async (m) => { if (m.name === "REQ_USERSCRIPTS") return { files: { js: scripts, css: [], menu: [] }, scriptHandler: "Userscripts Enhanced", scriptHandlerVersion: "0.1.0" }; if (m.name === "UE_MENU_CHANGED") return { ok: true }; throw Error("Unexpected " + m.name); } },
  storage: { local: { get: async () => structuredClone(data), set: async (items) => { const changed = {}; for (const [k, v] of Object.entries(items)) { changed[k] = { oldValue: data[k], newValue: structuredClone(v) }; data[k] = structuredClone(v); } for (const fn of storageHandlers) fn(changed, "local"); } },
   onChanged: { addListener: (fn) => storageHandlers.add(fn), removeListener: (fn) => storageHandlers.delete(fn) } },
 };
 ${await buildEngine()}
 const message = async (v) => { for (const fn of handlers) { const r = fn(v, { id: "enhanced" }); if (r !== undefined) return await r; } };
 const key = (type, init) => document.body.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
 const press = (init) => { key("keydown", init); key("keyup", init); };
 const wait = (ms) => new Promise((r) => setTimeout(r, ms));
 const D = () => ({ ...document.body.dataset });
 setTimeout(async () => {
  try {
   const report = {};
   const shortcuts = async () => (await message({ name: "UE_MENU_SNAPSHOT" })).scripts[0]?.shortcuts;
   report.detected = (await shortcuts())?.list.map((s) => s.id + ":" + s.source);
   press({ key: "q", code: "KeyQ" });
   press({ key: "M", code: "KeyM", altKey: true, shiftKey: true });
   press({ key: "x", code: "KeyX" });
   press({ key: "j", code: "KeyJ", ctrlKey: true });
   await wait(700);
   report.before = D();
   report.afterUse = (await shortcuts())?.list.map((s) => s.id + ":" + s.source);
   const list = (await shortcuts()).list;
   const byId = (id) => list.find((s) => s.id === id).shortcut;
   await browser.storage.local.set({ UE_SCRIPT_PREFS: { keys: { shortcuts: {
     "key:q": { original: byId("key:q"), disabled: true },
     "Alt+Shift+KeyM": { original: byId("Alt+Shift+KeyM"), to: { mods: { ctrl: false, alt: true, shift: false, meta: false }, code: "KeyB", key: null } },
   } } } });
   press({ key: "q", code: "KeyQ" });
   press({ key: "M", code: "KeyM", altKey: true, shiftKey: true });
   press({ key: "∫", code: "KeyB", altKey: true });
   await wait(50);
   report.after = D();
   report.snapshot = (await shortcuts())?.list.map((s) => s.id + (s.disabled ? " disabled" : "") + (s.to ? " -> " + JSON.stringify(s.to) : ""));
   report.seenStored = data.UE_SHORTCUTS_SEEN;
   const has = (list, item) => Array.isArray(list) && list.includes(item);
   const checks = {
    detected: has(report.detected, "key:q:detected") && has(report.detected, "Alt+Shift+KeyM:detected") && has(report.detected, "KeyX:detected") && !report.detected.some((i) => i.includes("KeyJ")),
    observed: has(report.afterUse, "Ctrl+KeyJ:observed") && JSON.stringify(report.seenStored?.keys ?? []).includes("KeyJ"),
    handledBefore: report.before.q === "1" && report.before.m === "1" && report.before.x === "1" && report.before.j === "1",
    disabled: report.after.q === "1",
    remapped: report.after.m === "2" && report.after.mKey === "M",
    removedListener: report.after.removed === undefined,
    noErrors: errors.length === 0,
   };
   finish({ passed: Object.values(checks).every(Boolean), checks, report, errors });
  } catch (e) { finish({ passed: false, error: String(e.stack ?? e), errors }); }
 }, 800);
 setTimeout(() => finish({ passed: false, error: "timeout", errors }), 8000);
})();`;
await mkdir("tests/local", { recursive: true });
await writeFile("tests/local/keyboard-webkit.js", source);
const compile = spawnSync(
	"swiftc",
	["tests/sandbox-webkit.swift", "-o", "tests/local/sandbox-webkit"],
	{ encoding: "utf8" },
);
if (compile.status !== 0) throw new Error(compile.stderr);
const run = spawnSync(
	"tests/local/sandbox-webkit",
	["tests/local/keyboard-webkit.js"],
	{ encoding: "utf8", timeout: 25000 },
);
process.stdout.write(run.stdout);
let result;
try {
	result = JSON.parse(run.stdout);
} catch {
	result = { passed: false };
}
if (run.status !== 0 || !result.passed) process.exitCode = 1;
if (run.stderr) process.stderr.write(run.stderr.slice(0, 2000));
