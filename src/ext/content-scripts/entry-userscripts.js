import { createScriptSandbox } from "./script-sandbox.js";
import { createTabAPI } from "./tab-runtime.js";
import { createPageAPI } from "./page-api.js";
import { createXhrAPI } from "./network-runtime.js";
import { metadataWarnings } from "../shared/metadata.js";
import { validGrants } from "../shared/utils.js";
import { createValueStore } from "./value-store.js";
import { MenuRuntime } from "./menu-runtime.js";
import { colors } from "@shared/colors.js";

// code received from background page will be stored in this variable
// code referenced again when strict CSPs block initial injection attempt
let data;
let menuRuntime;
const valueStores = [];
const tabContexts = [];
const sandboxContexts = [];
const startedScripts = new Set();
let bodyReady;
let bodyObserver;
// determines whether strict csp injection has already run (JS only)
let cspFallbackAttempted = false;

const SCRIPT_PREFS_KEY = "UE_SCRIPT_PREFS";
let preferences = {};
function scriptPreferences(scriptId) {
	const own = Object.hasOwn(preferences, scriptId) ? preferences[scriptId] : {};
	return Object.freeze({ autoPopup: own?.autoPopup !== false });
}
const pageMenuGrants = new Set([
	"GM_registerMenuCommand",
	"GM_unregisterMenuCommand",
	"GM.registerMenuCommand",
	"GM.unregisterMenuCommand",
]);

// Page-world scripts cannot receive functions from this world. Their menu
// commands travel as JSON over per-injection random event names; clicks travel
// back the same way. Only titles/options and a key cross; no capability does.
function pageMenuBridge(userscript) {
	const grants = userscript.pageMenuGrants ?? [];
	if (!grants.length || !userscript.menuAPI) return "";
	const channel = crypto.randomUUID();
	const requestName = `ue-menu-request-${channel}`;
	const runName = `ue-menu-run-${channel}`;
	const commands = new Map();
	const api = userscript.menuAPI;
	const run = (key) =>
		window.dispatchEvent(
			new CustomEvent(runName, { detail: JSON.stringify({ key }) }),
		);
	const onRequest = (event) => {
		let request;
		try {
			if (typeof event.detail !== "string" || event.detail.length > 4096)
				return;
			request = JSON.parse(event.detail);
		} catch {
			return;
		}
		const key = request?.key;
		if (typeof key !== "string" || !key || key.length > 128) return;
		try {
			if (request.op === "register") {
				const options = request.options ?? {};
				const commandId = api.GM_registerMenuCommand(
					String(request.title),
					() => run(key),
					{
						id: commands.get(key),
						accessKey:
							typeof options.accessKey === "string" ? options.accessKey : "",
						autoClose: options.autoClose !== false,
						title: typeof options.title === "string" ? options.title : "",
					},
				);
				commands.set(key, commandId);
			} else if (request.op === "unregister" && commands.has(key)) {
				api.GM_unregisterMenuCommand(commands.get(key));
				commands.delete(key);
			}
		} catch (error) {
			console.error(`${userscript.scriptObject.filename}: menu command`, error);
		}
	};
	window.addEventListener(requestName, onRequest);
	window.addEventListener("pagehide", (event) => {
		if (!event.persisted) window.removeEventListener(requestName, onRequest);
	});
	const want = (grant) => grants.includes(grant);
	return `const __ueMenu = (() => {
	const dispatch = EventTarget.prototype.dispatchEvent, listen = EventTarget.prototype.addEventListener;
	const Custom = CustomEvent, stringify = JSON.stringify, parse = JSON.parse, win = window;
	const callbacks = new Map(); let sequence = 0;
	const send = (data) => dispatch.call(win, new Custom(${JSON.stringify(requestName)}, { detail: stringify(data) }));
	listen.call(win, ${JSON.stringify(runName)}, (event) => {
		let key; try { key = parse(event.detail).key; } catch { return; }
		const callback = callbacks.get(key);
		if (callback) try { callback(new MouseEvent("click")); } catch (error) { console.error(error); }
	});
	const register = (title, callback, options) => {
		if (typeof callback !== "function") throw new TypeError("Menu callback must be a function");
		if (typeof options === "string") options = { accessKey: options };
		if (!options || typeof options !== "object") options = {};
		const key = options.id !== undefined ? String(options.id) : "ue" + ++sequence;
		callbacks.set(key, callback);
		send({ op: "register", key, title: String(title), options: { accessKey: options.accessKey, autoClose: options.autoClose, title: options.title } });
		return key;
	};
	const unregister = (id) => { callbacks.delete(String(id)); send({ op: "unregister", key: String(id) }); };
	return { register, unregister };
})();
${want("GM_registerMenuCommand") ? "const GM_registerMenuCommand = __ueMenu.register;" : ""}
${want("GM_unregisterMenuCommand") ? "const GM_unregisterMenuCommand = __ueMenu.unregister;" : ""}
${want("GM.registerMenuCommand") ? "GM.registerMenuCommand = async (...args) => __ueMenu.register(...args);" : ""}
${want("GM.unregisterMenuCommand") ? "GM.unregisterMenuCommand = async (id) => __ueMenu.unregister(id);" : ""}
`;
}

// label used to distinguish frames in console
const label = randomLabel();
const usTag = window.self === window.top ? "" : `(${label})`;

function randomLabel() {
	const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
	const r = Math.random();
	return a[Math.floor(r * a.length)] + r.toString().slice(5, 6);
}

function triageJS(userscript) {
	const runAt = userscript.scriptObject["run-at"];
	if (runAt === "document-body") {
		if (!bodyReady)
			bodyReady = new Promise((resolve) => {
				if (document.body) return resolve();
				bodyObserver = new MutationObserver(() => {
					if (!document.body) return;
					bodyObserver.disconnect();
					resolve();
				});
				bodyObserver.observe(document, { childList: true, subtree: true });
			});
		bodyReady.then(() => injectJS(userscript));
	} else if (runAt === "document-start") {
		injectJS(userscript);
	} else if (runAt === "document-end") {
		if (document.readyState !== "loading") {
			injectJS(userscript);
		} else {
			document.addEventListener(
				"DOMContentLoaded",
				() => injectJS(userscript),
				{ once: true },
			);
		}
	} else if (runAt === "document-idle") {
		if (document.readyState === "complete") {
			injectJS(userscript);
		} else {
			const handle = () => {
				if (document.readyState === "complete") {
					injectJS(userscript);
					document.removeEventListener("readystatechange", handle);
				}
			};
			document.addEventListener("readystatechange", handle);
		}
	}
}

function injectJS(userscript) {
	const scriptId = userscript.scriptObject.scriptId;
	const repeatable = userscript.scriptObject["run-at"] === "context-menu";
	if (!repeatable && startedScripts.has(scriptId)) return;
	const filename = userscript.scriptObject.filename;
	const name = userscript.scriptObject.name;
	const code = `\
(async () => {
	try {
// ===UserScript===start===
${userscript.code}
// ===UserScript====end====
	} catch (error) {
		console.error(${JSON.stringify(filename)}, error);
	}
})(); //# sourceURL=${filename.replace(/[\s"']/g, "-") + usTag}`;
	let injectInto = userscript.scriptObject["inject-into"];
	// change scope to content since strict CSP event detected
	if (injectInto === "auto" && (userscript.fallback || cspFallbackAttempted)) {
		injectInto = "content";
		console.warn(`Attempting fallback injection for ${name}`);
	}
	const world = injectInto === "content" ? "content" : "page";
	if (window.self === window.top) {
		console.info(`Injecting: ${name} %c(js/${world})`, colors.yellow);
	} else {
		console.info(
			`Injecting: ${name} %c(js/${world})%c - %cframe(${label})(${window.location})`,
			colors.yellow,
			colors.inherit,
			colors.blue,
		);
	}
	if (world === "page") {
		const div = document.createElement("div");
		div.style.display = "none";
		const shadowRoot = div.attachShadow({ mode: "closed" });
		const tag = document.createElement("script");
		const signal = `ue-start-${crypto.randomUUID()}`;
		const didStart = () => startedScripts.add(scriptId);
		window.addEventListener(signal, didStart, { once: true });
		const info = JSON.stringify(userscript.apis.GM.info);
		const menu = pageMenuBridge(userscript);
		tag.textContent = `window.dispatchEvent(new Event(${JSON.stringify(signal)}));\n((info) => { const GM_info = info; const GM = { info };\n${menu}${code}\n})(${info});`;
		shadowRoot.append(tag);
		(document.body ?? document.head ?? document.documentElement).append(div);
		window.removeEventListener(signal, didStart);
		div.remove();
	} else {
		if (!repeatable) startedScripts.add(scriptId);
		try {
			// Never execute untrusted code in this privileged content-script realm.
			const existing = sandboxContexts.find(
				(context) => context.filename === filename,
			);
			const sandbox = existing?.sandbox ?? createScriptSandbox(userscript.apis);
			if (!existing) sandboxContexts.push({ filename, sandbox });
			sandbox.evaluate(code);
		} catch (error) {
			console.error(`${filename}`, error);
		}
		return;
	}
}

function injectCSS(name, code) {
	if (window.self === window.top) {
		console.info(`Injecting ${name} %c(css)`, colors.green);
	} else {
		console.info(
			`Injecting ${name} %c(css)%c - %cframe(${label})(${window.location})`,
			colors.green,
			colors.inherit,
			colors.blue,
		);
	}
	// Safari lacks full support for tabs.insertCSS
	// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/insertCSS
	// specifically frameId and cssOrigin
	// if support for those details keys arrives, the method below can be used
	// NOTE: manifest V3 does support frameId, but not origin
	// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/insertCSS

	// write the css code to head of the document
	const tag = document.createElement("style");
	tag.textContent = code;
	document.head.appendChild(tag);
}

function cspFallback(e) {
	// if a security policy violation event has occurred
	// and the directive is script-src or script-src-elem
	// it's fair to assume that there is a strict CSP for javascript
	// and that injection was blocked for all userscripts
	// when any script-src violation is detected, re-attempt injection
	if (
		e.effectiveDirective === "script-src" ||
		e.effectiveDirective === "script-src-elem"
	) {
		// get all "auto" code
		// since other code can trigger a security policy violation event
		// make sure data var is not undefined before attempting fallback
		if (!data || cspFallbackAttempted) return;
		// update global that tracks security policy violations
		cspFallbackAttempted = true;
		// for all userscripts with @inject-into: auto, attempt re-injection
		for (let i = 0; i < data.files.js.length; i++) {
			const userscript = data.files.js[i];
			if (userscript.scriptObject["inject-into"] !== "auto") continue;
			userscript.fallback = 1;
			triageJS(userscript);
		}
	}
}

async function injection() {
	const response = await browser.runtime.sendMessage({
		name: "REQ_USERSCRIPTS",
	});
	if (import.meta.env.MODE === "development") {
		console.debug("REQ_USERSCRIPTS", response);
	}
	// cancel injection if errors detected
	if (!response || response.error) {
		console.error(response?.error || "REQ_USERSCRIPTS returned undefined");
		return;
	}
	// save response locally in case CSP events occur
	data = response;
	try {
		const stored = await browser.storage.local.get(SCRIPT_PREFS_KEY);
		const value = stored?.[SCRIPT_PREFS_KEY];
		if (value && typeof value === "object") preferences = value;
	} catch (error) {
		console.warn("Userscripts Enhanced: script preferences unavailable", error);
	}
	// combine regular and context-menu scripts
	const scripts = [...data.files.js, ...data.files.menu];
	// loop through each userscript and prepare for processing
	for (let i = 0; i < scripts.length; i++) {
		const userscript = scripts[i];
		const filename = userscript.scriptObject.filename;
		const grants = userscript.scriptObject.grant;
		const injectInto = userscript.scriptObject["inject-into"];
		const menuAPI = menuRuntime.forScript(userscript.scriptObject);
		const identity = {
			scriptId: userscript.scriptObject.scriptId,
			filename,
			revision: userscript.scriptObject.revision,
		};
		let resources = Object.create(null);
		if (
			grants.some((grant) =>
				[
					"GM_getResourceText",
					"GM_getResourceURL",
					"GM.getResourceText",
					"GM.getResourceUrl",
					"GM.getResourceURL",
				].includes(grant),
			)
		) {
			const response = await browser.runtime.sendMessage({
				name: "UE_RESOURCE_BUNDLE",
				identity,
			});
			if (!response || response.error) {
				console.error(
					`${filename}: resource preparation failed`,
					response?.error,
				);
				continue;
			}
			resources = Object.assign(Object.create(null), response.resources);
		}
		const resource = (key, field) => {
			if (typeof key !== "string" || !Object.hasOwn(resources, key))
				throw new Error(`Unknown @resource: ${key}`);
			if (resources[key][field] === undefined)
				throw new Error(`@resource ${key} is not UTF-8 text`);
			return resources[key][field];
		};
		let tabAPI;
		if (
			grants.some((grant) =>
				["openInTab", "getTab", "saveTab", "getTabs"].includes(
					grant.replace(/^GM[._]/, ""),
				),
			)
		) {
			const context = createTabAPI({
				browser,
				identity,
				baseURL: location.href,
				reportError: (error) =>
					console.error(`${filename}: tab API failed`, error),
			});
			context.filename = filename;
			tabContexts.push(context);
			tabAPI = context.api;
		}
		const clipboard = async (data, info = "text", callback) => {
			const type =
				typeof info === "object"
					? (info.mimetype ??
						(info.type === "html" ? "text/html" : "text/plain"))
					: ["html", "text/html"].includes(info)
						? "text/html"
						: "text/plain";
			const response = await browser.runtime.sendMessage({
				name: "UE_CLIPBOARD",
				identity,
				data,
				type,
			});
			if (!response?.ok)
				throw new Error(response?.error ?? "Clipboard request unavailable");
			callback?.();
		};
		const pageAPI = createPageAPI({
			document,
			name: userscript.scriptObject.name,
			console,
		});
		const xhrAPI = createXhrAPI({
			browser,
			identity: {
				scriptId: userscript.scriptObject.scriptId,
				filename,
				revision: userscript.scriptObject.revision,
			},
			baseURL: location.href,
		});
		for (const warning of metadataWarnings(
			userscript.scriptObject.metadata ?? {},
			validGrants,
		)) {
			console.warn(`${filename}: ${warning}`);
		}
		const storageNames = new Set([
			"getValue",
			"setValue",
			"deleteValue",
			"listValues",
			"addValueChangeListener",
			"removeValueChangeListener",
		]);
		let valueAPI;
		if (
			grants.some((grant) => storageNames.has(grant.replace(/^GM[._]/, "")))
		) {
			try {
				const store = await createValueStore({
					scriptId: userscript.scriptObject.scriptId,
					storage: browser.storage.local,
					changes: browser.storage.onChanged,
					reportError: (error) =>
						console.error(`${filename}: storage persistence failed`, error),
				});
				store.filename = filename;
				valueStores.push(store);
				valueAPI = store.api;
			} catch (error) {
				console.error(
					`${filename}: storage initialization failed; script not executed`,
					error,
				);
				continue;
			}
		}
		// create GM.info object, all userscripts get access to GM.info
		userscript.apis = { GM: {} };
		userscript.apis.GM.info = {
			script: userscript.scriptObject,
			scriptHandler: data.scriptHandler,
			scriptHandlerVersion: data.scriptHandlerVersion,
			scriptMetaStr: userscript.scriptMetaStr,
			version: data.scriptHandlerVersion,
			// Per-script user choices from the toolbar popup. Scripts that open
			// panels on their own should honour autoPopup === false.
			preferences: scriptPreferences(identity.scriptId),
		};
		userscript.menuAPI = menuAPI;
		// add GM_info
		userscript.apis.GM_info = userscript.apis.GM.info;
		// if @grant explicitly set to none, empty grants array
		if (grants.includes("none")) grants.length = 0;
		// @grant values exist for page scoped userscript
		if (grants.length && injectInto === "page") {
			// Only toolbar menu commands are bridged into the page world; they carry
			// titles and click notifications, never extension capabilities.
			const kept = grants.filter((grant) => pageMenuGrants.has(grant));
			const removed = grants.filter((grant) => !pageMenuGrants.has(grant));
			grants.length = 0;
			userscript.pageMenuGrants = kept;
			if (removed.length)
				console.warn(
					`${filename} @grant values removed due to @inject-into value: ${injectInto} (${removed}) - https://github.com/quoid/userscripts/issues/265#issuecomment-1213462394`,
				);
		}
		// @grant exist for auto scoped userscript
		if (grants.length && injectInto === "auto") {
			// change scope
			userscript.scriptObject["inject-into"] = "content";
			// log warning
			console.warn(
				`${filename} @inject-into value set to 'content' due to @grant values: ${grants} - https://github.com/quoid/userscripts/issues/265#issuecomment-1213462394`,
			);
		}
		// loop through each userscript @grant value, add methods as needed
		for (let j = 0; j < grants.length; j++) {
			const grant = grants[j];
			if (grant === "UE.registerPanel") {
				userscript.apis.UE = Object.freeze({
					version: 1,
					registerPanel: menuAPI.registerPanel,
				});
				continue;
			}
			if (["GM_getResourceText", "GM_getResourceURL"].includes(grant)) {
				userscript.apis[grant] = (key) =>
					resource(key, grant.endsWith("Text") ? "text" : "url");
				continue;
			}
			if (
				[
					"GM.getResourceText",
					"GM.getResourceUrl",
					"GM.getResourceURL",
				].includes(grant)
			) {
				userscript.apis.GM[grant.slice(3)] = async (key) =>
					resource(key, grant.endsWith("Text") ? "text" : "url");
				continue;
			}
			const tabMethod = grant.startsWith("GM.") ? grant.slice(3) : grant;
			if (tabAPI && Object.hasOwn(tabAPI, tabMethod)) {
				if (grant.startsWith("GM."))
					userscript.apis.GM[tabMethod] = tabAPI[tabMethod];
				else userscript.apis[tabMethod] = tabAPI[tabMethod];
				continue;
			}
			if (grant === "GM.setClipboard") {
				userscript.apis.GM.setClipboard = clipboard;
				continue;
			}
			if (grant === "GM_setClipboard") {
				userscript.apis.GM_setClipboard = (...args) => {
					clipboard(...args).catch((error) =>
						console.error(`${filename}: clipboard failed`, error),
					);
				};
				continue;
			}
			const pageMethod = grant.startsWith("GM.") ? grant.slice(3) : grant;
			if (Object.hasOwn(pageAPI, pageMethod)) {
				if (grant.startsWith("GM."))
					userscript.apis.GM[pageMethod] = pageAPI[pageMethod];
				else userscript.apis[pageMethod] = pageAPI[pageMethod];
				continue;
			}
			if (grant === "GM_xmlhttpRequest") {
				userscript.apis.GM_xmlhttpRequest = xhrAPI.GM_xmlhttpRequest;
				continue;
			}
			if (grant === "GM.xmlHttpRequest") {
				userscript.apis.GM.xmlHttpRequest = xhrAPI.xmlHttpRequest;
				continue;
			}
			const valueMethod = grant.startsWith("GM.") ? grant.slice(3) : grant;
			if (valueAPI && Object.hasOwn(valueAPI, valueMethod)) {
				if (grant.startsWith("GM."))
					userscript.apis.GM[valueMethod] = valueAPI[valueMethod];
				else userscript.apis[valueMethod] = valueAPI[valueMethod];
				continue;
			}
			if (
				["GM_registerMenuCommand", "GM_unregisterMenuCommand"].includes(grant)
			) {
				userscript.apis[grant] = menuAPI[grant];
				continue;
			}
			if (
				["GM.registerMenuCommand", "GM.unregisterMenuCommand"].includes(grant)
			) {
				userscript.apis.GM[grant.slice(3)] = menuAPI[grant.slice(3)];
				continue;
			}
		}

		// Revocation also guards APIs already captured by a running script.
		for (const [key, value] of Object.entries(userscript.apis)) {
			if (typeof value !== "function") continue;
			userscript.apis[key] = (...args) => {
				if (menuRuntime.isRevoked(userscript.scriptObject.scriptId))
					throw new Error("Script disabled; reload the page");
				return value(...args);
			};
		}
		for (const [key, value] of Object.entries(userscript.apis.GM)) {
			if (typeof value !== "function") continue;
			userscript.apis.GM[key] = async (...args) => {
				if (menuRuntime.isRevoked(userscript.scriptObject.scriptId))
					throw new Error("Script disabled; reload the page");
				return value(...args);
			};
		}
		// triage userjs item for injection
		triageJS(userscript);
	}
	// loop through each usercss and inject
	for (let i = 0; i < data.files.css.length; i++) {
		const userstyle = data.files.css[i];
		injectCSS(userstyle.name, userstyle.code);
	}
}

function listeners() {
	/** listen for CSP violations */
	document.addEventListener("securitypolicyviolation", cspFallback, {
		once: true,
	});
	/**
	 * listens for messages from background, popup, etc...
	 * @type {import("webextension-polyfill").Runtime.OnMessageListener}
	 */
	const handleMessage = (message) => {
		const name = message.name;
		if (name === "CONTEXT_RUN") {
			// from bg script when context-menu item is clicked
			// double check to ensure context-menu scripts only run in top windows
			if (window !== window.top) return;
			// loop through context-menu scripts saved to data object and find match
			// if no match found, nothing will execute and error will log
			const filename = message.menuItemId;
			for (let i = 0; i < data.files.menu.length; i++) {
				const item = data.files.menu[i];
				if (item.scriptObject.filename === filename) {
					console.info(`Injecting ${filename} %c(js)`, colors.yellow);
					injectJS(item);
					return;
				}
			}
			console.error(`Couldn't find ${filename} code!`);
		}
	};
	/** Dynamically remove listeners to avoid memory leaks */
	if (document.visibilityState === "visible") {
		browser.runtime.onMessage.addListener(handleMessage);
	}
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) {
			browser.runtime.onMessage.removeListener(handleMessage);
		} else {
			browser.runtime.onMessage.addListener(handleMessage);
		}
	});
}

async function initialize() {
	// avoid duplicate injection of content scripts
	if (window["CS_ENTRY_USERSCRIPTS"]) return;
	window["CS_ENTRY_USERSCRIPTS"] = 1;
	// check user settings
	const key = "US_GLOBAL_ACTIVE";
	const results = await browser.storage.local.get(key);
	if (results[key] === false) return console.info("Userscripts off");
	// A separate listener stays available in hidden/cross-origin frames.
	menuRuntime = new MenuRuntime({
		documentId: crypto.randomUUID(),
		notify: () => {
			browser.runtime
				.sendMessage({ name: "UE_MENU_CHANGED" })
				.catch((error) => {
					console.warn(
						"Userscripts Enhanced: menu notification unavailable",
						String(error),
					);
				});
		},
		createEvent: (data) =>
			data.type === "keydown"
				? new KeyboardEvent("keydown", data)
				: new MouseEvent("click", data),
	});
	const menuListener = (message, sender) => {
		if (sender.id !== browser.runtime.id) return;
		if (message?.name === "UE_MENU_SNAPSHOT")
			return Promise.resolve(menuRuntime.snapshot());
		if (message?.name === "UE_MENU_EXECUTE")
			return menuRuntime.execute(message);
		if (message?.name === "UE_MENU_REVOKE") {
			menuRuntime.revoke(message.filename);
			for (const context of sandboxContexts)
				if (
					message.filename === undefined ||
					context.filename === message.filename
				)
					context.sandbox.dispose();
			for (const store of valueStores)
				if (
					message.filename === undefined ||
					store.filename === message.filename
				)
					store.dispose();
			for (const context of tabContexts)
				if (
					message.filename === undefined ||
					context.filename === message.filename
				)
					context.dispose();
			return Promise.resolve({ ok: true });
		}
	};
	browser.runtime.onMessage.addListener(menuListener);
	browser.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && changes.US_GLOBAL_ACTIVE?.newValue === false) {
			menuRuntime.revoke();
			for (const context of sandboxContexts) context.sandbox.dispose();
			for (const store of valueStores) store.dispose();
			for (const context of tabContexts) context.dispose();
		}
	});
	window.addEventListener("pagehide", (event) => {
		if (event.persisted) menuRuntime.suspend(true);
		else {
			menuRuntime.dispose();
			for (const context of sandboxContexts) context.sandbox.dispose();
			bodyObserver?.disconnect();
			for (const store of valueStores) store.dispose();
			for (const context of tabContexts) context.dispose();
			browser.runtime.onMessage.removeListener(menuListener);
		}
	});
	window.addEventListener("pageshow", () => menuRuntime.suspend(false));
	// start the injection process and add the listeners
	injection();
	listeners();
}

initialize();
