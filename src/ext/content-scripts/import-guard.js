// `import()` would evaluate a module at realm global scope, and WebKit exempts
// extension worlds from CSP, so it cannot be blocked by policy. Like SES, any
// `import` keyword followed (after whitespace or comments) by `(` is rewritten
// to a call that throws. Text inside strings/comments may be altered too; that
// only changes how that text reads, never what code can reach.
export const IMPORT_PATTERN = String.raw`(?<![\p{ID_Continue}$\u200c\u200d])(?<!(?<!\.\.)\.)import(?=(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n\r\u2028\u2029]*|<!--[^\n\r\u2028\u2029]*|-->[^\n\r\u2028\u2029]*)*\()`;
const importExpression = new RegExp(IMPORT_PATTERN, "gu");
export const neutralizeImports = (source) =>
	String(source).replace(importExpression, "__ueImport__");
