import assert from 'node:assert/strict';

import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { getMarkdown } from '@milkdown/kit/utils';
import { describe, test } from 'vitest';

import { allMatches, findPlugin, findStatus, replaceAllMatches, searchTransaction } from '../src/lib/utils/documentFind.js';

/** A real Milkdown editor, with the same presets and find plugin the app uses. */
async function editorWith(markdown: string) {
	const root = document.createElement('div');
	document.body.append(root);
	const editor = await Editor.make()
		.config((ctx) => {
			ctx.set(rootCtx, root);
			ctx.set(defaultValueCtx, markdown);
		})
		.use(commonmark)
		.use(gfm)
		.use(findPlugin)
		.create();
	return {
		view: editor.action((ctx) => ctx.get(editorViewCtx)),
		markdown: () => editor.action(getMarkdown()),
		destroy: () => {
			void editor.destroy();
			root.remove();
		},
	};
}

describe('find and replace in a real Markdown document', () => {
	const options = (query: string) => ({ query, matchCase: false, wholeWord: false });

	test('finds text inside headings, formatting, lists, links and table cells', async () => {
		const { view, destroy } = await editorWith(
			'# Cat story\n\nA **cat** and a [cat](https://example.com).\n\n- cat in a list\n\n| a | b |\n| - | - |\n| cat | dog |\n',
		);
		view.dispatch(searchTransaction(view.state, options('cat')));
		assert.equal(findStatus(view.state).total, 5);
		destroy();
	});

	test('replace all rewrites the Markdown and keeps its formatting', async () => {
		const { view, markdown, destroy } = await editorWith('# Cat story\n\nA **cat** and a [cat](https://example.com).\n');
		view.dispatch(searchTransaction(view.state, options('cat')));
		view.dispatch(replaceAllMatches(view.state, allMatches(view.state), 'dog'));
		const result = markdown();
		assert.match(result, /^# dog story/);
		assert.match(result, /A \*\*dog\*\* and a \[dog\]\(https:\/\/example\.com\)\./);
		destroy();
	});

	test('the highlights are in the rendered document', async () => {
		const { view, destroy } = await editorWith('one two one\n');
		view.dispatch(searchTransaction(view.state, options('one')));
		assert.equal(view.dom.querySelectorAll('.find-match').length, 2);
		assert.equal(view.dom.querySelectorAll('.find-match-current').length, 1);
		destroy();
	});
});
