export function createUpdateService({
	browser,
	native,
	intervalDays,
	enabled,
	now = Date.now,
}) {
	let running;
	const alarmName = "UE_UPDATE_CHECK";
	const retryName = "UE_UPDATE_RETRY";
	async function configure() {
		if (!browser.alarms) return;
		const days = await intervalDays();
		if (!(await enabled()) || !Number.isFinite(days) || days <= 0) {
			await browser.alarms.clear(alarmName);
			await browser.alarms.clear(retryName);
			return;
		}
		const periodInMinutes = Math.max(360, days * 24 * 60);
		const existing = await browser.alarms.get(alarmName);
		if (existing?.periodInMinutes !== periodInMinutes)
			await browser.alarms.create(alarmName, {
				delayInMinutes: periodInMinutes,
				periodInMinutes,
			});
	}
	async function work(retryOnly) {
		const saved = await browser.storage.local.get([
			"UE_UPDATES",
			"US_SCRIPTS_UPDATE_AUTOMATION",
		]);
		const states = Object.assign(Object.create(null), saved.UE_UPDATES ?? {});
		const files = await native({ name: "PAGE_ALL_FILES" });
		if (!Array.isArray(files))
			throw new Error(
				files?.error ?? "Could not enumerate scripts for update checks",
			);
		const live = new Set(files.map((file) => file.filename));
		for (const key of Object.keys(states))
			if (!live.has(key)) delete states[key];
		for (const file of files) {
			if (!file.canUpdate || file.temp) continue;
			if (
				retryOnly &&
				(!states[file.filename]?.error || states[file.filename].retryAt > now())
			)
				continue;
			const priorFailures = states[file.filename]?.failures ?? 0;
			try {
				const result = await native({
					name: "UE_DATA_CHECK_UPDATE",
					filename: file.filename,
				});
				if (result.error) throw new Error(result.error);
				states[file.filename] = { ...result, checkedAt: now(), failures: 0 };
				if (
					result.available &&
					saved.US_SCRIPTS_UPDATE_AUTOMATION === true &&
					(await enabled())
				) {
					const candidate = await native({
						name: "UE_DATA_PREPARE_UPDATE",
						filename: file.filename,
					});
					if (candidate.error) throw new Error(candidate.error);
					if (candidate.changes.length === 0) {
						const applied = await native({
							name: "UE_DATA_APPLY_UPDATE",
							id: candidate.id,
							revision: candidate.revision,
						});
						if (applied.error) throw new Error(applied.error);
						await browser.storage.local.set({
							UE_LAST_TRANSACTION: applied.transactionId,
							UE_LAST_AUTO_UPDATE: now(),
						});
						await browser.storage.local.remove("UE_LAST_STORAGE_PLAN");
						states[file.filename].applied = true;
						states[file.filename].available = false;
					} else states[file.filename].needsApproval = true;
				}
			} catch (error) {
				const failures = priorFailures + 1;
				states[file.filename] = {
					filename: file.filename,
					checkedAt: now(),
					failures,
					error: String(error.message ?? error),
					retryAt: now() + Math.min(24, 2 ** (failures - 1)) * 3600000,
				};
			}
		}
		await browser.storage.local.set({
			UE_UPDATES: states,
			US_SCRIPTS_UPDATE_CHECK_LASTTIME: now(),
		});
		const retries = Object.values(states)
			.filter((state) => state.error)
			.map((state) => state.retryAt);
		if (browser.alarms && (await enabled())) {
			if (retries.length)
				await browser.alarms.create(retryName, {
					when: Math.max(now() + 60000, Math.min(...retries)),
				});
			else await browser.alarms.clear(retryName);
		}
		return states;
	}
	function check(retryOnly = false) {
		if (!running)
			running = work(retryOnly).finally(() => {
				running = undefined;
			});
		return running;
	}
	browser.alarms?.onAlarm.addListener((alarm) => {
		if (![alarmName, retryName].includes(alarm.name)) return;
		return enabled()
			.then((active) => (active ? check(alarm.name === retryName) : undefined))
			.catch((error) => console.error("Update check failed", error));
	});
	browser.storage.onChanged.addListener((changes, area) => {
		if (
			area === "local" &&
			(changes.US_SCRIPTS_UPDATE_CHECK_INTERVAL || changes.US_GLOBAL_ACTIVE)
		)
			configure().catch((error) =>
				console.error("Update schedule unavailable", error),
			);
	});
	configure().catch((error) =>
		console.error("Update schedule unavailable", error),
	);
	return { check, configure };
}
