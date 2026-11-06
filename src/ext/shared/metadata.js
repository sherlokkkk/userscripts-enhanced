// Preserve repeated, empty and unknown fields; callers decide capabilities.
export function parseHeader(content) {
	if (typeof content !== "string") return null;
	const blocks = content.match(
		/(?:(\/\/[ \t]*==UserScript==[^\r\n]*\r?\n([\s\S]*?)\r?\n\/\/[ \t]*==\/UserScript==)([\s\S]*)|(\/\*[ \t]*==UserStyle==[^\r\n]*\r?\n([\s\S]*?)\r?\n==\/UserStyle==[ \t]*\*\/)([\s\S]*))/,
	);
	if (!blocks) return null;
	const metadata = Object.create(null);
	for (const line of (blocks[2] ?? blocks[5]).split(/\r?\n/)) {
		const match = line.match(
			/^[ \t]*(?:\/\/)?[ \t]*@([\w:-]+)(?:[ \t]+(.*?))?[ \t]*$/,
		);
		if (!match) continue;
		const [, key, value = ""] = match;
		(metadata[key] ??= []).push(value.trim());
	}
	if (!metadata.name?.[0]?.trim()) return null;
	return {
		content,
		metadata,
		metablock: blocks[1] ?? blocks[4],
		code: (blocks[3] ?? blocks[6]).trim(),
	};
}

export const informationalMetadata = new Set([
	"name",
	"namespace",
	"version",
	"description",
	"author",
	"icon",
	"iconURL",
	"icon64",
	"icon64URL",
	"homepage",
	"homepageURL",
	"website",
	"license",
	"copyright",
	"supportURL",
	"source",
	"tag",
	"antifeature",
]);

export function metadataWarnings(metadata, grants) {
	const warnings = [];
	const implemented = new Set([
		"match",
		"include",
		"exclude",
		"exclude-match",
		"run-at",
		"grant",
		"connect",
		"require",
		"resource",
		"updateURL",
		"downloadURL",
		"noframes",
		"inject-into",
		"weight",
	]);
	for (const key of Object.keys(metadata)) {
		if (
			informationalMetadata.has(key) ||
			implemented.has(key) ||
			/^(name|description):/.test(key)
		)
			continue;
		warnings.push(`@${key} is preserved but has no runtime implementation`);
	}
	for (const grant of metadata.grant ?? []) {
		if (!grants.has(grant)) warnings.push(`Unsupported API: ${grant}`);
	}
	if (
		metadata["inject-into"]?.[0] === "page" &&
		metadata.grant?.some((grant) => grant !== "none")
	)
		warnings.push(
			"Page-world scripts cannot receive privileged GM APIs; use @inject-into content",
		);
	if (metadata.sandbox)
		warnings.push(
			"@sandbox does not select an execution world; use @inject-into",
		);
	if (metadata["run-in"])
		warnings.push("@run-in browser/profile restrictions are not implemented");
	return warnings;
}
