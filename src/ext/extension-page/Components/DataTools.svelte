<script>
	import { sendNativeMessage } from "@ext/native.js";
	import { downloadToFile, parse } from "@ext/utils.js";
	import {
		validateBackup,
		collectBackupStorage,
		planStorageRestore,
		applyStorageRestore,
		rollbackStorageRestore,
	} from "../../shared/backup.js";
	import { items } from "../store.js";
	let busy = false;
	let status = "";
	let backup;
	let preview;
	let candidate;
	let undo;
	let previousStorage;
	let selected = "";
	let autoApply = false;
	let updateStates = {};
	let input;
	let installURL = "";

	async function native(message) {
		const response = await sendNativeMessage(message);
		if (!response || response.error)
			throw new Error(response?.error ?? "Native host did not respond");
		return response;
	}
	async function action(work) {
		if (busy) return;
		busy = true;
		status = "Working…";
		try {
			await work();
		} catch (error) {
			status = String(error.message ?? error);
		} finally {
			busy = false;
		}
	}
	async function refresh() {
		items.set(await native({ name: "PAGE_ALL_FILES" }));
	}
	function toggleAll(enable) {
		action(async () => {
			let count = 0;
			for (const item of $items.filter(
				(item) => !item.temp && Boolean(item.disabled) === enable,
			)) {
				await native({ name: "TOGGLE_ITEM", item });
				if (!enable)
					await browser.runtime.sendMessage({
						name: "UE_MENU_INVALIDATE",
						filename: item.filename,
					});
				count++;
			}
			await refresh();
			status = `${enable ? "Enabled" : "Disabled"} ${count} scripts. Reload affected pages.`;
		});
	}

	function exportBackup() {
		action(async () => {
			const data = await native({ name: "UE_DATA_EXPORT" });
			if (!data.scripts.length) throw new Error("No scripts to export");
			const local = await browser.storage.local.get(null);
			const archive = {
				...data,
				...collectBackupStorage(local, data.scripts),
				createdAt: new Date().toISOString(),
			};
			await downloadToFile(
				`userscripts-enhanced-${new Date().toISOString().slice(0, 10)}.json`,
				JSON.stringify(archive, null, 2),
				"application/json",
			);
			status = "Backup download requested. Check Safari Downloads.";
		});
	}
	function previewURL() {
		action(async () => {
			preview = undefined;
			candidate = undefined;
			const url = new URL(installURL);
			if (
				url.username ||
				url.password ||
				(url.protocol !== "https:" &&
					!(
						url.protocol === "http:" &&
						["localhost", "127.0.0.1"].includes(url.hostname)
					))
			)
				throw new Error("Use an HTTPS script URL, or the local test server");
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 15000);
			let content;
			try {
				const response = await fetch(url, {
					redirect: "error",
					signal: controller.signal,
					credentials: "omit",
				});
				if (!response.ok)
					throw new Error(`Download failed: HTTP ${response.status}`);
				const reader = response.body?.getReader();
				if (!reader) content = await response.text();
				else {
					const chunks = [];
					let size = 0;
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						size += value.length;
						if (size > 10_000_000) {
							controller.abort();
							throw new Error("Script exceeds 10 MB");
						}
						chunks.push(value);
					}
					const bytes = new Uint8Array(size);
					let offset = 0;
					for (const chunk of chunks) {
						bytes.set(chunk, offset);
						offset += chunk.length;
					}
					content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				}
			} finally {
				clearTimeout(timeout);
			}
			const parsed = parse(content);
			if (!parsed)
				throw new Error("Downloaded file has no valid userscript header");
			if (!parsed.metadata.updateURL && !parsed.metadata.downloadURL)
				content = content.replace(
					"// ==/UserScript==",
					`// @downloadURL ${url.href}\n// ==/UserScript==`,
				);
			let name = parsed.metadata.name[0]
				.replace(/[\\/:]/g, "_")
				.replace(/^\./, "_");
			while (new TextEncoder().encode(name).length > 180)
				name = [...name].slice(0, -1).join("");
			const namespace = parsed.metadata.namespace?.[0] ?? "";
			const digest = namespace
				? [
						...new Uint8Array(
							await crypto.subtle.digest(
								"SHA-256",
								new TextEncoder().encode(namespace),
							),
						),
					]
						.map((byte) => byte.toString(16).padStart(2, "0"))
						.join("")
						.slice(0, 10)
				: "";
			const existing = $items.find(
				(item) =>
					item.name === parsed.metadata.name[0] &&
					(item.metadata?.namespace?.[0] ?? "") === namespace,
			);
			const filename =
				existing?.filename ?? `${name}${digest ? ` [${digest}]` : ""}.user.js`;
			backup = validateBackup({
				format: "userscripts-enhanced",
				version: 1,
				sourceOnly: true,
				scripts: [
					{
						filename,
						scriptId: existing?.scriptId ?? crypto.randomUUID(),
						content,
						disabled: true,
					},
				],
				values: {},
				settings: {},
			});
			preview = await native({ name: "UE_DATA_PREVIEW", backup });
			status = `Downloaded from ${url.href}. Review metadata before confirming installation.`;
		});
	}

	function readFiles(event) {
		const files = [...event.target.files];
		action(async () => {
			candidate = undefined;
			preview = undefined;
			undo = undefined;
			if (files.length === 1 && files[0].name.endsWith(".json")) {
				if (files[0].size > 75_000_000)
					throw new Error("Backup file exceeds 75 MB");
				backup = validateBackup(JSON.parse(await files[0].text()));
			} else {
				const scripts = [];
				for (const file of files) {
					if (file.size > 10_000_000)
						throw new Error("Script file exceeds 10 MB");
					const content = await file.text();
					if (!parse(content))
						throw new Error(`Invalid script header: ${file.name}`);
					scripts.push({
						filename: file.name,
						scriptId:
							$items.find((item) => item.filename === file.name)?.scriptId ??
							crypto.randomUUID(),
						content,
						disabled: true,
					});
				}
				backup = validateBackup({
					format: "userscripts-enhanced",
					sourceOnly: true,
					version: 1,
					scripts,
					values: {},
					settings: {},
				});
			}
			preview = await native({ name: "UE_DATA_PREVIEW", backup });
			status =
				"Review the source, permissions and conflicts below. Imported files start disabled; backups retain their saved states.";
		});
	}
	function restore() {
		action(async () => {
			previousStorage = planStorageRestore(
				await browser.storage.local.get(null),
				backup,
			);
			const result = await native({
				name: "UE_DATA_RESTORE",
				backup,
				revision: preview.revision,
			});
			undo = result.transactionId;
			try {
				await applyStorageRestore(browser.storage.local, previousStorage);
			} catch (error) {
				await native({ name: "UE_DATA_ROLLBACK", id: undo });
				undo = undefined;
				throw error;
			}
			await browser.storage.local.set({
				UE_LAST_TRANSACTION: undo,
				UE_LAST_STORAGE_PLAN: previousStorage,
			});
			await browser.runtime.sendMessage({ name: "UE_MENU_INVALIDATE" });
			await refresh();
			preview = undefined;
			status =
				"Import completed. Reload affected pages. Previous sources are retained in a recovery transaction.";
		});
	}
	async function checkAll() {
		await action(async () => {
			const result = await browser.runtime.sendMessage({
				name: "UE_UPDATE_CHECK",
			});
			if (!result?.ok) throw new Error(result?.error ?? "Update check failed");
			updateStates = result.states;
			status = "Update checks completed. Expanded permissions require review.";
		});
	}
	function setAutoApply(event) {
		autoApply = event.currentTarget.checked;
		action(async () => {
			await browser.storage.local.set({
				US_SCRIPTS_UPDATE_AUTOMATION: autoApply,
			});
			status = autoApply
				? "Automatic updates enabled for unchanged declarations. Pages require reload after updates."
				: "Updates will require manual approval.";
		});
	}
	function reviewUpdate() {
		action(async () => {
			preview = undefined;
			candidate = await native({
				name: "UE_DATA_PREPARE_UPDATE",
				filename: selected,
			});
			status = "Review the exact downloaded candidate before applying.";
		});
	}
	function applyUpdate() {
		action(async () => {
			const result = await native({
				name: "UE_DATA_APPLY_UPDATE",
				id: candidate.id,
				revision: candidate.revision,
			});
			undo = result.transactionId;
			await browser.storage.local.set({ UE_LAST_TRANSACTION: undo });
			await browser.storage.local.remove("UE_LAST_STORAGE_PLAN");
			previousStorage = undefined;
			candidate = undefined;
			await refresh();
			status =
				"Update applied. Reload the page to execute the new version. Previous version retained for rollback.";
		});
	}
	function rollback() {
		action(async () => {
			if (previousStorage)
				await rollbackStorageRestore(browser.storage.local, previousStorage);
			try {
				await native({ name: "UE_DATA_ROLLBACK", id: undo });
			} catch (error) {
				if (previousStorage)
					await applyStorageRestore(browser.storage.local, previousStorage);
				throw error;
			}
			undo = undefined;
			await browser.storage.local.remove([
				"UE_LAST_TRANSACTION",
				"UE_LAST_STORAGE_PLAN",
			]);
			await refresh();
			status = "Previous sources restored. Reload affected pages.";
		});
	}
	browser.storage.local
		.get([
			"UE_LAST_TRANSACTION",
			"UE_LAST_STORAGE_PLAN",
			"US_SCRIPTS_UPDATE_AUTOMATION",
			"UE_UPDATES",
		])
		.then((saved) => {
			undo = saved.UE_LAST_TRANSACTION;
			previousStorage = saved.UE_LAST_STORAGE_PLAN;
			autoApply = saved.US_SCRIPTS_UPDATE_AUTOMATION === true;
			updateStates = saved.UE_UPDATES ?? {};
		});
</script>

<div class="data-tools" aria-busy={busy}>
	<h1>Data &amp; Updates</h1>
	<p>Userscripts Enhanced · independent storage</p>
	<div class="actions">
		<button disabled={busy} on:click={exportBackup}
			>Export scripts, settings &amp; values</button
		>
		<button
			disabled={busy}
			on:click={() => input.click()}
			on:dragover|preventDefault
			on:drop|preventDefault={(event) =>
				readFiles({ target: { files: event.dataTransfer.files } })}
			>Import or drop files…</button
		>
		<input
			bind:this={input}
			type="file"
			accept=".json,.user.js,.user.css"
			multiple
			on:change={readFiles}
		/>
	</div>
	<div class="actions">
		<input
			class="url"
			type="url"
			aria-label="Userscript URL"
			placeholder="https://…/script.user.js"
			bind:value={installURL}
		/><button disabled={busy || !installURL} on:click={previewURL}
			>Preview URL install</button
		>
	</div>
	<p class="note">
		JSON v1 contains source and script data. Dependency caches and browser
		permissions are not included. Keep a separate copy of your original scripts.
	</p>
	{#if preview}
		<h2>Import preview · {preview.entries.length} scripts</h2>
		{#each preview.entries as entry (entry.filename)}
			<details>
				<summary
					>{entry.filename} · {entry.overwrite
						? "Replace existing file"
						: "New file"} · {entry.disabled ? "Disabled" : "Enabled"}</summary
				>
				{#each Object.entries(entry.metadata) as [key, values] (key)}<p>
						<b>@{key}</b>
						{values.join(" · ")}
					</p>{/each}
			</details>
		{/each}
		<p>
			Scripts can read and modify matched pages. Confirm only sources you trust.
			{backup.sourceOnly
				? "Source import preserves existing script values."
				: "Restoring replaces the listed script values and saved settings."}
		</p>
		<button disabled={busy} on:click={restore}
			>Confirm import of these scripts and data</button
		>
	{/if}
	<h2>Batch management</h2>
	<div class="actions">
		<button disabled={busy} on:click={() => toggleAll(true)}
			>Enable all scripts</button
		><button disabled={busy} on:click={() => toggleAll(false)}
			>Disable all scripts</button
		>
	</div>
	<h2>Updates</h2>
	<label class="automatic"
		><input
			type="checkbox"
			bind:checked={autoApply}
			disabled={busy}
			on:change={setAutoApply}
		/> Automatically apply updates only when declared permissions and dependencies
		remain unchanged</label
	>
	<p class="note">
		The check interval is configured in Settings. Network errors retry with
		backoff. Pages need a reload after an applied update.
	</p>
	<button disabled={busy} on:click={checkAll}>Check all scripts</button>
	{#each Object.values(updateStates) as state (state.filename)}
		<p>
			{state.filename}: {state.error ??
				(state.applied
					? "Updated · reload pages"
					: state.available
						? `${state.currentVersion} → ${state.remoteVersion}`
						: "Up to date")}
		</p>
	{/each}
	<h2>Review an update</h2>
	<div class="actions">
		<select bind:value={selected} aria-label="Script to check for updates"
			><option value="">Choose a script</option
			>{#each $items.filter((item) => !item.temp) as item (item.filename)}<option
					value={item.filename}>{item.name}</option
				>{/each}</select
		>
		<button disabled={busy || !selected} on:click={reviewUpdate}
			>Download update for review</button
		>
	</div>
	{#if candidate}
		<p><b>{candidate.fromVersion} → {candidate.toVersion}</b></p>
		<p class="source">{candidate.url}</p>
		{#if candidate.changes.length}<h3>
				Permissions and dependency changes
			</h3>{:else}<p>No declared permission or dependency changes.</p>{/if}
		{#each candidate.changes as change (change.key)}<div class="change">
				<b>@{change.key}</b>
				<p>Before: {change.before.join(" · ") || "—"}</p>
				<p>After: {change.after.join(" · ") || "—"}</p>
			</div>{/each}
		<button disabled={busy} on:click={applyUpdate}
			>Approve this exact update</button
		>
	{/if}
	{#if undo}<button disabled={busy} on:click={rollback}
			>Roll back last import or update</button
		>{/if}
	<p class="status" role="status" aria-live="polite">{status}</p>
</div>

<style>
	input.url {
		flex: 1;
		min-width: 16rem;
		font: inherit;
		padding: 0.5rem;
		background: var(--color-bg-primary);
		color: inherit;
		border: 1px solid var(--border-color);
		border-radius: 0.375rem;
	}

	.automatic {
		display: flex;
		align-items: start;
		gap: 0.5rem;
		line-height: 1.5;
	}

	.data-tools {
		box-sizing: border-box;
		color: var(--text-color-primary);
		max-width: 54rem;
		min-width: min(44rem, 85vw);
		padding: 2rem;
	}

	h1 {
		font-size: 1.75rem;
		font-weight: 600;
		margin-bottom: 0.5rem;
	}

	h2 {
		font-size: 1.125rem;
		font-weight: 600;
		margin: 1.5rem 0 0.75rem;
	}

	h3 {
		font-weight: 600;
		margin: 1rem 0;
	}

	p {
		line-height: 1.6;
		margin: 0.5rem 0;
		overflow-wrap: anywhere;
	}

	.actions {
		align-items: center;
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin: 1rem 0;
	}

	button,
	select {
		background: var(--color-bg-primary);
		border: 1px solid var(--border-color);
		border-radius: 0.375rem;
		color: inherit;
		font: inherit;
		padding: 0.5rem 0.75rem;
	}

	button:focus-visible,
	select:focus-visible {
		outline: 2px solid var(--color-blue);
		outline-offset: 2px;
	}

	button:disabled {
		opacity: 0.5;
	}

	input[type="file"] {
		display: none;
	}

	details,
	.change {
		border-bottom: 1px solid var(--border-color);
		padding: 0.75rem 0;
	}

	summary {
		cursor: pointer;
	}

	.note,
	.source {
		color: var(--text-color-secondary);
		font-size: 0.875rem;
	}

	.status {
		color: var(--color-blue);
		margin-top: 1rem;
	}
</style>
