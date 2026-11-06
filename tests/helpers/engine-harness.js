import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const engines = new Map();
export async function buildEngine(observe = false, legacy = false) {
	const cacheKey = `${observe}:${legacy}`;
	if (engines.has(cacheKey)) return engines.get(cacheKey);
	const result = await build({
		configFile: false,
		logLevel: "silent",
		publicDir: false,
		plugins: observe
			? [
					{
						name: "test-only-realm-observer",
						transform(source, id) {
							if (
								legacy &&
								id.endsWith("/content-scripts/entry-userscripts.js")
							)
								return source.replace(
									"sandbox.evaluate(code);",
									"Function('{'+Object.keys(userscript.apis).join(',')+'}',code)(userscript.apis);",
								);
							if (!id.endsWith("/content-scripts/script-sandbox.js")) return;
							// JSDOM closes a removed iframe's window, so its realm cannot
							// outlive detachment. Production (and the WebKit audits, which
							// build without this observer) keep the realm detached.
							return source.replace(
								"let disposed = false;",
								"globalThis.__testRealms.push(environment); let disposed = false;",
							);
						},
					},
				]
			: [],
		resolve: {
			alias: {
				"@shared": fileURLToPath(new URL("../../src/shared", import.meta.url)),
				"@ext": fileURLToPath(new URL("../../src/ext/shared", import.meta.url)),
			},
		},
		define: { "import.meta.env.MODE": JSON.stringify("test") },
		build: {
			write: false,
			minify: false,
			lib: {
				entry: fileURLToPath(
					new URL(
						"../../src/ext/content-scripts/entry-userscripts.js",
						import.meta.url,
					),
				),
				name: "UserscriptsEngine",
				formats: ["iife"],
			},
		},
	});
	const engine = result[0].output.find((file) => file.type === "chunk").code;
	engines.set(cacheKey, engine);
	return engine;
}

export function script(grant, code, id = "script") {
	return {
		code,
		weight: "1",
		scriptMetaStr: "// test metadata",
		scriptObject: {
			scriptId: id,
			filename: `${id}.user.js`,
			name: id,
			revision: "r1",
			grant,
			metadata: { name: [id], grant },
			"run-at": "document-end",
			"inject-into": "auto",
		},
	};
}
export async function start(
	scripts,
	initial = {},
	environment = {},
	legacy = false,
) {
	const engine = await buildEngine(true, legacy);
	const handlers = new Set(),
		storageHandlers = new Set(),
		pageEvents = new Map(),
		data = structuredClone(initial),
		errors = [];
	const browser = {
		i18n: { getMessage: () => "" },
		runtime: {
			id: "enhanced",
			onMessage: {
				addListener: (fn) => handlers.add(fn),
				removeListener: (fn) => handlers.delete(fn),
			},
			sendMessage: async (message) => {
				if (message.name === "REQ_USERSCRIPTS")
					return {
						files: {
							js: scripts.filter(
								(item) => item.scriptObject["run-at"] !== "context-menu",
							),
							css: [],
							menu: scripts.filter(
								(item) => item.scriptObject["run-at"] === "context-menu",
							),
						},
						scriptHandler: "Userscripts Enhanced",
						scriptHandlerVersion: "0.1.0",
					};
				if (message.name === "UE_MENU_CHANGED") return { ok: true };
				throw new Error(`Unexpected engine message: ${message.name}`);
			},
		},
		storage: {
			local: {
				get: async () => host.JSON.parse(JSON.stringify(data)),
				set: async (items) => {
					const changed = {};
					for (const [key, value] of Object.entries(items)) {
						changed[key] = { oldValue: data[key], newValue: value };
						data[key] = structuredClone(value);
					}
					for (const fn of storageHandlers) fn(changed, "local");
				},
			},
			onChanged: {
				addListener: (fn) => storageHandlers.add(fn),
				removeListener: (fn) => storageHandlers.delete(fn),
			},
		},
	};
	const addEventListener = (name, callback) => {
		if (!pageEvents.has(name)) pageEvents.set(name, new Set());
		pageEvents.get(name).add(callback);
	};
	const removeEventListener = (name, callback) =>
		pageEvents.get(name)?.delete(callback);
	const dom = new JSDOM("<!doctype html><html><body></body></html>", {
		url: "https://example.test/video",
		runScripts: "outside-only",
		pretendToBeVisual: true,
	});
	const host = environment.__domWindow ?? dom.window;
	Object.assign(host, {
		browser,
		structuredClone: (value) =>
			value === undefined ? undefined : host.JSON.parse(JSON.stringify(value)),
		TextEncoder,
		TextDecoder,
		__testRealms: [],
		console: {
			info() {},
			warn() {},
			debug() {},
			error: (...args) => errors.push(args),
		},
	});
	for (const [key, value] of Object.entries(environment)) {
		if (["__domWindow", "document"].includes(key)) continue;
		Object.defineProperty(host, key, {
			value,
			writable: true,
			configurable: true,
		});
	}
	Object.defineProperty(host, "crypto", { value: crypto });
	const nativeAdd = host.addEventListener.bind(host);
	host.addEventListener = (name, callback, options) => {
		addEventListener(name, callback);
		nativeAdd(name, callback, options);
	};
	const nativeRemove = host.removeEventListener.bind(host);
	host.removeEventListener = (name, callback, options) => {
		removeEventListener(name, callback);
		nativeRemove(name, callback, options);
	};
	host.eval(engine);
	// This observer is inserted only in test builds, never in shipped code.
	// Read script-local globals without moving them back into the host world.
	const context = new Proxy(host, {
		get(target, key) {
			if (typeof key === "string") {
				for (const realm of target.__testRealms) {
					const value = realm.evaluate(`globalThis[${JSON.stringify(key)}]`);
					if (value !== undefined) return value;
				}
			}
			return target[key];
		},
	});
	await new Promise(setImmediate);
	const message = async (data) => {
		for (const handler of handlers) {
			const result = handler(data, { id: "enhanced" });
			if (result !== undefined) return await result;
		}
	};
	return {
		context,
		host,
		realms: host.__testRealms,
		errors,
		message,
		handlers,
		storageHandlers,
		pageEvents,
	};
}
