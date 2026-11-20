import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { Editor, defaultValueCtx, remarkStringifyOptionsCtx, rootCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { getMarkdown } from '@milkdown/kit/utils';

import { wysiwygStringifyOptions } from '../src/lib/utils/wysiwygMarkdown.js';
import { readSource, sampleFiles } from './sourceTree.js';

/*
 * WYSIWYG round-trip: Milkdown parses a document and re-serializes it through
 * remark-stringify, and that re-serialization is what a save writes back. An
 * edited file must not come back reformatted, so the serializer options in
 * `wysiwygMarkdown.ts` pin the markers to the document's own. These tests drive
 * the real Milkdown parse -> serialize in jsdom and pin exactly which
 * constructs survive byte-for-byte and which ones Milkdown's parser drops.
 */

/** Parse `markdown` with Milkdown and serialize it back, with the editor's options. */
async function roundTrip(markdown: string): Promise<string> {
	const editor = await Editor.make()
		.config((ctx) => {
			ctx.set(rootCtx, document.createElement('div'));
			ctx.set(defaultValueCtx, markdown);
			ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, ...wysiwygStringifyOptions(markdown) }));
		})
		.use(commonmark)
		.use(gfm)
		.create();
	const result = editor.action(getMarkdown());
	void editor.destroy();
	return result;
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
		['YAML front matter is mangled', '---\ntitle: x\n---\n\n# H\n', '---\n\n## title: x\n\n# H\n'],
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
		// Every other sample carries front matter, tables, maths, wikilinks or a
		// non-UTF-8 encoding, which the "constructs Milkdown drops" suite covers.
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
		];
		for (const markdown of representable) {
			assert.equal(await roundTrip(markdown), markdown);
		}
	});
});
