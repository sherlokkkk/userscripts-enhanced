import createVirtualEnvironment from "@locker/near-membrane-dom";
import { installCloneBridge } from "./clone-bridge.js";

// Near Membrane supplies realm separation and copy-on-write intrinsics. Policy
// belongs here: it must never expose WebExtension objects or foreign Windows.
// Capture capabilities before executing any userscript, including getters and
// methods, so an alternate reference/descriptor cannot bypass the deny set.
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
function distort(value) {
	if (forbidden.has(value))
		return typeof value === "function" ? deniedFunction : deniedObject;
	// A different Window could introduce another extension API object or an
	// unmediated Function constructor. Cross-frame DOM remains available via
	// contentDocument; direct foreign Window access is deliberately unsupported.
	if (windowGetter && value !== window) {
		try {
			if (Reflect.apply(windowGetter, value, []) === value) return deniedObject;
		} catch {
			// WebIDL brand check rejects non-Window values.
		}
	}
	return value;
}

// Evaluated inside the sandbox realm. The realm global is an iframe window
// whose own unforgeable `top` is not the script's window and whose own
// `location` is a load-time snapshot (near-membrane's document.open()). Userscripts expect
// `window.top === window.self` in the top frame and a live page `location`,
// so scripts run with these identifiers bound to a window proxy; everything
// else is forwarded to the realm global unchanged.
const SCOPE_BOOTSTRAP = `(function (hostLocation, isTop) {
	"use strict";
	const target = globalThis;
	const opaqueTop = Object.freeze(Object.create(null));
	const nativeSource = /\\{\\s*\\[native code\\]\\s*\\}\\s*$/;
	const toSource = Function.prototype.toString;
	const bound = new WeakMap();
	const plain = new WeakSet();
	let scope;
	// Native methods read through the proxy must not receive the proxy as
	// receiver (WebIDL brand checks). User functions keep their identity.
	const receiverSafe = (fn) => {
		if (plain.has(fn)) return fn;
		let wrapped = bound.get(fn);
		if (wrapped) return wrapped;
		let native = false;
		try {
			native = nativeSource.test(Reflect.apply(toSource, fn, []));
		} catch {}
		if (!native) {
			plain.add(fn);
			return fn;
		}
		wrapped = new Proxy(fn, {
			apply: (f, receiver, args) =>
				Reflect.apply(f, receiver === scope ? target : receiver, args),
		});
		bound.set(fn, wrapped);
		return wrapped;
	};
	const parentValue = () => (isTop ? scope : Reflect.get(target, "parent"));
	scope = new Proxy(target, {
		get(t, key) {
			switch (key) {
				case "window":
				case "self":
				case "globalThis":
				case "frames":
					return scope;
				case "top":
					return isTop ? scope : opaqueTop;
				case "parent":
					return parentValue();
				case "location":
					return hostLocation;
			}
			const value = Reflect.get(t, key, t);
			return typeof value === "function" ? receiverSafe(value) : value;
		},
		set(t, key, value) {
			if (key === "location") {
				hostLocation.href = value;
				return true;
			}
			return Reflect.set(t, key, value, t);
		},
	});
	return (compiled) =>
		Reflect.apply(compiled, scope, [
			scope,
			scope,
			scope,
			isTop ? scope : opaqueTop,
			parentValue(),
			scope,
			hostLocation,
		]);
})`;

export function createScriptSandbox(apis) {
	if (typeof windowGetter !== "function")
		throw new Error(
			"Safe Window branding is unavailable; refusing privileged script execution",
		);
	installCloneBridge(window);
	const environment = createVirtualEnvironment(window, {
		endowments: Object.getOwnPropertyDescriptors(apis),
		distortionCallback: distort,
		protectDistortions: true,
		// DOM is intentionally shared. Preserve native property writes (including
		// dataset/style) without making JS globals or API objects live targets.
		liveTargetCallback: (value) =>
			!Object.hasOwn(value, "constructor") &&
			(value instanceof Node ||
				value instanceof CSSStyleDeclaration ||
				value instanceof DOMStringMap),
		// Must stay attached: WebKit stops running promise reactions in a
		// detached iframe realm (`await` on a rejection never resumes).
		// KNOWN GAP: an attached realm's unforgeable `top` is the privileged
		// content-script window; see docs/security-model.md.
		keepAlive: true,
	});
	const invoke = environment.evaluate(SCOPE_BOOTSTRAP)(
		window.location,
		window.top === window,
	);
	let disposed = false;
	return {
		evaluate(source) {
			if (disposed) throw new Error("Script realm has been disposed");
			const compiled = environment.evaluate(
				`(function (window, self, globalThis, top, parent, frames, location) {\n${source}\n})`,
			);
			return invoke(compiled);
		},
		dispose() {
			disposed = true;
		},
	};
}
