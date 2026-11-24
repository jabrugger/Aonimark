import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Schema } from '@milkdown/prose/model';
import { EditorState } from '@milkdown/prose/state';

import {
	allMatches,
	clearTransaction,
	createFindPlugin,
	currentMatch,
	findMatches,
	findStatus,
	replaceAllMatches,
	replaceMatch,
	searchTransaction,
	stepTransaction,
	type FindOptions,
} from '../src/lib/utils/documentFind.js';

const schema = new Schema({
	nodes: {
		doc: { content: 'paragraph+' },
		paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
		text: { group: 'inline' },
		hard_break: { inline: true, group: 'inline', selectable: false, toDOM: () => ['br'] },
	},
	marks: { strong: { toDOM: () => ['strong', 0] } },
});

type Inline = string | { strong: string } | 'br';

/** A document of paragraphs, each a list of text runs, bold runs and hard breaks. */
function docOf(...paragraphs: Inline[][]) {
	return schema.node(
		'doc',
		null,
		paragraphs.map((runs) =>
			schema.node(
				'paragraph',
				null,
				runs.map((run) =>
					run === 'br'
						? schema.node('hard_break')
						: typeof run === 'string'
							? schema.text(run)
							: schema.text(run.strong, [schema.mark('strong')]),
				),
			),
		),
	);
}

const find = (query: string, extra: Partial<FindOptions> = {}): FindOptions => ({ query, matchCase: false, wholeWord: false, ...extra });
const texts = (doc: ReturnType<typeof docOf>, matches: { from: number; to: number }[]) =>
	matches.map((match) => doc.textBetween(match.from, match.to));

describe('finding text in the document', () => {
	test('every occurrence is found, in order, ignoring case by default', () => {
		const doc = docOf(['Cat cat CAT'], ['a cat']);
		assert.deepEqual(texts(doc, findMatches(doc, find('cat'))), ['Cat', 'cat', 'CAT', 'cat']);
	});

	test('match case narrows the result', () => {
		const doc = docOf(['Cat cat CAT']);
		assert.deepEqual(texts(doc, findMatches(doc, find('cat', { matchCase: true }))), ['cat']);
	});

	test('whole word skips matches inside a longer word, including accented letters', () => {
		const doc = docOf(['cat catalog concat cat_ cat. cátedra']);
		assert.deepEqual(texts(doc, findMatches(doc, find('cat', { wholeWord: true }))), ['cat', 'cat']);
		const accented = docOf(['ata atá']);
		assert.equal(findMatches(accented, find('ata', { wholeWord: true })).length, 1);
	});

	test('the query is literal text, not a pattern', () => {
		const doc = docOf(['a.c abc (x) [y]']);
		assert.deepEqual(texts(doc, findMatches(doc, find('a.c'))), ['a.c']);
		assert.deepEqual(texts(doc, findMatches(doc, find('(x)'))), ['(x)']);
		assert.deepEqual(texts(doc, findMatches(doc, find('[y]'))), ['[y]']);
	});

	test('an empty query finds nothing', () => {
		assert.deepEqual(findMatches(docOf(['abc']), find('')), []);
	});

	test('a match runs across bold and plain text, but never across paragraphs or a hard break', () => {
		const doc = docOf(['foo ', { strong: 'bar' }, ' baz'], ['end', 'br', 'start'], ['x'], ['y']);
		assert.deepEqual(texts(doc, findMatches(doc, find('o bar b'))), ['o bar b']);
		assert.deepEqual(findMatches(doc, find('endstart')), []);
		assert.deepEqual(findMatches(doc, find('xy')), []);
	});
});

describe('replacing text', () => {
	const stateOf = (doc: ReturnType<typeof docOf>) => EditorState.create({ schema, doc });

	test('replacing one match changes only that match and keeps the formatting', () => {
		const doc = docOf(['one ', { strong: 'two' }, ' two']);
		const state = stateOf(doc);
		const [, second] = findMatches(doc, find('two'));
		const next = state.apply(replaceMatch(state, second, 'three'));
		assert.equal(next.doc.textContent, 'one two three');
		const strong = next.doc.firstChild!.child(1);
		assert.equal(strong.text, 'two');
		assert.equal(strong.marks.length, 1);
	});

	test('replacing every match works when the replacement has a different length', () => {
		const doc = docOf(['a b a'], ['a']);
		const state = stateOf(doc);
		const next = state.apply(replaceAllMatches(state, findMatches(doc, find('a')), 'long'));
		assert.deepEqual([next.doc.child(0).textContent, next.doc.child(1).textContent], ['long b long', 'long']);
	});

	test('replacing with nothing deletes the matches', () => {
		const doc = docOf(['x-y-x']);
		const state = stateOf(doc);
		const next = state.apply(replaceAllMatches(state, findMatches(doc, find('x')), ''));
		assert.equal(next.doc.textContent, '-y-');
	});
});

describe('the find plugin', () => {
	const start = (doc: ReturnType<typeof docOf>) => EditorState.create({ schema, doc, plugins: [createFindPlugin()] });

	test('searching selects the first match after the cursor and reports the count', () => {
		let state = start(docOf(['aa bb aa bb aa']));
		state = state.apply(searchTransaction(state, find('bb')));
		assert.deepEqual(findStatus(state), { total: 2, current: 1 });
		assert.equal(state.doc.textBetween(state.selection.from, state.selection.to), 'bb');
	});

	test('stepping wraps around in both directions', () => {
		let state = start(docOf(['x x x']));
		state = state.apply(searchTransaction(state, find('x')));
		assert.equal(findStatus(state).current, 1);
		state = state.apply(stepTransaction(state, -1)!);
		assert.equal(findStatus(state).current, 3);
		state = state.apply(stepTransaction(state, 1)!);
		assert.equal(findStatus(state).current, 1);
	});

	test('stepping with no matches does nothing', () => {
		let state = start(docOf(['abc']));
		state = state.apply(searchTransaction(state, find('zzz')));
		assert.deepEqual(findStatus(state), { total: 0, current: 0 });
		assert.equal(stepTransaction(state, 1), null);
		assert.equal(currentMatch(state), null);
	});

	test('editing the document finds the matches again', () => {
		let state = start(docOf(['cat cat']));
		state = state.apply(searchTransaction(state, find('cat')));
		assert.equal(findStatus(state).total, 2);
		state = state.apply(state.tr.insertText(' cat', 8));
		assert.equal(findStatus(state).total, 3);
		assert.equal(allMatches(state).length, 3);
	});

	test('replacing the current match leaves the rest searchable', () => {
		let state = start(docOf(['a a a']));
		state = state.apply(searchTransaction(state, find('a')));
		state = state.apply(replaceMatch(state, currentMatch(state)!, 'b'));
		assert.equal(state.doc.textContent, 'b a a');
		assert.equal(findStatus(state).total, 2);
	});

	test('clearing the search drops the highlights', () => {
		let state = start(docOf(['abc']));
		state = state.apply(searchTransaction(state, find('b')));
		state = state.apply(clearTransaction(state));
		assert.deepEqual(findStatus(state), { total: 0, current: 0 });
	});
});
