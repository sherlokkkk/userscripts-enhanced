<script>
	import { onDestroy } from "svelte";
	onDestroy(() => clearTimeout(feedbackTimer));
	export let item;
	export let groups = [];
	export let toggle;
	export let disabled = false;
	export let refresh;
	export let detail = false;
	export let open;
	export let back;
	/** @type {{autoPopup?: boolean, legacyMode?: boolean}} */
	export let preferences = {};
	export let setPreference = async () => {};
	export let openInManager = () => {};
	export let reloadPage = () => {};
	let prefsChanged = false;

	$: metadata = item.metadata ?? {};
	$: grants = metadata.grant ?? [];
	$: injectInto = metadata["inject-into"]?.[0] ?? "auto";
	// Same rule as the content script: "auto" with real grants runs isolated.
	$: pageWorld =
		injectInto === "page" ||
		(injectInto === "auto" &&
			!grants.some((grant) => grant && grant !== "none"));
	$: menuGranted = grants.some((grant) =>
		["GM_registerMenuCommand", "GM.registerMenuCommand"].includes(grant),
	);
	$: autoPopup = preferences?.autoPopup !== false;
	$: legacyMode = preferences?.legacyMode === true;
	$: subtitle = item.disabled
		? "已停用"
		: groups.some((group) => group.panel)
			? "控制面板"
			: groups.length
				? "脚本操作"
				: pageWorld
					? "页面脚本 · 点按查看设置"
					: "暂无工具栏操作 · 点按查看设置";

	async function changeAutoPopup(event) {
		const value = event.currentTarget.checked;
		await setPreference("autoPopup", value);
		prefsChanged = true;
	}
	let confirmLegacy = false;
	async function changeLegacyMode(event) {
		const input = event.currentTarget;
		if (input.checked) {
			// Turning isolation off needs an explicit second step.
			input.checked = false;
			confirmLegacy = true;
			return;
		}
		confirmLegacy = false;
		await setPreference("legacyMode", false);
		prefsChanged = true;
	}
	async function enableLegacyMode() {
		confirmLegacy = false;
		await setPreference("legacyMode", true);
		prefsChanged = true;
	}

	let feedbackTimer;
	let running = "";
	let feedback = "";
	let failed = false;

	async function run(group, command, event, value = undefined) {
		if (running) return;
		running = `${group.frameId}:${command.commandId}`;
		feedback = `Running ${command.title}…`;
		failed = false;
		const slow = setTimeout(() => {
			feedback = "Still running. Closing the popup will not cancel the script.";
		}, 5000);
		try {
			const response = await browser.runtime.sendMessage({
				name: "UE_MENU_RUN",
				tabId: group.tabId,
				frameId: group.frameId,
				documentId: group.documentId,
				scriptId: group.scriptId,
				commandId: command.commandId,
				value,
				event: {
					type: event.type,
					key: event.key,
					altKey: event.altKey,
					ctrlKey: event.ctrlKey,
					metaKey: event.metaKey,
					shiftKey: event.shiftKey,
				},
			});
			if (!response?.ok)
				throw new Error(response?.error ?? "No response from page");
			feedback = "已完成";
			clearTimeout(feedbackTimer);
			feedbackTimer = setTimeout(() => (feedback = ""), 1800);
			if (command.options.autoClose) window.close();
		} catch (error) {
			failed = true;
			feedback = String(error.message ?? error);
		} finally {
			clearTimeout(slow);
			running = "";
			refresh();
		}
	}
</script>

{#if !detail}
	<div class="script-row" class:inactive={item.disabled}>
		<button class="script-link" on:click={open} title={item.name}>
			<span class="script-mark" aria-hidden="true"
				>{item.name.slice(0, 1).toUpperCase()}</span
			>
			<span class="identity"
				><strong>{item.name}</strong><small>{subtitle}</small></span
			>
			<span class="chevron" aria-hidden="true">›</span>
		</button>
		<input
			class="enable"
			type="checkbox"
			role="switch"
			aria-label={`启用 ${item.name}`}
			checked={!item.disabled}
			{disabled}
			on:change={toggle}
		/>
	</div>
{:else}
	<section class="detail">
		<button class="back" on:click={back}>‹ 全部脚本</button>
		<h2>{item.name}</h2>
		{#if item.disabled}<p class="empty">脚本已停用。返回列表开启后刷新网页。</p>
		{:else if !groups.length}<p class="empty">
				{#if pageWorld && !menuGranted}
					此脚本运行在页面环境（@inject-into
					page），没有向工具栏注册操作。它自己的设置窗口只能用脚本内置的方式打开；
					若要在这里显示入口，需要脚本声明 @grant GM_registerMenuCommand
					并注册命令。
				{:else if !menuGranted}
					此脚本没有声明 @grant GM_registerMenuCommand，不会在这里提供操作。
				{:else}
					当前网页上此脚本还没有注册操作（有些脚本只在特定场景注册，例如视频播放时）。新安装或更新脚本后，请刷新网页。
				{/if}
			</p>
		{:else}
			{#each groups as group (`${group.documentId}:${group.scriptId}`)}
				{#if group.frameId !== 0}<p class="frame">
						子页面 · {group.frameId}
					</p>{/if}
				{#if group.panel}
					<div class="control-section">
						<h3>{group.panel.title}</h3>
						{#each group.panel.controls as control (control.id)}
							{@const command = group.commands.find(
								(command) => command.commandId === control.commandId,
							)}
							<div class="control-row">
								{#if control.type === "button"}
									<button
										class="action"
										disabled={disabled ||
											!!running ||
											control.disabled ||
											command?.busy}
										on:click={(event) => run(group, command, event)}
										>{control.label}<span aria-hidden="true">↗</span></button
									>
								{:else if control.type === "text"}<span>{control.label}</span
									><output>{control.value}</output>
								{:else}
									<label for={`${group.documentId}-${control.id}`}
										>{control.label}</label
									>
									{#if control.type === "toggle"}
										<input
											id={`${group.documentId}-${control.id}`}
											type="checkbox"
											role="switch"
											checked={control.value}
											disabled={disabled || !!running || control.disabled}
											on:change={(event) => {
												const value = event.currentTarget.checked;
												event.currentTarget.checked = control.value;
												run(group, command, event, value);
											}}
										/>
									{:else if control.type === "select"}
										<select
											id={`${group.documentId}-${control.id}`}
											value={control.value}
											disabled={disabled || !!running || control.disabled}
											on:change={(event) => {
												const value = event.currentTarget.value;
												event.currentTarget.value = control.value;
												run(group, command, event, value);
											}}
											>{#each control.options as option (option.value)}<option
													value={option.value}>{option.label}</option
												>{/each}</select
										>
									{:else if control.type === "range"}
										<div class="range">
											<input
												id={`${group.documentId}-${control.id}`}
												type="range"
												min={control.min}
												max={control.max}
												step={control.step}
												value={control.value}
												disabled={disabled || !!running || control.disabled}
												on:change={(event) => {
													const value = Number(event.currentTarget.value);
													event.currentTarget.value = String(control.value);
													run(group, command, event, value);
												}}
											/><output>{control.value}</output>
										</div>
									{/if}
								{/if}
							</div>
						{/each}
					</div>
				{/if}
				{#if group.commands.some((command) => !command.panelControl)}
					<div class="control-section">
						{#if group.panel}<h3>其他操作</h3>{/if}
						{#each group.commands.filter((command) => !command.panelControl) as command (command.commandId)}
							<button
								class="action"
								data-ue-access-key={command.options.accessKey.toLowerCase()}
								title={command.options.title}
								disabled={disabled || !!running || command.busy}
								on:click={(event) => run(group, command, event)}
								><span>{command.title}</span><span
									class="chevron"
									aria-hidden="true">›</span
								></button
							>
						{/each}
					</div>
				{/if}
			{/each}
		{/if}
		<div class="control-section settings">
			<h3>脚本设置</h3>
			<div class="control-row">
				<label for={`auto-popup-${item.filename}`}
					>允许自动弹出页面面板<small
						>关闭后，支持此设置的脚本不会根据场景自动弹出窗口，仍可用上方操作手动打开。</small
					></label
				>
				<input
					id={`auto-popup-${item.filename}`}
					type="checkbox"
					role="switch"
					checked={autoPopup}
					{disabled}
					on:change={changeAutoPopup}
				/>
			</div>
			{#if !pageWorld}
				<div class="control-row">
					<label for={`legacy-mode-${item.filename}`}
						>兼容模式（不安全）<small
							>给旧脚本用：以非严格模式运行，可修复“变量未定义”一类错误，但会关闭此脚本的安全隔离。</small
						></label
					>
					<input
						id={`legacy-mode-${item.filename}`}
						type="checkbox"
						role="switch"
						checked={legacyMode}
						{disabled}
						on:change={changeLegacyMode}
					/>
				</div>
				{#if confirmLegacy}
					<div class="warning" role="alert">
						<p>
							兼容模式会关闭此脚本的安全隔离：脚本将能直接使用扩展权限（读取其他脚本的数据、绕过网络授权）。只在你完全信任此脚本、且它在默认模式下出错时开启。
						</p>
						<div class="warning-actions">
							<button class="danger" on:click={enableLegacyMode}
								>仍然开启</button
							>
							<button on:click={() => (confirmLegacy = false)}>取消</button>
						</div>
					</div>
				{/if}
			{/if}
			{#if prefsChanged}
				<button class="action" on:click={reloadPage}
					><span>刷新网页使设置生效</span><span
						class="chevron"
						aria-hidden="true">↻</span
					></button
				>
			{/if}
			<button class="action" on:click={openInManager}
				><span>在管理页中打开此脚本</span><span
					class="chevron"
					aria-hidden="true">↗</span
				></button
			>
			<p class="meta">
				运行环境：{pageWorld
					? "页面（page）"
					: legacyMode
						? "兼容模式（未隔离）"
						: "隔离环境（content）"}{metadata.version?.[0]
					? ` · 版本 ${metadata.version[0]}`
					: ""}
			</p>
		</div>
		{#if feedback}<p
				class="feedback"
				class:error={failed}
				role="status"
				aria-live="polite"
			>
				{feedback}
			</p>{/if}
	</section>
{/if}

<style>
	.script-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border-color);
	}

	.script-link {
		display: flex;
		align-items: center;
		gap: 12px;
		flex: 1;
		min-width: 0;
		background: none;
		color: inherit;
		text-align: left;
	}

	.script-mark {
		display: grid;
		place-items: center;
		flex: 0 0 34px;
		height: 34px;
		border-radius: 9px;
		background: var(--color-bg-primary);
		color: var(--text-color-secondary);
		font-weight: 600;
	}

	.identity {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex: 1;
		min-width: 0;
	}

	.identity strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		font-weight: 600;
	}

	.identity small,
	.chevron,
	.empty,
	.frame {
		color: var(--text-color-secondary);
		font-size: 12px;
	}

	.chevron {
		font-size: 20px;
	}

	.inactive .identity {
		opacity: 0.5;
	}

	input[type="checkbox"] {
		appearance: none;
		width: 30px;
		height: 18px;
		flex-shrink: 0;
		border-radius: 20px;
		background: var(--color-grey);
		position: relative;
		cursor: pointer;
		transition: background 0.15s;
	}

	input[type="checkbox"]::after {
		content: "";
		position: absolute;
		left: 2px;
		top: 2px;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: white;
		box-shadow: 0 1px 3px #0002;
		transition: transform 0.15s;
	}

	input[type="checkbox"]:checked {
		background: var(--color-blue);
	}

	input[type="checkbox"]:checked::after {
		transform: translateX(12px);
	}

	.detail {
		padding: 12px 16px 20px;
	}

	.back {
		color: var(--color-blue);
		background: none;
		font-size: 13px;
		padding: 4px 0 12px;
	}

	h2 {
		font-size: 17px;
		font-weight: 600;
		line-height: 1.4;
		margin: 0 0 16px;
		overflow-wrap: anywhere;
	}

	h3 {
		color: var(--text-color-secondary);
		font-size: 11px;
		font-weight: 500;
		padding: 12px 12px 4px;
	}

	.control-section {
		border: 1px solid var(--border-color);
		border-radius: 10px;
		background: var(--color-bg-primary);
		overflow: hidden;
		margin-bottom: 12px;
	}

	.action {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		background: none;
		color: inherit;
		text-align: left;
		font: inherit;
		padding: 12px;
		width: 100%;
		line-height: 1.4;
		border-bottom: 1px solid var(--border-color);
	}

	.action:last-child {
		border-bottom: 0;
	}

	.action:hover {
		background: var(--color-script-highlighted);
	}

	.control-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		min-height: 44px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--border-color);
	}

	.control-row:last-child {
		border-bottom: 0;
	}

	.control-row:has(.action) {
		padding: 0;
	}

	.control-row label {
		flex: 1;
	}

	select {
		max-width: 150px;
		font: inherit;
		color: inherit;
		background: var(--color-bg-secondary);
		border: 1px solid var(--border-color);
		border-radius: 6px;
		padding: 5px;
	}

	.range {
		display: flex;
		align-items: center;
		gap: 8px;
		max-width: 160px;
	}

	.range input {
		min-width: 0;
		width: 115px;
		accent-color: var(--color-blue);
	}

	output {
		color: var(--text-color-secondary);
		font-size: 12px;
		overflow-wrap: anywhere;
	}

	.empty {
		line-height: 1.7;
		padding: 12px 0;
	}

	.settings label {
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 13px;
	}

	.settings label small,
	.meta {
		color: var(--text-color-secondary);
		font-size: 11px;
		line-height: 1.4;
	}

	.meta {
		margin: 0;
		padding: 8px 12px 10px;
	}

	.warning {
		padding: 10px 12px;
		border-bottom: 1px solid var(--border-color);
		color: var(--color-red);
		font-size: 12px;
		line-height: 1.5;
	}

	.warning p {
		margin: 0 0 8px;
	}

	.warning-actions {
		display: flex;
		gap: 8px;
	}

	.warning-actions button {
		border: 1px solid var(--border-color);
		border-radius: 6px;
		padding: 4px 10px;
		background: var(--color-bg-secondary);
		color: var(--text-color-primary);
		font-size: 12px;
	}

	.warning-actions .danger {
		border-color: var(--color-red);
		color: var(--color-red);
	}

	.feedback {
		color: var(--text-color-secondary);
		font-size: 12px;
		line-height: 1.5;
		margin-top: 10px;
		overflow-wrap: anywhere;
	}

	.error {
		color: var(--color-red);
	}

	button:focus-visible,
	input:focus-visible,
	select:focus-visible {
		outline: 2px solid var(--color-blue);
		outline-offset: 3px;
	}
</style>
