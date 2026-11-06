import { JSDOM } from "jsdom";
// A deliberately bounded DOM/media model. These tests do not claim browser playback.
export function speedMasterDOM() {
	let now = 0,
		sequence = 0;
	const timers = new Map();
	const setTimeout = (callback, delay = 0) => {
		const id = ++sequence;
		timers.set(id, { callback, at: now + delay });
		return id;
	};
	function advance(ms = 0) {
		const until = now + ms;
		for (let runs = 0; runs < 1000; runs++) {
			const next = [...timers]
				.filter(([, timer]) => timer.at <= until)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) {
				now = until;
				return;
			}
			timers.delete(next[0]);
			now = next[1].at;
			next[1].callback();
		}
		throw new Error("Excessive timer callbacks in media model");
	}
	const dom = new JSDOM("<!doctype html><html><body></body></html>", {
		url: "https://example.test/video",
		runScripts: "outside-only",
	});
	const win = dom.window;
	const document = win.document;
	const shadows = new WeakMap();
	const attachShadow = win.Element.prototype.attachShadow;
	win.Element.prototype.attachShadow = function (options) {
		const root = attachShadow.call(this, options);
		shadows.set(this, root);
		return root;
	};
	Object.defineProperty(document, "readyState", { value: "complete" });
	Object.defineProperty(document, "visibilityState", { value: "visible" });
	Object.defineProperty(document, "hidden", { value: false });
	const nativeDispatch = win.dispatchEvent.bind(win);
	const windowEvents = {
		addEventListener: win.addEventListener.bind(win),
		removeEventListener: win.removeEventListener.bind(win),
		dispatchEvent(data) {
			const event = new win.Event(data.type);
			for (const [key, value] of Object.entries(data))
				if (key !== "type") Object.defineProperty(event, key, { value });
			return nativeDispatch(event);
		},
	};
	const storage = new Map();
	const observers = new Set();
	class MutationObserver {
		constructor(callback) {
			this.callback = callback;
		}
		observe() {
			observers.add(this);
		}
		disconnect() {
			observers.delete(this);
		}
	}
	function video(properties = {}) {
		const node = document.createElement("video");
		for (const [key, value] of Object.entries({
			paused: true,
			ended: false,
			seeking: false,
			readyState: 4,
			...properties,
		}))
			Object.defineProperty(node, key, {
				value,
				writable: true,
				configurable: true,
			});
		node.getBoundingClientRect = () =>
			node.rect ?? {
				left: 0,
				top: 0,
				right: 640,
				bottom: 360,
				width: 640,
				height: 360,
			};
		let rate = 1;
		Object.defineProperty(node, "playbackRate", {
			get: () => rate,
			set: (value) => {
				rate = Math.min(value, node.maxRate ?? 16);
				node.dispatchEvent(new win.Event("ratechange", { bubbles: true }));
			},
		});
		document.body.append(node);
		return node;
	}
	function mediaEvent(node, type, properties = {}) {
		Object.assign(node, properties);
		node.dispatchEvent(new win.Event(type, { bubbles: true }));
		advance();
	}
	function findHost() {
		return document.getElementById("speedmaster-host") ?? undefined;
	}
	return {
		document,
		timers,
		observers,
		video,
		mediaEvent,
		advance,
		findHost,
		shadowRootFor: (host) => shadows.get(host),
		windowEvents,
		environment: {
			__domWindow: win,
			document,
			MutationObserver,
			setTimeout,
			clearTimeout: (id) => timers.delete(id),
			addEventListener: windowEvents.addEventListener,
			removeEventListener: windowEvents.removeEventListener,
			innerWidth: 1280,
			innerHeight: 800,
			getComputedStyle: (node) => ({
				display: node.style.display ?? "block",
				visibility: node.style.visibility ?? "visible",
			}),
			localStorage: {
				getItem: (key) => storage.get(key) ?? null,
				setItem: (key, value) => storage.set(key, value),
			},
		},
	};
}
