// Userscripts run in a separate realm behind a membrane. A plain object they
// pass to a structured-clone API (postMessage, history.pushState, ...) arrives
// here as a membrane proxy, which the native algorithm refuses with
// DataCloneError. These wrappers live in the content-script world only (never
// the page). They call the native API first and, only on DataCloneError, retry
// with a host-realm copy of plain data (primitives, arrays, plain objects,
// Date, Map, Set). Values that are not cloneable anyway, such as functions,
// still raise the original error.

const nativeApply = Reflect.apply;
const isArray = Array.isArray;
const ownKeys = Object.keys;
const DataCloneCode = 25;

class NotCopyable extends Error {}

function isDataCloneError(error) {
	return (
		error?.name === "DataCloneError" ||
		error?.code === DataCloneCode ||
		/can ?not be cloned/i.test(String(error?.message ?? ""))
	);
}

function copy(value, seen) {
	if (
		value === null ||
		(typeof value !== "object" && typeof value !== "function")
	)
		return value;
	if (typeof value === "function") throw new NotCopyable();
	if (seen.has(value)) return seen.get(value);
	if (isArray(value)) {
		const out = [];
		seen.set(value, out);
		for (let i = 0; i < value.length; i++) out[i] = copy(value[i], seen);
		return out;
	}
	// Host objects (Blob, File, ImageData, ...) were created by host
	// constructors and arrive unwrapped; the native call already handled them.
	if (
		typeof value.getTime === "function" &&
		typeof value.toISOString === "function"
	) {
		const out = new Date(value.getTime());
		seen.set(value, out);
		return out;
	}
	if (
		typeof value.get === "function" &&
		typeof value.set === "function" &&
		typeof value.entries === "function" &&
		typeof value.size === "number"
	) {
		const out = new Map();
		seen.set(value, out);
		for (const [k, v] of value.entries()) out.set(copy(k, seen), copy(v, seen));
		return out;
	}
	if (
		typeof value.add === "function" &&
		typeof value.has === "function" &&
		typeof value.values === "function" &&
		typeof value.size === "number"
	) {
		const out = new Set();
		seen.set(value, out);
		for (const v of value.values()) out.add(copy(v, seen));
		return out;
	}
	const out = {};
	seen.set(value, out);
	for (const key of ownKeys(value)) out[key] = copy(value[key], seen);
	return out;
}

function retrying(native, cloneArgs) {
	return function (...args) {
		try {
			return nativeApply(native, this, args);
		} catch (error) {
			if (!isDataCloneError(error)) throw error;
			let copied;
			try {
				copied = args.map((arg, index) =>
					cloneArgs.includes(index) ? copy(arg, new Map()) : arg,
				);
			} catch {
				throw error;
			}
			return nativeApply(native, this, copied);
		}
	};
}

function patch(owner, name, cloneArgs) {
	const descriptor = owner && Object.getOwnPropertyDescriptor(owner, name);
	if (!descriptor || typeof descriptor.value !== "function") return;
	Object.defineProperty(owner, name, {
		...descriptor,
		value: retrying(descriptor.value, cloneArgs),
	});
}

// Keyframe parsing does not fail on a membrane proxy; WebKit silently drops
// every CSS property it cannot read, leaving keyframes with only `offset`.
// Animations then have timing but no motion. Always pass a host copy.
function copying(native, copyArgs) {
	return function (...args) {
		let copied = args;
		try {
			copied = args.map((arg, index) =>
				copyArgs.includes(index) ? copy(arg, new Map()) : arg,
			);
		} catch {
			copied = args;
		}
		return nativeApply(native, this, copied);
	};
}

function patchCopying(owner, name, copyArgs) {
	const descriptor = owner && Object.getOwnPropertyDescriptor(owner, name);
	if (!descriptor || typeof descriptor.value !== "function") return;
	Object.defineProperty(owner, name, {
		...descriptor,
		value: copying(descriptor.value, copyArgs),
	});
}

let installed = false;
export function installCloneBridge(global = globalThis) {
	if (installed) return;
	installed = true;
	patch(global, "structuredClone", [0]);
	// Window operations are own properties of the global in WebKit; fall back
	// to the prototype where an engine defines them there.
	if (Object.hasOwn(global, "postMessage")) patch(global, "postMessage", [0]);
	else patch(global.Window?.prototype, "postMessage", [0]);
	patch(global.History?.prototype, "pushState", [0]);
	patch(global.History?.prototype, "replaceState", [0]);
	patch(global.MessagePort?.prototype, "postMessage", [0]);
	patch(global.BroadcastChannel?.prototype, "postMessage", [0]);
	patch(global.Worker?.prototype, "postMessage", [0]);
	patchCopying(global.Element?.prototype, "animate", [0, 1]);
	patchCopying(global.KeyframeEffect?.prototype, "setKeyframes", [0]);
}
