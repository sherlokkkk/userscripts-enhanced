import test from "node:test";
import assert from "node:assert/strict";
import { createUpdateService } from "../src/ext/background/updates.js";

function setup({ auto = false, fail = false, expanded = false } = {}) {
	const data = { US_SCRIPTS_UPDATE_AUTOMATION: auto },
		alarms = new Map(),
		requests = [];
	let clock = 1000000,
		days = 7,
		active = true;
	const browser = {
		storage: {
			local: {
				get: async () => structuredClone(data),
				set: async (items) => Object.assign(data, structuredClone(items)),
				remove: async (key) => {
					delete data[key];
				},
			},
			onChanged: { addListener() {} },
		},
		alarms: {
			get: async (name) => alarms.get(name),
			create: async (name, options) => alarms.set(name, options),
			clear: async (name) => alarms.delete(name),
			onAlarm: { addListener() {} },
		},
	};
	const native = async (message) => {
		requests.push(message);
		if (message.name === "PAGE_ALL_FILES")
			return [{ filename: "a.user.js", canUpdate: true }];
		if (message.name === "UE_DATA_CHECK_UPDATE")
			return fail
				? { error: "network unavailable" }
				: {
						filename: "a.user.js",
						currentVersion: "1",
						remoteVersion: "2",
						available: true,
					};
		if (message.name === "UE_DATA_PREPARE_UPDATE")
			return {
				id: "candidate",
				revision: "revision",
				changes: expanded ? [{ key: "grant" }] : [],
			};
		if (message.name === "UE_DATA_APPLY_UPDATE")
			return { transactionId: "undo-id" };
		throw new Error("Unexpected native operation");
	};
	const service = createUpdateService({
		browser,
		native,
		intervalDays: async () => days,
		enabled: async () => active,
		now: () => clock,
	});
	return {
		service,
		data,
		alarms,
		requests,
		advance: (ms) => (clock += ms),
		stop: () => {
			active = false;
		},
		interval: (value) => (days = value),
	};
}

test("scheduled checks use alarms, never popup polling, and respect never/disabled settings", async () => {
	const t = setup();
	await t.service.configure();
	assert.equal(t.alarms.get("UE_UPDATE_CHECK").periodInMinutes, 7 * 24 * 60);
	assert.equal(t.requests.length, 0);
	t.interval(0);
	await t.service.configure();
	assert.equal(t.alarms.size, 0);
	t.interval(1);
	await t.service.configure();
	t.stop();
	await t.service.configure();
	assert.equal(t.alarms.size, 0);
});

test("default checks report updates without applying code; concurrent requests share one job", async () => {
	const t = setup();
	const first = t.service.check(),
		second = t.service.check();
	assert.equal(first, second);
	const states = await first;
	assert.equal(states["a.user.js"].available, true);
	assert.equal(
		t.requests.filter((message) => message.name === "PAGE_ALL_FILES").length,
		1,
	);
	assert.equal(
		t.requests.some((message) => message.name === "UE_DATA_APPLY_UPDATE"),
		false,
	);
});

test("opt-in automatic updates only apply exact candidates with unchanged declarations", async () => {
	const safe = setup({ auto: true });
	await safe.service.check();
	assert.equal(safe.data.UE_LAST_TRANSACTION, "undo-id");
	assert.equal(safe.data.UE_UPDATES["a.user.js"].applied, true);
	const expanded = setup({ auto: true, expanded: true });
	await expanded.service.check();
	assert.equal(expanded.data.UE_UPDATES["a.user.js"].needsApproval, true);
	assert.equal(
		expanded.requests.some(
			(message) => message.name === "UE_DATA_APPLY_UPDATE",
		),
		false,
	);
});

test("failed downloads retain originals, back off and retry only when due", async () => {
	const t = setup({ fail: true });
	await t.service.check();
	assert.equal(t.data.UE_UPDATES["a.user.js"].failures, 1);
	assert.ok(t.alarms.has("UE_UPDATE_RETRY"));
	const count = t.requests.filter(
		(message) => message.name === "UE_DATA_CHECK_UPDATE",
	).length;
	await t.service.check(true);
	assert.equal(
		t.requests.filter((message) => message.name === "UE_DATA_CHECK_UPDATE")
			.length,
		count,
	);
	t.advance(3600000);
	await t.service.check(true);
	assert.equal(t.data.UE_UPDATES["a.user.js"].failures, 2);
	assert.equal(
		t.requests.some((message) => message.name === "UE_DATA_APPLY_UPDATE"),
		false,
	);
});
