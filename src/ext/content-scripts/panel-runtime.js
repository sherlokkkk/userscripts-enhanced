const label = (value, name) => {
	if (typeof value !== "string" || !value.trim() || value.length > 256)
		throw new TypeError(`Invalid panel ${name}`);
	return value;
};
export function panelValue(control, value) {
	if (control.type === "button") {
		if (value !== undefined) throw new TypeError("Button accepts no value");
		return;
	}
	if (control.type === "toggle" && typeof value === "boolean") return value;
	if (
		control.type === "select" &&
		control.options.some((option) => option.value === value)
	)
		return value;
	if (
		control.type === "range" &&
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= control.min &&
		value <= control.max &&
		Math.abs(
			(value - control.min) / control.step -
				Math.round((value - control.min) / control.step),
		) < 1e-6
	)
		return value;
	if (
		control.type === "text" &&
		typeof value === "string" &&
		value.length <= 2048
	)
		return value;
	throw new TypeError(`Invalid value for ${control.id}`);
}
export function attachPanel({ script, register, unregister, changed, check }) {
	return (definition) => {
		check();
		if (
			definition?.version !== 1 ||
			!Array.isArray(definition.controls) ||
			definition.controls.length > 24
		)
			throw new TypeError("Panel requires version: 1 and at most 24 controls");
		const ids = new Set();
		const entries = Array.from(definition.controls, (item) => {
			const control = {
				id: label(item.id, "control ID"),
				label: label(item.label, "label"),
				type: item.type,
				disabled: item.disabled === true,
			};
			if (ids.has(control.id))
				throw new TypeError("Duplicate panel control ID");
			ids.add(control.id);
			if (
				!["button", "toggle", "select", "range", "text"].includes(control.type)
			)
				throw new TypeError("Unsupported panel control");
			if (control.type === "range") {
				const { min, max, step = 1 } = item;
				if (![min, max, step].every(Number.isFinite) || min >= max || step <= 0)
					throw new TypeError("Invalid range bounds");
				Object.assign(control, { min, max, step });
			}
			if (control.type === "select") {
				if (
					!Array.isArray(item.options) ||
					!item.options.length ||
					item.options.length > 32
				)
					throw new TypeError("Invalid select options");
				control.options = Array.from(item.options, (option) => ({
					value: label(option.value, "option value"),
					label: label(option.label, "option label"),
				}));
				if (
					new Set(control.options.map((option) => option.value)).size !==
					control.options.length
				)
					throw new TypeError("Duplicate option value");
			}
			if (control.type !== "button")
				control.value = panelValue(control, item.value);
			const callback = control.type === "button" ? item.onClick : item.onChange;
			if (control.type !== "text" && typeof callback !== "function")
				throw new TypeError("Panel action requires a callback");
			return { control, callback, closePopup: item.closePopup === true };
		});
		const panel = {
			version: 1,
			title: label(definition.title, "title"),
			controls: entries.map((entry) => entry.control),
		};
		let updateRevision = 0;
		const previous = script.panel;
		if (
			script.commands.size -
				(previous?.controls.filter((control) => control.commandId).length ??
					0) +
				entries.filter((entry) => entry.callback).length >
			200
		)
			throw new Error("Menu command limit");
		for (const control of previous?.controls ?? [])
			if (control.commandId) unregister(control.commandId);
		for (const { control, callback, closePopup } of entries) {
			if (control.type === "text") continue;
			control.commandId = register(
				control.label,
				async (value) => {
					const beforeUpdate = updateRevision;
					await callback(value);
					if (
						script.panel === panel &&
						control.type !== "button" &&
						updateRevision === beforeUpdate
					)
						control.value = value;
				},
				{ autoClose: closePopup },
			);
			const command = script.commands.get(control.commandId);
			command.panelControl = true;
			command.validateValue = (value) => {
				if (control.disabled || script.panel !== panel)
					throw new Error("Panel control unavailable");
				return panelValue(control, value);
			};
		}
		script.panel = panel;
		changed();
		return Object.freeze({
			update({ values }) {
				check();
				if (script.panel !== panel)
					throw new Error("Panel was replaced or disposed");
				if (!values || typeof values !== "object" || Array.isArray(values))
					throw new TypeError("Expected values object");
				const changes = Object.entries(values).map(([id, value]) => {
					const control = panel.controls.find((control) => control.id === id);
					if (!control || control.type === "button")
						throw new TypeError("Unknown value control");
					return [control, panelValue(control, value)];
				});
				for (const [control, value] of changes) control.value = value;
				updateRevision++;
				changed();
			},
			dispose() {
				if (script.panel !== panel) return;
				for (const control of panel.controls)
					if (control.commandId) unregister(control.commandId);
				script.panel = undefined;
				changed();
			},
		});
	};
}
