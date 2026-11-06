import { settingsDictionary } from "./settings.js";
import { parseHeader } from "./metadata.js";

const backupSettings = new Map(
	Object.values(settingsDictionary)
		.filter((setting) => setting.group !== "INTERNAL" && !setting.protect)
		.map((setting) => [setting.key, setting]),
);

export function validateBackup(backup) {
	if (
		!backup ||
		backup.format !== "userscripts-enhanced" ||
		backup.version !== 1 ||
		!Array.isArray(backup.scripts)
	)
		throw new Error("Expected a Userscripts Enhanced version 1 JSON backup");
	if (!backup.scripts.length || backup.scripts.length > 500)
		throw new Error("Backup must contain 1–500 scripts");
	const filenames = new Set(),
		identities = new Set();
	let bytes = 0;
	for (const script of backup.scripts) {
		if (
			!script ||
			typeof script.filename !== "string" ||
			!/^[^./\\\0][^/\\\0]*\.(js|css)$/.test(script.filename) ||
			new TextEncoder().encode(script.filename).length > 250
		)
			throw new Error("Invalid script filename in backup");
		if (
			typeof script.scriptId !== "string" ||
			!/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(script.scriptId) ||
			typeof script.disabled !== "boolean"
		)
			throw new Error("Invalid script identity or state in backup");
		if (
			filenames.has(script.filename.toLowerCase()) ||
			identities.has(script.scriptId)
		)
			throw new Error("Duplicate filename or identity in backup");
		filenames.add(script.filename.toLowerCase());
		identities.add(script.scriptId);
		if (typeof script.content !== "string" || !parseHeader(script.content))
			throw new Error(`Invalid userscript header: ${script.filename}`);
		const length = new TextEncoder().encode(script.content).length;
		bytes += length;
		if (length > 10_000_000 || bytes > 50_000_000)
			throw new Error("Backup exceeds the script size limit");
	}
	for (const [key, value] of Object.entries(backup.values ?? {})) {
		if (
			!key.startsWith("UE_VALUE:") ||
			!identities.has(key.split(":")[1]) ||
			value?.v !== 1
		)
			throw new Error("Backup contains data outside its script identities");
	}
	const settings = backup.settings ?? {};
	for (const [key, value] of Object.entries(settings)) {
		const setting = backupSettings.get(key);
		if (
			!setting ||
			typeof value !== setting.type ||
			(setting.values.length && !setting.values.includes(value))
		)
			throw new Error("Backup contains an unsupported setting or value");
		if (Array.isArray(setting.default) && !Array.isArray(value))
			throw new Error("Backup setting requires a list");
	}
	return backup;
}

export function collectBackupStorage(storage, scripts) {
	const identities = new Set(scripts.map((script) => script.scriptId));
	const values = Object.create(null),
		settings = Object.create(null);
	for (const [key, value] of Object.entries(storage)) {
		if (key.startsWith("UE_VALUE:") && identities.has(key.split(":")[1]))
			values[key] = value;
	}
	for (const [key, definition] of backupSettings)
		settings[key] = Object.hasOwn(storage, key)
			? storage[key]
			: structuredClone(definition.default);
	return { values, settings };
}

export function planStorageRestore(storage, backup) {
	const ids = backup.sourceOnly
		? []
		: backup.scripts.map((script) => script.scriptId);
	const prefixes = ids.map((id) => `UE_VALUE:${id}:`);
	const settings = backup.sourceOnly ? [] : Object.keys(backup.settings ?? {});
	const touches = (key) =>
		prefixes.some((prefix) => key.startsWith(prefix)) || settings.includes(key);
	return {
		prefixes,
		settings,
		before: structuredClone(
			Object.fromEntries(
				Object.entries(storage).filter(([key]) => touches(key)),
			),
		),
		after: structuredClone(
			backup.sourceOnly ? {} : { ...backup.values, ...backup.settings },
		),
	};
}

function subset(data, plan) {
	return Object.fromEntries(
		Object.entries(data)
			.filter(
				([key]) =>
					plan.prefixes.some((prefix) => key.startsWith(prefix)) ||
					plan.settings.includes(key),
			)
			.sort(([a], [b]) => a.localeCompare(b)),
	);
}

export async function applyStorageRestore(storage, plan) {
	const now = subset(await storage.get(null), plan);
	if (JSON.stringify(now) !== JSON.stringify(subset(plan.before, plan)))
		throw new Error("Script values changed; preview the restore again");
	try {
		await storage.remove(Object.keys(now));
		await storage.set(plan.after);
	} catch (error) {
		try {
			await storage.remove(
				Object.keys(plan.after).filter(
					(key) => !Object.hasOwn(plan.before, key),
				),
			);
			await storage.set(plan.before);
		} catch (rollback) {
			throw new Error(
				`Storage restore and recovery failed: ${rollback.message}; keep your exported backup`,
			);
		}
		throw error;
	}
}

export async function rollbackStorageRestore(storage, plan) {
	const now = subset(await storage.get(null), plan);
	if (JSON.stringify(now) !== JSON.stringify(subset(plan.after, plan)))
		throw new Error(
			"Script values changed since import; refusing to overwrite newer values",
		);
	await storage.remove(Object.keys(now));
	await storage.set(plan.before);
}
