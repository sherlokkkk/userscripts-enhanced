import test from "node:test";
import assert from "node:assert/strict";
import {
	validateBackup,
	collectBackupStorage,
	planStorageRestore,
	applyStorageRestore,
	rollbackStorageRestore,
} from "../src/ext/shared/backup.js";
const id = "cf05d460-51bc-42a1-9c7e-c5ac519cdb57";
const key = `UE_VALUE:${id}:speed`;
const backup = () => ({
	format: "userscripts-enhanced",
	version: 1,
	scripts: [
		{
			filename: "Test.user.js",
			scriptId: id,
			disabled: true,
			content: "// ==UserScript==\n// @name Test\n// ==/UserScript==\n",
		},
	],
	values: { [key]: { v: 1, data: 1.5, writer: "saved" } },
	settings: { US_THEME_MODE: "dark" },
});
function memory(initial) {
	const data = structuredClone(initial);
	let failOnce = false;
	return {
		data,
		fail: () => (failOnce = true),
		get: async () => structuredClone(data),
		remove: async (keys) => {
			for (const k of keys) delete data[k];
		},
		set: async (items) => {
			if (failOnce) {
				failOnce = false;
				throw new Error("quota");
			}
			Object.assign(data, structuredClone(items));
		},
	};
}

test("versioned backup keeps only script values and supported settings", () => {
	const data = backup();
	assert.equal(validateBackup(data), data);
	const storage = collectBackupStorage(
		{
			[key]: data.values[key],
			"UE_VALUE:other:private": { v: 1 },
			US_ERROR_NATIVE: "secret",
			US_THEME_MODE: "auto",
		},
		data.scripts,
	);
	assert.deepEqual(Object.keys(storage.values), [key]);
	assert.equal(storage.settings.US_THEME_MODE, "auto");
	assert.equal(storage.settings.US_ERROR_NATIVE, undefined);
	assert.equal(storage.settings.US_EDITOR_TAB_SIZE !== undefined, true);
});

test("invalid formats, path traversal, duplicates and cross-script data are rejected", () => {
	for (const filename of [
		"../a.user.js",
		"/tmp/a.user.js",
		"a\\b.user.js",
		".hidden.user.js",
		"a\0.user.js",
	]) {
		const value = backup();
		value.scripts[0].filename = filename;
		assert.throws(() => validateBackup(value));
	}
	for (const mutate of [
		(b) => (b.version = 2),
		(b) => b.scripts.push(b.scripts[0]),
		(b) => (b.values["UE_VALUE:other:secret"] = { v: 1 }),
		(b) => (b.settings.US_ERROR_NATIVE = "x"),
		(b) => (b.scripts[0].content = "invalid"),
	]) {
		const value = backup();
		mutate(value);
		assert.throws(() => validateBackup(value));
	}
});

test("storage restore and rollback preserve unrelated scripts and newer unrelated writes", async () => {
	const b = backup();
	const storage = memory({
		[key]: { v: 1, data: 1 },
		other: "before",
		US_THEME_MODE: "light",
	});
	const plan = planStorageRestore(storage.data, b);
	await applyStorageRestore(storage, plan);
	assert.equal(storage.data[key].data, 1.5);
	storage.data.other = "newer";
	await rollbackStorageRestore(storage, plan);
	assert.equal(storage.data[key].data, 1);
	assert.equal(storage.data.other, "newer");
	assert.equal(storage.data.US_THEME_MODE, "light");
});

test("storage failure restores previous values instead of reporting success", async () => {
	const storage = memory({ [key]: { v: 1, data: 1 }, other: 5 });
	const before = structuredClone(storage.data);
	const plan = planStorageRestore(storage.data, backup());
	storage.fail();
	await assert.rejects(applyStorageRestore(storage, plan), /quota/);
	assert.deepEqual(storage.data, before);
});

test("preview and undo refuse to overwrite changed target values", async () => {
	const storage = memory({ [key]: { v: 1, data: 1 } });
	const plan = planStorageRestore(storage.data, backup());
	storage.data[key].data = 2;
	await assert.rejects(applyStorageRestore(storage, plan), /changed/);
	const current = planStorageRestore(storage.data, backup());
	await applyStorageRestore(storage, current);
	storage.data[key].data = 3;
	await assert.rejects(rollbackStorageRestore(storage, current), /changed/);
	assert.equal(storage.data[key].data, 3);
});

test("source-only imports preserve values and preferences", async () => {
	const storage = memory({ [key]: { v: 1, data: 99 }, US_THEME_MODE: "light" });
	const before = structuredClone(storage.data);
	const data = backup();
	data.sourceOnly = true;
	const plan = planStorageRestore(storage.data, data);
	await applyStorageRestore(storage, plan);
	assert.deepEqual(storage.data, before);
});
