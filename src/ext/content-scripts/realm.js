import {
	VirtualEnvironment,
	assignFilteredGlobalDescriptorsFromPropertyDescriptorMap,
	createBlueConnector,
	createRedConnector,
	getFilteredGlobalOwnKeys,
} from "@locker/near-membrane-base";
import { REALM_ATTRIBUTE, REALM_MARK } from "./realm-guard.js";

// A per-script iframe realm wired like @locker/near-membrane-dom's attached
// ("keepAlive") environment, with two deliberate differences in how identities
// are linked across the membrane:
//
// - near-membrane links the host window <-> realm global in both directions.
//   The realm global is an iframe window whose unforgeable `top` is the
//   privileged content-script window, so any host API returning the host
//   window (document.defaultView, event.view, MessageEvent.source, ...) handed
//   scripts that raw global. Here, once wiring is done, host -> realm is
//   relinked to the script's scope proxy (see linkScope), which never exposes
//   the raw global; realm -> host still maps the realm global to the host
//   window so receivers keep working.
// - `Function` is linked realm -> host only. Host functions' `.constructor`
//   would otherwise become the realm's real Function constructor, which
//   evaluates at realm global scope. Host -> realm it now passes through the
//   distortion callback, which denies it.
//
// The realm must stay attached: WebKit stops running promise reactions for a
// detached iframe realm (`await` on a rejection never resumes).

const nativeApply = Reflect.apply;
const createElement = Document.prototype.createElement;
const bodyGetter = Object.getOwnPropertyDescriptor(
	Document.prototype,
	"body",
).get;
const lastChildGetter = Object.getOwnPropertyDescriptor(
	Node.prototype,
	"lastChild",
).get;
const appendChild = Node.prototype.appendChild;
const setAttribute = Element.prototype.setAttribute;
const contentWindowGetter = Object.getOwnPropertyDescriptor(
	HTMLIFrameElement.prototype,
	"contentWindow",
).get;
const documentOpen = Document.prototype.open;
const documentClose = Document.prototype.close;

// Same list as near-membrane-base's ReflectiveIntrinsicObjectNames.
const reflectiveIntrinsics = [
	"AggregateError",
	"Array",
	"Error",
	"EvalError",
	"Function",
	"Object",
	"Proxy",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"TypeError",
	"URIError",
];
const unforgeables = new Set(["document", "location", "top", "window"]);
const withoutUnforgeables = (keys) =>
	keys.filter((key) => !unforgeables.has(key) && key !== "chrome");

const hostRefs = (() => {
	const WindowProto = Object.getPrototypeOf(window);
	const WindowPropertiesProto = Object.getPrototypeOf(WindowProto);
	const EventTargetProto = Object.getPrototypeOf(WindowPropertiesProto);
	return {
		DocumentProto: Object.getPrototypeOf(document),
		EventTargetProto,
		EventTargetProtoOwnKeys: EventTargetProto
			? Reflect.ownKeys(EventTargetProto)
			: [],
	};
})();
let blueConnector;
const revoked = new WeakSet();

function linkPath(env, keys, { hostToRealm = true } = {}) {
	let blue = env.blueGlobalThisPointer;
	let red = env.redGlobalThisPointer;
	keys.forEach((key, index) => {
		blue = env.blueCallableGetPropertyValuePointer(blue, key);
		red = env.redCallableGetPropertyValuePointer(red, key);
		env.redCallableLinkPointers(red, blue);
		if (hostToRealm || index > 0) env.blueCallableLinkPointers(blue, red);
	});
}

export function createRealm({
	endowments,
	distortionCallback,
	liveTargetCallback,
}) {
	const frame = nativeApply(createElement, document, ["iframe"]);
	frame.style.display = "none";
	nativeApply(setAttribute, frame, [
		"sandbox",
		"allow-same-origin allow-scripts",
	]);
	nativeApply(setAttribute, frame, ["aria-hidden", "true"]);
	nativeApply(setAttribute, frame, [REALM_ATTRIBUTE, ""]);
	const parent =
		nativeApply(bodyGetter, document, []) ??
		nativeApply(lastChildGetter, document, []);
	nativeApply(appendChild, parent, [frame]);
	const redWindow = nativeApply(contentWindowGetter, frame, []);
	if (!redWindow) throw new Error("Realm frame unavailable");
	// Content scripts Safari injects into this frame must recognise it.
	Object.defineProperty(redWindow, REALM_MARK, { value: true });
	const redDocument = redWindow.document;
	blueConnector ??= createBlueConnector(window);
	const env = new VirtualEnvironment({
		blueConnector,
		redConnector: createRedConnector(redWindow.eval),
		distortionCallback,
		liveTargetCallback,
		protectDistortions: true,
		revokedProxyCallback: (value) => revoked.has(value),
	});
	for (const name of reflectiveIntrinsics) {
		const value = window[name];
		if (!value) continue;
		if (name === "Function")
			linkPath(env, [name, "prototype"], { hostToRealm: false });
		else if (value.prototype) linkPath(env, [name, "prototype"]);
		else linkPath(env, [name]);
	}
	// Both directions while the environment is wired (remapping and endowments
	// target the realm global through this link); linkScope then repoints the
	// host -> realm direction at the script scope before any script runs.
	env.redCallableLinkPointers(
		env.redGlobalThisPointer,
		env.blueGlobalThisPointer,
	);
	env.blueCallableLinkPointers(
		env.blueGlobalThisPointer,
		env.redGlobalThisPointer,
	);
	linkPath(env, ["document"]);
	linkPath(env, ["__proto__", "__proto__", "__proto__"]);
	env.remapProto(document, hostRefs.DocumentProto);
	env.lazyRemapProperties(
		window,
		withoutUnforgeables(getFilteredGlobalOwnKeys(redWindow, false)),
	);
	if (endowments) {
		const filtered = {};
		assignFilteredGlobalDescriptorsFromPropertyDescriptorMap(
			filtered,
			endowments,
			false,
		);
		for (const key of [...unforgeables, "chrome"]) delete filtered[key];
		env.remapProperties(window, filtered);
	}
	env.lazyRemapProperties(
		hostRefs.EventTargetProto,
		hostRefs.EventTargetProtoOwnKeys,
	);
	revoked.add(redDocument);
	revoked.add(redWindow);
	nativeApply(documentOpen, redDocument, []);
	nativeApply(documentClose, redDocument, []);
	return { env, frame };
}

// Make the host window cross into the realm as `scope`, and `scope` cross back
// to the host as the host window. `key` names a temporary realm-global
// property holding scope, used only to obtain its membrane pointer.
export function linkScope(env, key) {
	const scopePointer = env.redCallableGetPropertyValuePointer(
		env.redGlobalThisPointer,
		key,
	);
	env.redCallableLinkPointers(scopePointer, env.blueGlobalThisPointer);
	env.blueCallableLinkPointers(env.blueGlobalThisPointer, scopePointer);
}
