import { createRealm, linkScope } from "./realm.js";
import { installCloneBridge } from "./clone-bridge.js";
import { IMPORT_PATTERN, neutralizeImports } from "./import-guard.js";

// Near Membrane supplies realm separation and copy-on-write intrinsics. Policy
// belongs here: it must never expose WebExtension objects, foreign Windows,
// the realm's raw global object, or any way to compile code at realm (or
// host) global scope. Capture capabilities before executing any userscript,
// including getters and methods, so an alternate reference/descriptor cannot
// bypass the deny set.
const forbidden = new WeakSet();
function forbidGraph(value) {
	if (
		(typeof value !== "object" || value === null) &&
		typeof value !== "function"
	)
		return;
	if (forbidden.has(value)) return;
	forbidden.add(value);
	for (const descriptor of Object.values(
		Object.getOwnPropertyDescriptors(value),
	)) {
		forbidGraph(descriptor.value);
		forbidGraph(descriptor.get);
		forbidGraph(descriptor.set);
	}
}
for (const name of ["browser", "chrome", "safari", "webkit"]) {
	forbidGraph(globalThis[name]);
}
const windowGetter = Object.getOwnPropertyDescriptor(window, "window")?.get;

const deniedObject = Object.freeze(Object.create(null));
const deniedFunction = () => {
	throw new TypeError("Extension capability denied");
};
// Host functions that compile strings into code in the privileged
// content-script realm.
const hostCompilers = new Set(
	[
		Function,
		eval,
		Object.getPrototypeOf(async function () {}).constructor,
		Object.getPrototypeOf(function* () {}).constructor,
		Object.getPrototypeOf(async function* () {}).constructor,
	].filter((value) => typeof value === "function"),
);
// String handlers would also be compiled in the host realm.
const guardTimer = (native) =>
	function (handler, ...rest) {
		if (typeof handler !== "function")
			throw new TypeError("Timer handler must be a function");
		return Reflect.apply(native, window, [handler, ...rest]);
	};
const hostTimers = new Map(
	["setTimeout", "setInterval"]
		.filter((name) => typeof window[name] === "function")
		.map((name) => [window[name], guardTimer(window[name])]),
);

function distort(value) {
	if (forbidden.has(value))
		return typeof value === "function" ? deniedFunction : deniedObject;
	if (hostCompilers.has(value)) return deniedFunction;
	if (hostTimers.has(value)) return hostTimers.get(value);
	// A different Window could introduce another extension API object or an
	// unmediated Function constructor. Cross-frame DOM remains available via
	// contentDocument; direct foreign Window access is deliberately unsupported.
	// (This window itself is linked to the script scope and never gets here.)
	if (windowGetter && value !== window) {
		try {
			if (Reflect.apply(windowGetter, value, []) === value) return deniedObject;
		} catch {
			// WebIDL brand check rejects non-Window values.
		}
	}
	return value;
}

// Evaluated inside the sandbox realm, at its global scope, before any script.
//
// The realm global is an iframe window: its unforgeable `top` is the
// privileged content-script window and its own `location` is a load-time
// snapshot. Scripts must never hold that global. They run inside a function
// whose `window/self/globalThis/top/parent/frames/location` are a scope proxy
// (the host window is linked to it, so document.defaultView, event.view etc.
// are the same object); in strict mode, so no sloppy `this` falls back to the
// raw global; and every string->code path (Function, eval, the async and
// generator Function constructors, string timers) compiles inside that same
// scope instead of at global scope.
//
// `legacy` (per-script opt-in from the popup) keeps sloppy mode for old
// scripts. Sloppy functions called without a receiver see the raw global, so
// a legacy script is NOT isolated from extension capabilities.
const SCOPE_BOOTSTRAP = `(function (hostLocation, isTop, legacy, scopeKey, importPattern) {
	"use strict";
	const importExpression = new RegExp(importPattern, "gu");
	const neutralize = (source) => String(source).replace(importExpression, "__ueImport__");
	const blockedImport = () => Promise.reject(new TypeError("Dynamic import() is not supported in userscripts"));
	const target = globalThis;
	const { apply, defineProperty, get, set } = Reflect;
	const RealFunction = Function;
	const opaqueTop = Object.freeze(Object.create(null));
	const parentValue = () => (isTop ? scope : get(target, "parent"));
	// Keys whose value (or native getter) is, or leads to, the raw global.
	const special = (key) => {
		switch (key) {
			case "window":
			case "self":
			case "globalThis":
			case "frames":
				return { value: scope };
			case "top":
				return { value: isTop ? scope : opaqueTop };
			case "parent":
				return { value: parentValue() };
			case "location":
				return { value: hostLocation };
			case "document":
				return { value: get(target, "document") };
		}
	};
	// The proxy target is a blank object, so descriptors can be reported
	// without the realm global's non-configurable natives (Proxy invariants).
	// Only properties a script itself makes non-configurable are mirrored here.
	const shadow = {};
	Object.setPrototypeOf(shadow, Object.getPrototypeOf(target));
	const scope = new Proxy(shadow, {
		get(_, key) {
			const fixed = special(key);
			return fixed ? fixed.value : get(target, key, target);
		},
		set(_, key, value) {
			if (key === "location") {
				hostLocation.href = value;
				return true;
			}
			if (special(key)) return false;
			return set(target, key, value, target);
		},
		has: (_, key) => Reflect.has(target, key),
		ownKeys: () => [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(shadow)])],
		getOwnPropertyDescriptor(_, key) {
			const fixed = special(key);
			if (fixed)
				return { value: fixed.value, writable: false, enumerable: true, configurable: true };
			const mirrored = Reflect.getOwnPropertyDescriptor(shadow, key);
			if (mirrored) return mirrored;
			const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
			if (descriptor) descriptor.configurable = true;
			return descriptor;
		},
		defineProperty(_, key, descriptor) {
			if (special(key) || !Reflect.defineProperty(target, key, descriptor)) return false;
			const result = Reflect.getOwnPropertyDescriptor(target, key);
			if (result && !result.configurable) Reflect.defineProperty(shadow, key, result);
			return true;
		},
		deleteProperty: (_, key) => !special(key) && Reflect.deleteProperty(target, key),
		getPrototypeOf: () => Reflect.getPrototypeOf(target),
		setPrototypeOf: () => false,
		preventExtensions: () => false,
	});
	const params = ["window", "self", "globalThis", "top", "parent", "frames", "location", "__ueImport__"];
	const values = () => [scope, scope, scope, isTop ? scope : opaqueTop, parentValue(), scope, hostLocation, blockedImport];
	const mode = legacy ? "" : '"use strict";\\n';
	// Any text that escapes the inner function still sits inside the outer
	// one, whose parameters shadow the dangerous globals.
	const compile = (body) => apply(apply(RealFunction, undefined, [...params, mode + neutralize(body)]), scope, values());
	const makeConstructor = (keyword, name, prototype) => {
		const constructor = function (...args) {
			const body = args.length ? String(args[args.length - 1]) : "";
			const list = neutralize(args.slice(0, -1).map(String).join(","));
			return compile("return (" + keyword + " anonymous(" + list + "\\n) {\\n" + body + "\\n});");
		};
		defineProperty(constructor, "name", { value: name });
		defineProperty(constructor, "prototype", { value: prototype, writable: false });
		defineProperty(prototype, "constructor", { value: constructor, writable: false, configurable: true });
		return constructor;
	};
	const safeFunction = makeConstructor("function", "Function", RealFunction.prototype);
	makeConstructor("async function", "AsyncFunction", Object.getPrototypeOf(async function () {}));
	makeConstructor("function*", "GeneratorFunction", Object.getPrototypeOf(function* () {}));
	makeConstructor("async function*", "AsyncGeneratorFunction", Object.getPrototypeOf(async function* () {}));
	// Indirect-eval semantics inside the scope: an expression yields its value;
	// statements run and yield undefined.
	const safeEval = function (source) {
		if (typeof source !== "string") return source;
		let body;
		try {
			apply(RealFunction, undefined, [...params, mode + "return (" + neutralize(source) + "\\n);"]);
			body = "return (" + source + "\\n);";
		} catch {
			body = source;
		}
		return compile(body);
	};
	defineProperty(safeEval, "name", { value: "eval" });
	defineProperty(target, "Function", { value: safeFunction, writable: true, configurable: true });
	defineProperty(target, "eval", { value: safeEval, writable: true, configurable: true });
	for (const name of ["setTimeout", "setInterval"]) {
		const timer = get(target, name);
		if (typeof timer !== "function") continue;
		defineProperty(target, name, {
			value: function (handler, ...rest) {
				if (typeof handler !== "function") handler = safeFunction(String(handler));
				return apply(timer, target, [handler, ...rest]);
			},
			writable: true,
			configurable: true,
		});
	}
	defineProperty(target, scopeKey, { value: scope, configurable: true });
	return (compiled) => apply(compiled, scope, values());
})`;

let installed = false;
export function createScriptSandbox(apis, { legacy = false } = {}) {
	if (typeof windowGetter !== "function")
		throw new Error(
			"Safe Window branding is unavailable; refusing privileged script execution",
		);
	if (!installed) {
		installCloneBridge(window);
		installed = true;
	}
	const { env: environment } = createRealm({
		endowments: Object.getOwnPropertyDescriptors(apis),
		distortionCallback: distort,
		// DOM is intentionally shared. Preserve native property writes (including
		// dataset/style) without making JS globals or API objects live targets.
		liveTargetCallback: (value) =>
			!Object.hasOwn(value, "constructor") &&
			(value instanceof Node ||
				value instanceof CSSStyleDeclaration ||
				value instanceof DOMStringMap),
	});
	const scopeKey = `__ueScope${crypto.randomUUID().replaceAll("-", "")}`;
	const invoke = environment.evaluate(SCOPE_BOOTSTRAP)(
		window.location,
		window.top === window,
		legacy,
		scopeKey,
		IMPORT_PATTERN,
	);
	linkScope(environment, scopeKey);
	environment.evaluate(`delete globalThis[${JSON.stringify(scopeKey)}]`);
	const header = legacy ? "" : '"use strict";\n';
	let disposed = false;
	return {
		evaluate(source) {
			if (disposed) throw new Error("Script realm has been disposed");
			const compiled = environment.evaluate(
				`(function (window, self, globalThis, top, parent, frames, location, __ueImport__) {${header}\n${neutralizeImports(source)}\n})`,
			);
			return invoke(compiled);
		},
		dispose() {
			disposed = true;
		},
	};
}
