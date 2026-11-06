export function createPageAPI({ document, name, console }) {
	function addStyle(css) {
		if (typeof css !== "string") throw new TypeError("CSS must be a string");
		const element = document.createElement("style");
		element.textContent = css;
		(document.head ?? document.documentElement).append(element);
		return element;
	}
	function addElement(parent, tag, attributes) {
		if (typeof parent === "string") {
			attributes = tag;
			tag = parent;
			parent = document.head ?? document.documentElement;
		}
		if (
			!parent?.append ||
			typeof tag !== "string" ||
			!/^[a-z][\w-]*$/i.test(tag)
		)
			throw new TypeError("Invalid element parent or tag");
		if (
			attributes !== undefined &&
			(!attributes ||
				typeof attributes !== "object" ||
				Array.isArray(attributes))
		)
			throw new TypeError("Element attributes must be an object");
		const element = document.createElement(tag);
		for (const [key, value] of Object.entries(attributes ?? {})) {
			if (key === "textContent") element.textContent = String(value);
			else element.setAttribute(key, String(value));
		}
		parent.append(element);
		return element;
	}
	const log = (...args) => console.log(`[${name}]`, ...args);
	return {
		GM_addStyle: addStyle,
		addStyle: async (css) => addStyle(css),
		GM_addElement: addElement,
		addElement: async (...args) => addElement(...args),
		GM_log: log,
		log,
	};
}
