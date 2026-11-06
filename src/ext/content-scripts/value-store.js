import { copyJSON } from "./json-data.js";
const clone = (value) => (value === undefined ? undefined : copyJSON(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Legacy getters are real synchronous reads from an eagerly hydrated cache.
// Legacy writes are write-behind; modern writes await persistence and reject.
export async function createValueStore({
	scriptId,
	storage,
	changes,
	reportError,
	instanceId = crypto.randomUUID(),
}) {
	if (typeof scriptId !== "string" || !scriptId)
		throw new Error("Missing stable script identity");
	const prefix = `UE_VALUE:${scriptId}:`;
	const cache = new Map();
	const listeners = new Map();
	const versions = new Map();
	let listenerId = 0;
	let disposed = false;
	let queue = Promise.resolve();
	const keyFor = (key) => {
		if (typeof key !== "string")
			throw new TypeError("GM storage key must be a string");
		return prefix + key;
	};
	const publish = (key, before, after, remote) => {
		if (same(before, after)) return;
		for (const listener of listeners.values()) {
			if (listener.key !== key) continue;
			try {
				listener.callback(key, clone(before), clone(after), remote);
			} catch (error) {
				reportError(error);
			}
		}
	};
	const apply = (key, envelope, remote, notify = true) => {
		const previous = cache.get(key);
		if (envelope?.v === 1 && !envelope.deleted)
			cache.set(key, clone(envelope.data));
		else cache.delete(key);
		if (notify) publish(key, previous, cache.get(key), remote);
	};
	const changed = (items, area) => {
		if (area !== "local" || disposed) return;
		for (const [fullKey, change] of Object.entries(items)) {
			if (!fullKey.startsWith(prefix)) continue;
			const key = fullKey.slice(prefix.length);
			const envelope = change.newValue;
			// An earlier queued local write must not revert a later optimistic value.
			if (
				envelope?.writer === instanceId &&
				envelope.seq < (versions.get(key) ?? 0)
			)
				continue;
			apply(key, envelope, envelope?.writer !== instanceId);
		}
	};
	// Subscribe first so changes while hydrating are replayed after the snapshot.
	const buffered = [];
	const buffering = (...args) => buffered.push(args);
	changes.addListener(buffering);
	try {
		const initial = await storage.get(null);
		for (const [key, envelope] of Object.entries(initial)) {
			if (key.startsWith(prefix))
				apply(key.slice(prefix.length), envelope, false, false);
		}
		changes.addListener(changed);
		changes.removeListener(buffering);
		for (const args of buffered) changed(...args);
	} catch (error) {
		changes.removeListener(buffering);
		throw error;
	}
	const write = (key, value, deleted) => {
		if (disposed) throw new Error("Script storage has been disposed");
		const fullKey = keyFor(key);
		const persisted = deleted ? null : copyJSON(value);
		const before = clone(cache.get(key));
		const seq = (versions.get(key) ?? 0) + 1;
		versions.set(key, seq);
		const envelope = {
			v: 1,
			writer: instanceId,
			seq,
			deleted,
			data: persisted,
		};
		apply(key, envelope, false);
		const operation = queue
			.then(() => storage.set({ [fullKey]: envelope }))
			.catch((error) => {
				if (
					versions.get(key) === seq &&
					same(cache.get(key), deleted ? undefined : value)
				) {
					apply(
						key,
						before === undefined ? undefined : { v: 1, data: before },
						false,
					);
				}
				throw error;
			});
		queue = operation.catch(() => {}); // Keep future writes usable after a failed write.
		return operation;
	};
	const get = (key, fallback) => {
		keyFor(key);
		return cache.has(key) ? clone(cache.get(key)) : fallback;
	};
	const api = {
		GM_getValue: get,
		GM_setValue: (key, value) => {
			write(key, value, false).catch(reportError);
		},
		GM_deleteValue: (key) => {
			write(key, null, true).catch(reportError);
		},
		GM_listValues: () => [...cache.keys()],
		GM_addValueChangeListener: (key, callback) => {
			keyFor(key);
			if (typeof callback !== "function")
				throw new TypeError("Value change listener must be a function");
			const id = ++listenerId;
			listeners.set(id, { key, callback });
			return id;
		},
		GM_removeValueChangeListener: (id) => {
			listeners.delete(id);
		},
		getValue: async (key, fallback) => get(key, fallback),
		setValue: async (key, value) => write(key, value, false),
		deleteValue: async (key) => write(key, null, true),
		listValues: async () => [...cache.keys()],
	};
	api.addValueChangeListener = async (...args) =>
		api.GM_addValueChangeListener(...args);
	api.removeValueChangeListener = async (id) =>
		api.GM_removeValueChangeListener(id);
	return {
		api,
		flush: () => queue,
		dispose() {
			disposed = true;
			listeners.clear();
			cache.clear();
			changes.removeListener(changed);
		},
	};
}
