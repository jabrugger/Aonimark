import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { Editor, defaultValueCtx, remarkStringifyOptionsCtx, rootCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { getMarkdown } from '@milkdown/kit/utils';

import { splitFrontMatter, withLineEnding, wysiwygStringifyOptions } from '../src/lib/utils/wysiwygMarkdown.js';
import { readSource, sampleFiles } from './sourceTree.js';

/*
 * WYSIWYG round-trip: Milkdown parses a document and re-serializes it through
 * remark-stringify, and that re-serialization is what a save writes back. An
 * edited file must not come back reformatted, so the serializer options in
 * `wysiwygMarkdown.ts` pin the markers to the document's own. These tests drive
 * the real Milkdown parse -> serialize in jsdom and pin exactly which
 * constructs survive byte-for-byte and which ones Milkdown's parser drops.
 */

/** Serialize `body` through the real Milkdown parse -> serialize, with the editor's options. */
async function serializeBody(body: string): Promise<string> {
	const editor = await Editor.make()
		.config((ctx) => {
			ctx.set(rootCtx, document.createElement('div'));
			ctx.set(defaultValueCtx, body);
			ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, ...wysiwygStringifyOptions(body) }));
		})
		.use(commonmark)
		.use(gfm)
		.create();
	const result = editor.action(getMarkdown());
	void editor.destroy();
	return result;
}

/**
 * The editor's full pipeline: split the leading front matter block off, run
 * the body through Milkdown, and re-attach the block verbatim, in the
 * document's own line ending.
 */
async function roundTrip(markdown: string): Promise<string> {
	const { frontMatter, body, lineEnding } = splitFrontMatter(markdown);
	return frontMatter + withLineEnding(await serializeBody(body), lineEnding);
}

describe('constructs that round-trip unchanged', () => {
	const stable: [string, string][] = [
		['nested bullet lists', '- a\n- b\n  - c\n    - d\n- e\n'],
		['nested ordered lists', '1. First\n2. Second\n   1. Nested\n   2. Nested two\n3. Third\n'],
		['ordered lists starting past one', '7. Seven\n8. Eight\n'],
		['ordered lists with a paren marker', '1) One\n2) Two\n'],
		['task lists', '- [x] done\n- [ ] todo\n  - [x] nested\n'],
		['backtick code fences', '```js\nconst x = 1;\n```\n'],
		['links with titles', '[text](https://example.com "Title")\n'],
		['images with titles', '![alt](../pics/x.png "Title")\n'],
		['soft line breaks', 'one\ntwo\n'],
		['hard line breaks (backslash)', 'one\\\ntwo\n'],
		['inline html', 'a <kbd>Ctrl</kbd> b\n'],
		['html blocks', '<details>\n<summary>x</summary>\n\nbody\n\n</details>\n'],
		['mixed emphasis markers', '*i* _i_ **b** __b__ ***both***\n'],
		['blockquotes', '> quote\n>\n> second paragraph\n'],
		['strikethrough', '~~struck~~\n'],
		['angle autolinks', '<https://example.com>\n'],
		['escaped markers', '\\*not italic\\*\n'],
		['empty documents', ''],
	];

	for (const [name, markdown] of stable) {
		test(name, async () => {
			assert.equal(await roundTrip(markdown), markdown);
		});
	}
});

describe('front matter round-trips through the editor pipeline', () => {
	// Front matter never reaches Milkdown: the editor splits it off, hands the
	// body to Milkdown, and re-attaches the block verbatim. These edge cases
	// must survive byte for byte, line ending included.
	const preserved: [string, string][] = [
		['YAML front matter', '---\ntitle: x\n---\n\n# H\n'],
		['front matter with a nested list', '---\ntitle: x\ntags:\n  - a\n  - b\n---\n\n# H\n'],
		['a --- rule in the body after the front matter', '---\ntitle: x\n---\n\n# H\n\n---\n\nbody\n'],
		['front matter only', '---\ntitle: x\n---\n'],
		['front matter with no body after the blank line', '---\ntitle: x\n---\n\n'],
		['CRLF front matter and body', '---\r\ntitle: x\r\n---\r\n\r\n# H\r\n'],
		['CRLF front matter only', '---\r\ntitle: x\r\n---\r\n'],
		['a BOM and trailing whitespace on the opening fence', '\uFEFF--- \ntitle: x\n---\n\n# H\n'],
	];

	for (const [name, markdown] of preserved) {
		test(name, async () => {
			assert.equal(await roundTrip(markdown), markdown);
		});
	}
});

describe('fences that are plain body, not front matter', () => {
	// The preview's rule leaves these with the body, so the editor hands them
	// to Milkdown untouched and they round-trip (or mangle) like any other
	// prose or thematic break — never as a preserved metadata block. Pinned so
	// a change to the split (or the preview) is noticed.
	const body: [string, string, string][] = [
		['unclosed --- block is plain body', '---\ntitle: x\n# H\n', '---\n\ntitle: x\n\n# H\n'],
		['TOML +++ block is plain body', '+++\ntitle = "x"\n+++\n\n# H\n', '+++\ntitle = "x"\n+++\n\n# H\n'],
	];

	for (const [name, markdown, expected] of body) {
		test(name, async () => {
			assert.equal(await roundTrip(markdown), expected);
		});
	}
});

describe('CRLF line endings', () => {
	// The serializer always emits LF; the editor re-ends the body with the
	// document's own line ending, so a CRLF file stays CRLF whether it has
	// front matter or not.
	const crlf: [string, string][] = [
		['a CRLF document without front matter', '# H\r\n\r\n- one\r\n- two\r\n'],
		['a CRLF document with emphasis', '**bold** and *italic*\r\n'],
	];

	for (const [name, markdown] of crlf) {
		test(name, async () => {
			assert.equal(await roundTrip(markdown), markdown);
		});
	}
});

describe('constructs Milkdown drops on round-trip', () => {
	// These change because remark-parse (or Milkdown's schema) discards the
	// spelling; each is pinned to its actual output so a change here is noticed.
	const lossy: [string, string, string][] = [
		['asterisk bullets become dashes', '* a\n* b\n', '- a\n- b\n'],
		['plus bullets become dashes', '+ a\n+ b\n', '- a\n- b\n'],
		['lazy `1.` numbering is renumbered', '1. Alpha\n1. Bravo\n1. Charlie\n', '1. Alpha\n2. Bravo\n3. Charlie\n'],
		['tables are padded', '| A | B |\n|---|---|\n| 1 | 2 |\n', '| A | B |\n| - | - |\n| 1 | 2 |\n'],
		['aligned tables are padded and re-aligned', '| L | C | R |\n|:---|:---:|---:|\n| a | b | 1 |\n', '| L  |  C  |  R |\n| :- | :-: | -: |\n| a  |  b  |  1 |\n'],
		['tilde fences become backticks', '~~~md\ncode\n~~~\n', '```md\ncode\n```\n'],
		['indented code becomes fenced', '    indented\n    code\n', '```\nindented\ncode\n```\n'],
		['two-space hard breaks become backslashes', 'one  \ntwo\n', 'one\\\ntwo\n'],
		['`***` and `___` rules become `---`', '---\n\n***\n\n___\n', '---\n\n---\n\n---\n'],
		['setext headings become ATX', 'Title\n=====\n', '# Title\n'],
		['wikilinks are escaped', '[[a|b]]\n', '\\[\\[a|b]]\n'],
		['bare URLs become autolinks', 'https://example.com\n', '<https://example.com>\n'],
	];

	for (const [name, markdown, expected] of lossy) {
		test(name, async () => {
			assert.equal(await roundTrip(markdown), expected);
		});
	}
});

describe('sample files', () => {
	test('every sample round-trips through the real pipeline', async () => {
		for (const path of sampleFiles()) {
			const original = readSource(path);
			const result = await roundTrip(original);
			// The parse -> serialize must not throw and must yield markdown; the
			// stability of each construct is pinned by the two suites above.
			assert.equal(typeof result, 'string');
		}
	});

	test('the one sample Milkdown fully represents is byte-stable', async () => {
		// Every other sample carries tables, maths, wikilinks or a non-UTF-8
		// encoding, which the "constructs Milkdown drops" suite covers. Front
		// matter no longer disqualifies one: the split above preserves it.
		const original = readSource('samples/encoding-cp1252.md');
		assert.equal(await roundTrip(original), original);
	});
});

describe('opening WYSIWYG and switching back', () => {
	test('does not change a document the editor can represent', async () => {
		// WysiwygEditor reports a change only for an edit the user actually made
		// (its teardown emit is gated on a doc change), and only when the
		// serialized markdown differs from what it was seeded with — the report is
		// what marks the tab dirty. A byte-stable round trip is therefore exactly
		// the guarantee that opening and closing without editing is a no-op.
		const representable = [
			'# Heading\n\n- one\n- two\n\n**bold** and *italic*\n',
			'- [ ] task\n\n```js\ncode();\n```\n',
			'[link](https://example.com)\n\n![alt](img.png)\n',
			'---\ntitle: x\n---\n\n# Heading\n\n- one\n- two\n',
		];
		for (const markdown of representable) {
			assert.equal(await roundTrip(markdown), markdown);
		}
	});
});
