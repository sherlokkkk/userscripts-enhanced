// Materialize realm proxies before sending data to structured-clone APIs.
// Read each property once, never retain accessors or invoke a user toJSON hook.
export function copyJSON(value, seen = new Set()) {
	if (value === null || ["string", "boolean"].includes(typeof value))
		return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "object" || seen.has(value))
		throw new TypeError("GM values must be finite, acyclic JSON data");
	const array = Array.isArray(value);
	if (
		!array &&
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		throw new TypeError("GM values must contain plain objects or arrays");
	seen.add(value);
	const result = array ? new Array(value.length) : {};
	for (const [key, item] of Object.entries(value))
		Object.defineProperty(result, key, {
			value: copyJSON(item, seen),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	seen.delete(value);
	return result;
}
