import { assertConnect, requestBody } from "../shared/network-policy.js";

export function installNetworkHandler({
	browser,
	authorize,
	fetchRequest = fetch,
}) {
	browser.runtime.onConnect.addListener((port) => {
		if (port.name !== "UE_XHR") return;
		const sender = port.sender;
		if (
			sender?.id !== browser.runtime.id ||
			!Number.isInteger(sender.tab?.id)
		) {
			port.disconnect();
			return;
		}
		const controller = new AbortController();
		let started = false;
		let done = false;
		let timeout;
		let timedOut = false;
		const post = (message) => {
			if (!done) port.postMessage(message);
		};
		port.onDisconnect.addListener(() => {
			done = true;
			controller.abort();
			clearTimeout(timeout);
		});
		port.onMessage.addListener(async (message) => {
			if (message?.name === "ABORT") {
				controller.abort();
				return;
			}
			if (message?.name !== "REQUEST" || started) return;
			started = true;
			try {
				const details = message.details;
				const permission = await authorize(message.identity, sender);
				const url = assertConnect(details.url, sender.url, permission.connect);
				if (
					!(await browser.permissions.contains({
						origins: [`${url.origin}/*`],
					}))
				)
					throw new Error("Safari host permission is missing for this request");
				if (details.redirect && details.redirect !== "error")
					throw new Error(
						"Redirect following is unavailable; only redirect: 'error' is supported",
					);
				const method = details.method || "GET";
				if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method))
					throw new Error("Unsupported HTTP method");
				for (const name of Object.keys(details.headers ?? {})) {
					if (
						/^(cookie|host|origin|referer|connection|content-length|sec-)/i.test(
							name,
						)
					)
						throw new Error(`Safari cannot safely set the ${name} header`);
				}
				const duration = details.timeout || 30000;
				if (!Number.isFinite(duration) || duration < 0 || duration > 300000)
					throw new Error("Invalid request timeout");
				timeout = setTimeout(() => {
					timedOut = true;
					controller.abort();
				}, duration);
				const response = await fetchRequest(url.href, {
					method,
					headers: details.headers,
					body: ["GET", "HEAD"].includes(method)
						? undefined
						: requestBody(details.data),
					credentials: details.anonymous ? "omit" : "include",
					redirect: "error",
					signal: controller.signal,
				});
				if (response.type === "opaqueredirect")
					throw new Error("Safari cannot authorize an opaque redirect");
				const total = Number(response.headers.get("content-length")) || 0;
				const chunks = [];
				let loaded = 0;
				const reader = response.body?.getReader();
				if (reader) {
					for (;;) {
						const { value, done: ended } = await reader.read();
						if (ended) break;
						loaded += value.byteLength;
						if (loaded > 64 * 1024 * 1024) {
							controller.abort();
							throw new Error("Response exceeds 64 MiB limit");
						}
						chunks.push(value);
						if (details.progress)
							post({
								name: "PROGRESS",
								loaded,
								total,
								lengthComputable: total > 0,
							});
					}
				} else {
					const bytes = new Uint8Array(await response.arrayBuffer());
					if (bytes.length > 64 * 1024 * 1024)
						throw new Error("Response exceeds 64 MiB limit");
					chunks.push(bytes);
					loaded = bytes.length;
				}
				const bytes = new Uint8Array(loaded);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.length;
				}
				post({
					name: "LOAD",
					response: {
						status: response.status,
						statusText: response.statusText,
						finalUrl: response.url || url.href,
						responseURL: response.url || url.href,
						responseHeaders: [...response.headers]
							.map(([k, v]) => `${k}: ${v}`)
							.join("\r\n"),
						contentType: response.headers.get("content-type") ?? "text/plain",
						bytes: Array.from(bytes),
						readyState: 4,
					},
				});
			} catch (error) {
				post({
					name: timedOut
						? "TIMEOUT"
						: controller.signal.aborted
							? "ABORT"
							: "ERROR",
					error: String(error.message ?? error),
				});
			} finally {
				clearTimeout(timeout);
			}
		});
	});
}
