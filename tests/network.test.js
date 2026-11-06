import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
	assertConnect,
	requestBody,
} from "../src/ext/shared/network-policy.js";
import { installNetworkHandler } from "../src/ext/background/network.js";
import { createXhrAPI } from "../src/ext/content-scripts/network-runtime.js";

let server, base;
let secretHits = 0;
before(async () => {
	server = http.createServer(async (request, response) => {
		if (request.url === "/redirect") {
			response.writeHead(302, { Location: "/secret" });
			response.end();
			return;
		}
		if (request.url === "/secret") secretHits++;
		if (request.url === "/slow") {
			request.on("close", () => response.destroy());
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk;
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				method: request.method,
				body,
				header: request.headers["x-test"],
				ok: true,
			}),
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

function event() {
	const listeners = new Set();
	return {
		addListener: (fn) => listeners.add(fn),
		removeListener: (fn) => listeners.delete(fn),
		emit: (...args) => {
			for (const fn of listeners) fn(...args);
		},
	};
}
function transport({
	allowed = true,
	permission = true,
	origin = base,
	connect = [],
} = {}) {
	const onConnect = event();
	const browser = {
		runtime: {
			id: "extension",
			onConnect,
			connect: ({ name }) => {
				let disconnected = false;
				const left = { name, onMessage: event(), onDisconnect: event() };
				const right = {
					name,
					sender: {
						id: "extension",
						tab: { id: 1 },
						frameId: 3,
						url: `${origin}/`,
					},
					onMessage: event(),
					onDisconnect: event(),
				};
				left.postMessage = (m) =>
					queueMicrotask(() => {
						if (!disconnected) right.onMessage.emit(structuredClone(m));
					});
				right.postMessage = (m) =>
					queueMicrotask(() => {
						if (!disconnected) left.onMessage.emit(structuredClone(m));
					});
				left.disconnect = right.disconnect = () => {
					if (disconnected) return;
					disconnected = true;
					queueMicrotask(() => {
						left.onDisconnect.emit();
						right.onDisconnect.emit();
					});
				};
				queueMicrotask(() => onConnect.emit(right));
				return left;
			},
		},
		permissions: { contains: async () => permission },
	};
	installNetworkHandler({
		browser,
		authorize: async () => {
			if (!allowed) throw new Error("not granted");
			return { connect };
		},
	});
	return createXhrAPI({
		browser,
		identity: { scriptId: "s", filename: "test.user.js", revision: "r" },
		baseURL: `${base}/`,
	});
}

test("@connect uses hostname boundaries, self, IDN and explicit HTTP(S) constraints", () => {
	assert.doesNotThrow(() =>
		assertConnect("https://api.example.com/a", "https://page.test", [
			"example.com",
		]),
	);
	assert.doesNotThrow(() =>
		assertConnect("https://例子.测试/a", "https://page.test", ["例子.测试"]),
	);
	assert.doesNotThrow(() =>
		assertConnect("https://page.test:8443", "https://page.test", ["self"]),
	);
	assert.throws(
		() =>
			assertConnect("https://example.com.evil.test", "https://page.test", [
				"example.com",
			]),
		/@connect/,
	);
	assert.throws(
		() =>
			assertConnect("https://evil-example.com", "https://page.test", [
				"example.com",
			]),
		/@connect/,
	);
	for (const url of [
		"file:///etc/passwd",
		"data:text/plain,hi",
		"javascript:alert(1)",
		"https://user:pass@example.com",
	])
		assert.throws(() => assertConnect(url, "https://page.test", ["*"]));
});

test("real GET/POST/PUT/PATCH/DELETE responses, JSON, headers and text body", async () => {
	const api = transport();
	for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
		const response = await api.xmlHttpRequest({
			url: `${base}/echo`,
			method,
			data: method === "GET" ? undefined : "hello",
			headers: { "x-test": "value" },
			responseType: "json",
		});
		assert.equal(response.status, 200);
		assert.equal(response.response.method, method);
		assert.equal(response.response.body, method === "GET" ? "" : "hello");
		assert.equal(response.response.header, "value");
		assert.match(response.responseHeaders, /content-type/);
	}
});

test("legacy callback is real and control is synchronous, binary response works", async () => {
	const api = transport();
	await new Promise((resolve, reject) => {
		const control = api.GM_xmlhttpRequest({
			url: `${base}/echo`,
			responseType: "arraybuffer",
			onload: (response) => {
				assert.ok(response.response instanceof ArrayBuffer);
				resolve();
			},
			onerror: reject,
		});
		assert.equal(typeof control.abort, "function");
		assert.equal(control instanceof Promise, false);
	});
});

test("native grants, Safari host permission and @connect are all independently enforced", async () => {
	await assert.rejects(
		transport({ allowed: false }).xmlHttpRequest({ url: `${base}/echo` }),
		/not granted/,
	);
	await assert.rejects(
		transport({ permission: false }).xmlHttpRequest({ url: `${base}/echo` }),
		/Safari host permission/,
	);
	await assert.rejects(
		transport({ origin: "https://different.test" }).xmlHttpRequest({
			url: `${base}/echo`,
		}),
		/@connect/,
	);
	const response = await transport({
		origin: "https://different.test",
		connect: ["127.0.0.1"],
	}).xmlHttpRequest({ url: `${base}/echo` });
	assert.equal(response.status, 200);
});

test("redirect rejection never follows to an unauthorized endpoint", async () => {
	const before = secretHits;
	await assert.rejects(transport().xmlHttpRequest({ url: `${base}/redirect` }));
	assert.equal(secretHits, before);
	await assert.rejects(
		transport().xmlHttpRequest({ url: `${base}/echo`, redirect: "follow" }),
		/Redirect/,
	);
});

test("timeout and abort reject Promise and call corresponding handlers", async () => {
	let timedOut = 0,
		aborted = 0;
	await assert.rejects(
		transport().xmlHttpRequest({
			url: `${base}/slow`,
			timeout: 20,
			ontimeout: () => timedOut++,
		}),
	);
	assert.equal(timedOut, 1);
	const request = transport().xmlHttpRequest({
		url: `${base}/slow`,
		onabort: () => aborted++,
	});
	request.abort();
	await assert.rejects(request, /aborted/);
	assert.equal(aborted, 1);
	assert.doesNotThrow(() => request.abort());
});

test("progress is emitted from consumed bytes; unsupported features fail explicitly", async () => {
	let bytes = 0;
	await transport().xmlHttpRequest({
		url: `${base}/echo`,
		onprogress: (event) => (bytes += event.loaded),
	});
	assert.ok(bytes > 0);
	for (const options of [
		{ responseType: "stream" },
		{ upload: {} },
		{ headers: { Cookie: "private" } },
		{ method: "TRACE" },
	])
		await assert.rejects(
			transport().xmlHttpRequest({ url: `${base}/echo`, ...options }),
		);
});

test("transport body decoding retains binary and form contents", async () => {
	assert.deepEqual(
		[...requestBody({ type: "ArrayBufferView", data: [1, 2] })],
		[1, 2],
	);
	assert.equal(
		await requestBody({
			type: "Blob",
			data: [65, 66],
			mime: "text/plain",
		}).text(),
		"AB",
	);
	const form = requestBody({ type: "FormData", data: [["field", "value"]] });
	assert.equal(form.get("field"), "value");
});
