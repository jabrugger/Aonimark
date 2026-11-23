import { parseDocument } from 'yaml';

type FrontMatterValueKind = 'string' | 'number' | 'boolean' | 'list' | 'object' | 'null';

type FrontMatterField = {
	key: string;
	value: unknown;
	kind: FrontMatterValueKind;
	displayValue: string;
	editable: boolean;
};

type FrontMatterParseResult = {
	exists: boolean;
	valid: boolean;
	raw: string;
	body: string;
	fields: FrontMatterField[];
	data: Record<string, unknown>;
	error?: string;
	lineEnding: '\n' | '\r\n';
};

type FrontMatterRange = {
	raw: string;
	body: string;
};

function detectLineEnding(content: string): '\n' | '\r\n' {
	return content.includes('\r\n') ? '\r\n' : '\n';
}

function findFrontMatterRange(content: string): FrontMatterRange | null {
	const firstLineMatch = content.match(/^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/);
	if (!firstLineMatch) return null;

	let cursor = firstLineMatch[0].length;
	while (cursor <= content.length) {
		const nextNewline = content.indexOf('\n', cursor);
		const lineEnd = nextNewline === -1 ? content.length : nextNewline + 1;
		const line = content.slice(cursor, lineEnd).replace(/\r?\n$/, '');
		if (line.trim() === '---') {
			const raw = content.slice(firstLineMatch[0].length, cursor);
			let bodyStart = lineEnd;
			if (content.startsWith('\r\n', bodyStart)) {
				bodyStart += 2;
			} else if (content.startsWith('\n', bodyStart)) {
				bodyStart += 1;
			}

			return {
				raw,
				body: content.slice(bodyStart),
			};
		}

		if (nextNewline === -1) break;
		cursor = lineEnd;
	}

	return null;
}

function getValueKind(value: unknown): FrontMatterValueKind {
	if (value === null || value === undefined) return 'null';
	if (Array.isArray(value)) return 'list';
	if (typeof value === 'boolean') return 'boolean';
	if (typeof value === 'number') return 'number';
	if (typeof value === 'string') return 'string';
	return 'object';
}

function stringifyDisplayValue(value: unknown): string {
	if (Array.isArray(value)) {
		return value.map((item) => stringifyDisplayValue(item)).join(', ');
	}
	if (value === null || value === undefined) return '';
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

// Front matter is metadata, so the block has to parse as a YAML mapping. Jekyll
// rejects anything else outright (`validate_data!` raises unless the parsed
// value `is_a?(Hash)`) and Hugo fails to unmarshal it into its map type; when a
// leading `---` block is not key/value pairs, no static-site generator or
// editor treats it as metadata. An empty block (`---\n---`) is still legal and
// empty metadata, so only a parsed scalar or sequence disqualifies it.
function isFrontMatterMapping(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	return typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function toField([key, value]: [string, unknown]): FrontMatterField {
	const kind = getValueKind(value);
	return {
		key,
		value,
		kind,
		displayValue: stringifyDisplayValue(value),
		editable: kind !== 'object',
	};
}

export function parseFrontMatter(content: string): FrontMatterParseResult {
	const lineEnding = detectLineEnding(content);
	const range = findFrontMatterRange(content);
	const notFrontMatter: FrontMatterParseResult = {
		exists: false,
		valid: true,
		raw: '',
		body: content,
		fields: [],
		data: {},
		lineEnding,
	};
	if (!range) return notFrontMatter;

	const malformed = (error: string): FrontMatterParseResult => ({
		exists: true,
		valid: false,
		raw: range.raw,
		body: range.body,
		fields: [],
		data: {},
		error,
		lineEnding,
	});
	const doc = parseDocument(range.raw, { prettyErrors: false });
	if (doc.errors.length > 0) return malformed(doc.errors.map((error) => error.message).join('\n'));

	// An alias with no anchor (`**bold**` reads as one) parses without errors
	// and throws only here, out of the preview's render and every editor
	// analysis that asks where the front matter ends. It is malformed front
	// matter, not an exception.
	let parsed: unknown;
	try {
		parsed = doc.toJSON();
	} catch (error) {
		return malformed(error instanceof Error ? error.message : String(error));
	}

	// A document whose first line is `---` but whose block is prose, not a
	// mapping, is ordinary markdown: the opening `---` is a thematic break and
	// the closing one underlines a setext heading. Stripping it would delete
	// visible text from the rendered body without showing it as metadata
	// anywhere, so hand the whole document back as body.
	if (!isFrontMatterMapping(parsed)) return notFrontMatter;

	const data = (parsed ?? {}) as Record<string, unknown>;
	return {
		exists: true,
		valid: true,
		raw: range.raw,
		body: range.body,
		fields: Object.entries(data).map(toField),
		data,
		lineEnding,
	};
}

export function getMarkdownBodyWithoutFrontMatter(content: string): string {
	return parseFrontMatter(content).body;
}

function parseFrontMatterTagInput(value: string): string[] {
	return value
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

