// Safari injects all_frames content scripts into every frame, including the
// hidden userscript-realm iframes (they carry the page URL after
// near-membrane's document.open). The entry must recognise those frames and
// do nothing there. Runs the production engine in a real WKWebView with
// injection into all frames (UE_ALL_FRAMES) and Safari-like `browser` objects.
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { buildEngine, script } from "./helpers/engine-harness.js";

const engine = await buildEngine();
const scripts = [
	script(
		["GM_registerMenuCommand", "GM_getValue"],
		`document.body.dataset.ran = String(Number(document.body.dataset.ran || 0) + 1); GM_registerMenuCommand("Ready", () => {});`,
	),
];
const fakeBrowser = (withScripts) => `{
	runtime: { id: "enhanced", onMessage: { addListener() {}, removeListener() {} },
		sendMessage: async (m) => m.name === "REQ_USERSCRIPTS"
			? { files: { js: ${withScripts ? "scripts" : "[]"}, css: [], menu: [] }, scriptHandler: "Userscripts Enhanced", scriptHandlerVersion: "0.1.0" }
			: { ok: true } },
	storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {}, removeListener() {} } },
}`;
const source = `(() => {
 const scripts = ${JSON.stringify(scripts)};
 const text = (x) => String(x?.message ? x.message + " @ " + x.stack : x);
 if (window !== window.top) {
  const sink = (window.top.__ueFrames ??= []);
  const entry = { realm: false, entered: false, errors: [] };
  sink.push(entry);
  console.error = (...a) => entry.errors.push(a.map(text).join(" "));
  window.addEventListener("error", (e) => entry.errors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => entry.errors.push(text(e.reason)));
  // Safari defines its namespace before content scripts run.
  if (!("browser" in window)) window.browser = ${fakeBrowser(true)};
  try { ${engine} } catch (e) { entry.errors.push(text(e)); }
  setTimeout(() => {
   entry.realm = window[Symbol.for("userscripts-enhanced.realm")] === true;
   entry.entered = window.CS_ENTRY_USERSCRIPTS === 1;
  }, 200);
  return;
 }
 const finish = window.webkit.messageHandlers.result.postMessage.bind(window.webkit.messageHandlers.result);
 const errors = [];
 const oe = console.error; console.error = (...a) => { errors.push(a.map(text).join(" ")); oe(...a); };
 const handlers = new Set();
 window.browser = ${fakeBrowser(true)};
 window.browser.runtime.onMessage = { addListener: (fn) => handlers.add(fn), removeListener: (fn) => handlers.delete(fn) };
 ${engine}
 setTimeout(async () => {
  let snapshot;
  for (const fn of handlers) { const r = fn({ name: "UE_MENU_SNAPSHOT" }, { id: "enhanced" }); if (r !== undefined) { snapshot = await r; break; } }
  const frames = window.__ueFrames ?? [];
  const realmFrames = frames.filter((f) => f.realm);
  const checks = {
   realmFramesInjected: realmFrames.length > 0,
   engineNeverEnteredRealm: realmFrames.every((f) => !f.entered),
   noFrameErrors: frames.every((f) => f.errors.length === 0),
   topScriptRanOnce: document.body.dataset.ran === "1",
   topMenuRegistered: snapshot?.scripts?.[0]?.commands?.[0]?.title === "Ready",
   noTopErrors: errors.length === 0,
  };
  finish({ passed: Object.values(checks).every(Boolean), checks, frames, errors });
 }, 1200);
})();`;
await mkdir("tests/local", { recursive: true });
await writeFile("tests/local/realm-frames-webkit.js", source);
const compile = spawnSync(
	"swiftc",
	["tests/sandbox-webkit.swift", "-o", "tests/local/sandbox-webkit"],
	{ encoding: "utf8" },
);
if (compile.status !== 0) throw new Error(compile.stderr);
const run = spawnSync(
	"tests/local/sandbox-webkit",
	["tests/local/realm-frames-webkit.js"],
	{
		encoding: "utf8",
		timeout: 25000,
		env: { ...process.env, UE_ALL_FRAMES: "1" },
	},
);
process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr.slice(0, 2000));
let result;
try {
	result = JSON.parse(run.stdout);
} catch {
	result = { passed: false };
}
if (run.status !== 0 || !result.passed) process.exitCode = 1;
