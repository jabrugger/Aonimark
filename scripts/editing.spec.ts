import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { FrontMatterFieldState } from '../src/lib/utils/frontMatterFieldState.svelte.js';
import type { FrontMatterField } from '../src/lib/utils/frontMatter.js';


// The panel keeps its per-field state side by side, and every table has to be
// keyed by document *and* field. The error table was once keyed by the bare
// field name, so a `date` error raised in one document stayed on screen under
// `date` after switching to another document.
describe('front matter field state scope', () => {
	const date: FrontMatterField = { key: 'date', value: '', kind: 'string', displayValue: '', editable: true };
	const tags: FrontMatterField = { key: 'tags', value: [], kind: 'list', displayValue: '', editable: true };

	function twoDocuments() {
		let doc = '/a.md';
		const state = new FrontMatterFieldState(() => doc);
		return { state, open: (path: string) => (doc = path) };
	}

	test('the front-matter error table is never keyed by a bare field name', () => {
		const { state, open } = twoDocuments();
		state.setEditError(date, new Error('bad date'));
		assert.equal(state.editError(date), 'Error: bad date');

		open('/b.md');
		assert.equal(state.editError(date), undefined, "one document's error must not show in another");
		state.clearEditError(date);

		open('/a.md');
		assert.equal(state.editError(date), 'Error: bad date', "clearing it elsewhere must not clear this document's");
	});

	test('all five per-field front-matter tables agree on their key', () => {
		const { state, open } = twoDocuments();
		state.setTagDraft(tags, 'draft-a');
		state.startTagEdit(tags, 2, 'edit-a');

		open('/b.md');
		assert.equal(state.tagDraft(tags), '');
		assert.equal(state.tagEditIndex(tags), null);
		assert.equal(state.tagEditDraft(tags, 'fallback'), 'fallback');
		state.setTagDraft(tags, 'draft-b');
		state.clearTagEdit(tags);

		open('/a.md');
		assert.equal(state.tagDraft(tags), 'draft-a');
		assert.equal(state.tagEditIndex(tags), 2);
		assert.equal(state.tagEditDraft(tags, 'fallback'), 'edit-a');
	});
});
