import { attachPanel } from "./panel-runtime.js";
// Callbacks never leave this document's isolated world. No DOM message bridge.
export class MenuRuntime {
	constructor({ documentId, notify, createEvent = (data) => data }) {
		this.documentId = documentId;
		this.notify = notify;
		this.createEvent = createEvent;
		this.scripts = new Map();
		this.sequence = 0;
		this.suspended = false;
		this.closed = false;
		this.queued = false;
	}

	changed() {
		if (this.queued || this.closed) return;
		this.queued = true;
		queueMicrotask(() => {
			this.queued = false;
			if (!this.closed) this.notify();
		});
	}

	forScript({ scriptId, filename, name, revision }) {
		if (this.scripts.has(scriptId)) return this.scripts.get(scriptId).api;
		const script = {
			scriptId,
			filename,
			name,
			revision,
			commands: new Map(),
			revoked: false,
		};
		const register = (title, callback, options = {}) => {
			if (this.closed || script.revoked)
				throw new Error("Script commands revoked; reload the page");
			if (typeof title !== "string" || !title.trim() || title.length > 512)
				throw new TypeError("Menu name must contain 1–512 characters");
			if (typeof callback !== "function")
				throw new TypeError("Menu callback must be a function");
			if (typeof options === "string") options = { accessKey: options };
			if (!options || typeof options !== "object" || Array.isArray(options))
				throw new TypeError("Invalid menu options");
			if (
				options.id !== undefined &&
				!["string", "number"].includes(typeof options.id)
			)
				throw new TypeError("Invalid menu command ID");
			if (options.clickedFrame !== undefined)
				throw new Error(
					"clickedFrame is unsupported: commands are always frame-specific",
				);
			const requested =
				options.id === undefined ? undefined : String(options.id);
			const previous = script.commands.get(requested);
			if (!previous && script.commands.size >= 200)
				throw new Error("Menu command limit (200 per script)");
			// An unknown options.id creates a new ID, as in Tampermonkey.
			const commandId = previous ? requested : String(++this.sequence);
			const command = {
				commandId,
				title,
				callback,
				registeredAt: previous?.registeredAt ?? Date.now(),
				options: {
					accessKey:
						typeof options.accessKey === "string"
							? options.accessKey.slice(0, 1)
							: "",
					autoClose: options.autoClose !== false,
					title:
						typeof options.title === "string"
							? options.title.slice(0, 1024)
							: "",
				},
				// Updating a running command must not unlock it.
				busy: previous?.busy ?? false,
			};
			script.commands.set(commandId, command);
			this.changed();
			return commandId;
		};
		const unregister = (id) => {
			if (script.commands.delete(String(id))) this.changed();
		};
		const check = () => {
			if (this.closed || script.revoked)
				throw new Error("Script revoked; reload the page");
		};
		script.api = {
			registerPanel: attachPanel({
				script,
				register,
				unregister,
				changed: () => this.changed(),
				check,
			}),
			GM_registerMenuCommand: register,
			GM_unregisterMenuCommand: unregister,
			registerMenuCommand: async (...args) => register(...args),
			unregisterMenuCommand: async (id) => unregister(id),
		};
		this.scripts.set(scriptId, script);
		return script.api;
	}

	// `provider` returns plain shortcut data for the popup (keyboard-runtime).
	setShortcuts(scriptId, provider) {
		const script = this.scripts.get(scriptId);
		if (script) script.shortcuts = provider;
	}

	isRevoked(scriptId) {
		return this.closed || this.scripts.get(scriptId)?.revoked !== false;
	}

	snapshot() {
		const scripts = [];
		if (!this.closed && !this.suspended) {
			for (const {
				scriptId,
				filename,
				name,
				revision,
				commands,
				revoked,
			} of this.scripts.values()) {
				const shortcuts = this.scripts.get(scriptId).shortcuts?.();
				if (
					revoked ||
					(!commands.size &&
						!this.scripts.get(scriptId).panel &&
						!shortcuts?.list?.length)
				)
					continue;
				scripts.push({
					shortcuts: shortcuts?.list?.length
						? structuredClone(shortcuts)
						: undefined,
					scriptId,
					filename,
					name,
					revision,
					panel: this.scripts.get(scriptId).panel
						? structuredClone(this.scripts.get(scriptId).panel)
						: undefined,
					commands: [...commands.values()].map((command) => {
						// Only an explicit data allowlist crosses the extension boundary.
						return {
							commandId: command.commandId,
							panelControl: command.panelControl === true,
							title: command.title,
							registeredAt: command.registeredAt,
							options: command.options,
							busy: command.busy,
						};
					}),
				});
			}
		}
		return { documentId: this.documentId, scripts };
	}

	async execute({ documentId, scriptId, commandId, event = {}, value }) {
		if (this.closed || this.suspended || documentId !== this.documentId)
			return { ok: false, error: "This document is no longer available" };
		const script = this.scripts.get(scriptId);
		const command = script?.commands.get(commandId);
		if (!command || script.revoked)
			return { ok: false, error: "Command was removed; refresh the menu" };
		if (command.busy) return { ok: false, error: "Command is already running" };
		command.busy = true;
		this.changed();
		try {
			const callback = command.callback;
			await callback(
				command.validateValue
					? command.validateValue(value)
					: this.createEvent(event),
			);
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				error: String(error?.message ?? error).slice(0, 2048),
			};
		} finally {
			command.busy = false;
			const current = script.commands.get(commandId);
			if (current) current.busy = false;
			this.changed();
		}
	}

	revoke(filename) {
		for (const script of this.scripts.values()) {
			if (filename !== undefined && script.filename !== filename) continue;
			script.revoked = true;
			script.commands.clear();
			script.panel = undefined;
		}
		this.changed();
	}

	suspend(value) {
		this.suspended = value;
		this.changed();
	}

	dispose() {
		this.closed = true;
		this.scripts.clear();
	}
}
