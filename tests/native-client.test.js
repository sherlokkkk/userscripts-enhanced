import test from "node:test";
import assert from "node:assert/strict";
import { createNativeClient } from "../src/ext/shared/native-client.js";

test("native client returns actual responses and preserves application and message", async () => {
	const message = { name: "REQ_PLATFORM" };
	const send = createNativeClient({
		sendNativeMessage: async (app, value) => {
			assert.equal(app, "application");
			assert.equal(value, message);
			return { platform: "macos" };
		},
	});
	assert.deepEqual(await send(message), { platform: "macos" });
});
test("rejections, synchronous throws and empty native responses become actionable failures", async () => {
	for (const sendNativeMessage of [
		() => {
			throw Error("helper refused");
		},
		async () => {
			throw Error("helper refused");
		},
		async () => undefined,
	]) {
		await assert.rejects(
			createNativeClient({ sendNativeMessage })({ name: "PAGE_INIT_DATA" }),
			/Native helper unavailable \(PAGE_INIT_DATA\)/,
		);
	}
});
test("a stuck native startup times out; a late result cannot turn failure into success", async () => {
	let reply;
	const send = createNativeClient(
		{
			sendNativeMessage: () =>
				new Promise((resolve) => {
					reply = resolve;
				}),
		},
		{ startupTimeoutMs: 10 },
	);
	const request = send({ name: "PAGE_INIT_DATA" });
	await assert.rejects(request, /timed out/);
	reply({ success: true });
	await assert.rejects(request, /timed out/);
});
test("native writes are bounded without automatic retry or duplication", async () => {
	let calls = 0;
	const send = createNativeClient(
		{
			sendNativeMessage: () => {
				calls++;
				return new Promise(() => {});
			},
		},
		{ timeoutMs: 10 },
	);
	await assert.rejects(
		send({ name: "PAGE_SAVE" }),
		/operation may still be running/,
	);
	assert.equal(calls, 1);
});
