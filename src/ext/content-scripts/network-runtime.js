import { xhrDataProcessor } from "./xhr-transport.js";

export function createXhrAPI({ browser, identity, baseURL }) {
	function start(details, promiseStyle) {
		let resolve, reject;
		const result = promiseStyle
			? new Promise((yes, no) => {
					resolve = yes;
					reject = no;
				})
			: {};
		let port;
		let done = false;
		let aborted = false;
		const invoke = (handler, response) => {
			try {
				details?.[handler]?.(response);
			} catch (error) {
				console.error("Userscripts Enhanced: request callback failed", error);
			}
		};
		const finish = (name, response, error) => {
			if (done) return;
			done = true;
			invoke("onreadystatechange", response);
			invoke(name, response);
			invoke("onloadend", response);
			if (error) reject?.(error);
			else resolve?.(response);
			port?.disconnect();
		};
		result.abort = () => {
			if (done) return;
			aborted = true;
			port?.postMessage({ name: "ABORT" });
		};
		(async () => {
			try {
				if (!details || typeof details.url !== "string")
					throw new TypeError("GM request requires a URL");
				if (
					details.upload ||
					details.binary ||
					details.user ||
					details.password ||
					details.overrideMimeType
				)
					throw new Error(
						"Upload progress, binary strings, HTTP user/password and overrideMimeType are not supported",
					);
				const responseType = details.responseType ?? "text";
				if (
					!["", "text", "json", "arraybuffer", "blob", "document"].includes(
						responseType,
					)
				)
					throw new Error("Unsupported responseType");
				port = browser.runtime.connect({ name: "UE_XHR" });
				port.onMessage.addListener((message) => {
					if (message.name === "PROGRESS") {
						invoke("onprogress", message);
						return;
					}
					if (message.name === "LOAD") {
						try {
							const { bytes, ...response } = message.response;
							const data = new Uint8Array(bytes);
							const text = new TextDecoder().decode(data);
							response.responseType = responseType;
							if (responseType === "arraybuffer")
								response.response = data.buffer;
							else if (responseType === "blob")
								response.response = new Blob([data], {
									type: response.contentType,
								});
							else if (responseType === "json")
								response.response = JSON.parse(text);
							else if (responseType === "document") {
								response.response = new DOMParser().parseFromString(
									text,
									response.contentType.includes("text/html")
										? "text/html"
										: "text/xml",
								);
								response.responseXML = response.response;
							} else {
								response.response = text;
								response.responseText = text;
							}
							finish("onload", response);
						} catch (error) {
							finish(
								"onerror",
								{ readyState: 4, status: 0, error: String(error) },
								error,
							);
						}
					} else {
						const error = new Error(message.error || message.name);
						finish(
							{ TIMEOUT: "ontimeout", ABORT: "onabort" }[message.name] ??
								"onerror",
							{ readyState: 4, status: 0, error: error.message },
							error,
						);
					}
				});
				port.onDisconnect.addListener(() => {
					if (!done)
						finish(
							"onerror",
							{ readyState: 4, status: 0, error: "Request connection closed" },
							new Error("Request connection closed"),
						);
				});
				const data = await xhrDataProcessor(details.data);
				if (aborted) {
					finish(
						"onabort",
						{ readyState: 4, status: 0 },
						new Error("Request aborted"),
					);
					return;
				}
				invoke("onloadstart", { readyState: 1, status: 0 });
				port.postMessage({
					name: "REQUEST",
					identity,
					details: {
						url: new URL(details.url, baseURL).href,
						method: (details.method ?? "GET").toUpperCase(),
						headers: Object.fromEntries(Object.entries(details.headers ?? {})),
						data,
						timeout: details.timeout ?? 30000,
						anonymous: details.anonymous === true,
						redirect: details.redirect,
						progress: typeof details.onprogress === "function",
					},
				});
			} catch (error) {
				finish(
					"onerror",
					{ readyState: 4, status: 0, error: String(error.message ?? error) },
					error,
				);
			}
		})();
		return result;
	}
	return {
		GM_xmlhttpRequest: (details) => start(details, false),
		xmlHttpRequest: (details) => start(details, true),
	};
}
