import { copyJSON } from "./json-data.js";
export function createTabAPI({ browser, identity, baseURL, reportError }) {
	const handles = new Map();
	const listener = (message, sender) => {
		if (sender.id !== browser.runtime.id || message?.name !== "UE_TAB_CLOSED")
			return;
		const handle = handles.get(message.handle);
		if (!handle) return;
		handle.closed = true;
		handles.delete(message.handle);
		try {
			handle.onclose?.();
		} catch (error) {
			reportError(error);
		}
	};
	browser.runtime.onMessage.addListener(listener);
	const send = async (action, data = {}) => {
		const response = await browser.runtime.sendMessage({
			name: `UE_TAB_${action}`,
			identity,
			...data,
		});
		if (!response?.ok)
			throw new Error(response?.error ?? "Tab operation unavailable");
		return response;
	};
	function open(url, options = {}) {
		if (typeof options === "boolean") options = { active: !options };
		if (!options || typeof options !== "object")
			throw new TypeError("Invalid openInTab options");
		if (
			options.insert !== undefined ||
			options.setParent !== undefined ||
			options.incognito !== undefined
		)
			throw new Error(
				"insert, setParent and incognito are not supported by this tab adapter",
			);
		const target = new URL(url, baseURL);
		if (!["http:", "https:"].includes(target.protocol))
			throw new Error("Only HTTP(S) tabs may be opened");
		let token;
		let closePending = false;
		let onclose = null;
		const control = {
			closed: false,
			get onclose() {
				return onclose;
			},
			set onclose(value) {
				if (value !== null && typeof value !== "function")
					throw new TypeError("onclose must be a function or null");
				onclose = value;
			},
			close() {
				if (control.closed) return;
				if (!token) {
					closePending = true;
					return;
				}
				send("CLOSE", { handle: token }).catch(reportError);
			},
		};
		const ready = send("OPEN", {
			url: target.href,
			active: options.active !== false,
		}).then(({ handle }) => {
			token = handle;
			handles.set(token, control);
			if (closePending) control.close();
			return control;
		});
		return { control, ready };
	}
	return {
		api: {
			GM_openInTab: (url, options) => {
				const result = open(url, options);
				result.ready.catch(reportError);
				return result.control;
			},
			openInTab: (url, options) => open(url, options).ready,
			GM_getTab: (callback) => {
				if (typeof callback !== "function")
					throw new TypeError("getTab requires a callback");
				send("GET")
					.then(({ data }) => callback(data))
					.catch(reportError);
			},
			getTab: async () => (await send("GET")).data,
			GM_saveTab: (data, callback) => {
				send("SAVE", { data: copyJSON(data) })
					.then(() => callback?.())
					.catch(reportError);
			},
			saveTab: async (data) => {
				await send("SAVE", { data: copyJSON(data) });
			},
			GM_getTabs: (callback) => {
				if (typeof callback !== "function")
					throw new TypeError("getTabs requires a callback");
				send("ALL")
					.then(({ data }) => callback(data))
					.catch(reportError);
			},
			getTabs: async () => (await send("ALL")).data,
		},
		dispose() {
			browser.runtime.onMessage.removeListener(listener);
			handles.clear();
		},
	};
}
