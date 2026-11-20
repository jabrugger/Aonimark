import type { Options } from 'remark-stringify';

import { parseFrontMatter } from './frontMatter.js';

/**
 * remark-stringify options for the WYSIWYG editor.
 *
 * Milkdown re-serializes a document through remark-stringify whenever it saves
 * or reports its content. remark-stringify's defaults (`*` bullets and rules,
 * `*` emphasis) differ from the spelling most Markdown is written in, so an
 * untouched file comes back reformatted. These options pin the serializer to
 * the markers the document already uses, so the round trip is a byte-for-byte
 * no-op wherever Milkdown's parser preserves the construct.
 */

export type EmphasisMarker = '*' | '_';
export type OrderedMarker = '.' | ')';

/**
 * Count the emphasis/strong runs opened with `marker`.
 *
 * A run is `*a*`, `**a**`, `_a_` or `__a__`: the marker, once or twice,
 * followed by a non-space character that is not the marker itself. That keeps
 * thematic breaks (`***`, `___`), `snake_case_names` and `2*3*4` from counting
 * as emphasis.
 */
function countEmphasisRuns(markdown: string, marker: EmphasisMarker): number {
	const m = marker === '*' ? '\\*' : '_';
	const pattern = new RegExp(`(?<![\\w${m}])${m}{1,2}(?=[^\\s${m}])`, 'g');
	return (markdown.match(pattern) ?? []).length;
}

/**
 * The emphasis marker the document mostly writes: `*` or `_`.
 *
 * Each emphasis/strong run votes for its marker; ties and documents with no
 * emphasis fall back to `*`, CommonMark's preferred marker. Milkdown preserves
 * each existing mark's marker on parse, so this only chooses the marker for
 * emphasis the user adds in the editor.
 */
export function dominantEmphasisMarker(markdown: string): EmphasisMarker {
	return countEmphasisRuns(markdown, '_') > countEmphasisRuns(markdown, '*') ? '_' : '*';
}

/**
 * The ordered-list marker the document mostly writes: `.` or `)`.
 *
 * remark-parse drops the marker on ordered lists, so a document that writes
 * `1) item` can only be preserved by choosing `)` here — at the cost of the
 * `1.` spelling everywhere else. The dominant marker wins; ties default to `.`.
 */
export function dominantOrderedMarker(markdown: string): OrderedMarker {
	let dot = 0;
	let paren = 0;
	for (const line of markdown.split('\n')) {
		const match = /^\s*\d+([.)])\s/.exec(line);
		if (!match) continue;
		if (match[1] === '.') dot++;
		else paren++;
	}
	return paren > dot ? ')' : '.';
}

/**
 * The remark-stringify options that make a document round-trip unchanged
 * through Milkdown's parser and serializer, where that is possible.
 *
 * See `scripts/wysiwyg.spec.ts` for the constructs this does and does not make
 * stable.
 */
export function wysiwygStringifyOptions(markdown: string): Options {
	const emphasis = dominantEmphasisMarker(markdown);
	return {
		bullet: '-',
		bulletOrdered: dominantOrderedMarker(markdown),
		emphasis,
		strong: emphasis,
		fence: '`',
		rule: '-',
		ruleRepetition: 3,
		ruleSpaces: false,
	};
}

/**
 * The document's leading front matter block, split off so the WYSIWYG editor
 * can hand Milkdown only the body and re-attach the block verbatim on
 * serialize.
 *
 * The split is `parseFrontMatter`'s rule, not a second one: a leading `---`
 * block is front matter only when its YAML is a mapping (or empty, or
 * malformed). A leading thematic break over prose, a bare sequence, an
 * unclosed block, and TOML `+++` (which the preview does not strip) all stay
 * with the body, exactly as the preview treats them.
 *
 * `frontMatter` is the exact leading bytes — the opening fence, the YAML, the
 * closing fence and the single blank line after it — so `frontMatter + body`
 * is `content`, byte for byte, CRLF and all. `lineEnding` is the document's
 * own, for the serialized body to be written back in.
 */
export function splitFrontMatter(content: string): {
	frontMatter: string;
	body: string;
	lineEnding: '\n' | '\r\n';
} {
	const { body, lineEnding } = parseFrontMatter(content);
	return {
		frontMatter: content.slice(0, content.length - body.length),
		body,
		lineEnding,
	};
}

/**
 * Re-end `markdown` — a Milkdown serialization, which always comes back LF —
 * with the document's own line ending, so an edited CRLF file is not saved as
 * LF.
 */
export function withLineEnding(markdown: string, lineEnding: '\n' | '\r\n'): string {
	return lineEnding === '\n' ? markdown : markdown.replace(/\r?\n/g, '\r\n');
}
