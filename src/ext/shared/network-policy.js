export function assertConnect(url, origin, connect = []) {
	const target = new URL(url);
	if (
		!["http:", "https:"].includes(target.protocol) ||
		target.username ||
		target.password
	)
		throw new Error(
			"GM network requests require HTTP(S) URLs without embedded credentials",
		);
	const page = new URL(origin);
	if (target.origin === page.origin) return target;
	const hostname = target.hostname.toLowerCase();
	const allowed = connect.some((rule) => {
		if (rule === "*") return true;
		if (rule === "self") return hostname === page.hostname;
		if (typeof rule !== "string" || /[\s/@:#?]/.test(rule)) return false;
		try {
			const host = new URL(
				`https://${rule.replace(/^\*\./, "")}`,
			).hostname.toLowerCase();
			return hostname === host || hostname.endsWith(`.${host}`);
		} catch {
			return false;
		}
	});
	if (!allowed) throw new Error(`@connect does not allow ${hostname}`);
	return target;
}

export function requestBody(processed) {
	if (!processed) return undefined;
	const { type, data, mime } = processed;
	if (["Text", "Document"].includes(type) && typeof data === "string")
		return data;
	if (type === "URLSearchParams") return new URLSearchParams(data);
	if (["ArrayBuffer", "ArrayBufferView"].includes(type))
		return new Uint8Array(data);
	if (type === "Blob") return new Blob([new Uint8Array(data)], { type: mime });
	if (type === "FormData") {
		const form = new FormData();
		for (const [key, value] of data) {
			if (typeof value === "string") form.append(key, value);
			else
				form.append(
					key,
					new Blob([new Uint8Array(value.data)], { type: value.mime }),
					value.name,
				);
		}
		return form;
	}
	throw new Error("Unsupported request body");
}
