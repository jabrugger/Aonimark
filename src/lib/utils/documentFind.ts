import { $prose } from '@milkdown/kit/utils';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';

export type FindOptions = {
	query: string;
	matchCase: boolean;
	wholeWord: boolean;
};

export type Match = { from: number; to: number };

/** What the find bar shows: how many matches there are and which one is current (1-based, 0 when none). */
export type FindStatus = { total: number; current: number };

/** Stands in for an inline node that is not text (an image, a hard break), so a match never spans it. */
const NON_TEXT = '￼';

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPattern({ query, matchCase, wholeWord }: FindOptions): RegExp {
	const body = escapeRegExp(query);
	const source = wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
	return new RegExp(source, matchCase ? 'gu' : 'giu');
}

/**
 * Every match of the query in the document, in order. A match lies within one
 * text block: it never crosses a paragraph, a table cell or an inline node
 * that is not text. Text under different marks (a bold word inside a
 * sentence) is one run, so `foo **bar** baz` matches `o bar b`.
 */
export function findMatches(doc: ProseNode, options: FindOptions): Match[] {
	if (!options.query) return [];
	const pattern = buildPattern(options);
	const matches: Match[] = [];

	doc.descendants((node, pos) => {
		if (!node.isTextblock) return true;
		// Each text node's offset in the block's text, with its document position.
		const runs: { start: number; pos: number; length: number }[] = [];
		let text = '';
		node.forEach((child, offset) => {
			const childPos = pos + 1 + offset;
			if (child.isText) {
				runs.push({ start: text.length, pos: childPos, length: child.text!.length });
				text += child.text;
			} else {
				text += NON_TEXT;
			}
		});

		const positionOf = (index: number, end: boolean): number => {
			for (const run of runs) {
				if (index >= run.start && (end ? index <= run.start + run.length : index < run.start + run.length)) {
					return run.pos + (index - run.start);
				}
			}
			return -1;
		};

		for (const found of text.matchAll(pattern)) {
			if (found[0].length === 0) continue;
			const from = positionOf(found.index, false);
			const to = positionOf(found.index + found[0].length, true);
			// A match that touches a non-text placeholder has no position there.
			if (from === -1 || to === -1 || found[0].includes(NON_TEXT)) continue;
			matches.push({ from, to });
		}
		return false;
	});

	return matches;
}

/** Replaces one match. Marks at the start of the match carry over to the new text. */
export function replaceMatch(state: EditorState, match: Match, replacement: string): Transaction {
	return state.tr.insertText(replacement, match.from, match.to);
}

/** Replaces every match in one transaction, so one undo restores them all. */
export function replaceAllMatches(state: EditorState, matches: readonly Match[], replacement: string): Transaction {
	const tr = state.tr;
	// From the end, so earlier positions stay valid as the text changes length.
	for (const match of [...matches].reverse()) tr.insertText(replacement, match.from, match.to);
	return tr;
}

type FindPluginState = {
	options: FindOptions | null;
	matches: Match[];
	/** Index into `matches`, or -1 when there are none. */
	current: number;
	decorations: DecorationSet;
};

type FindMeta =
	| { type: 'search'; options: FindOptions }
	| { type: 'select'; current: number }
	| { type: 'clear' };

export const findKey = new PluginKey<FindPluginState>('aonimark-find');

const EMPTY: FindPluginState = { options: null, matches: [], current: -1, decorations: DecorationSet.empty };

function decorate(doc: ProseNode, matches: Match[], current: number): DecorationSet {
	return DecorationSet.create(
		doc,
		matches.map((match, index) =>
			Decoration.inline(match.from, match.to, {
				class: index === current ? 'find-match find-match-current' : 'find-match',
			}),
		),
	);
}

/** The first match at or after `from`, wrapping to the first; -1 when there are none. */
function indexAtOrAfter(matches: readonly Match[], from: number): number {
	if (matches.length === 0) return -1;
	const index = matches.findIndex((match) => match.from >= from);
	return index === -1 ? 0 : index;
}

/** Highlights the matches of the current query and remembers which one is current. */
export function createFindPlugin(): Plugin<FindPluginState> {
	return new Plugin<FindPluginState>({
		key: findKey,
		state: {
			init: () => EMPTY,
			apply(tr, value) {
				const meta = tr.getMeta(findKey) as FindMeta | undefined;
				if (meta?.type === 'clear') return EMPTY;
				if (meta?.type === 'search') {
					const matches = findMatches(tr.doc, meta.options);
					const current = indexAtOrAfter(matches, tr.selection.from);
					return { options: meta.options, matches, current, decorations: decorate(tr.doc, matches, current) };
				}
				if (meta?.type === 'select') {
					const current = value.matches.length === 0 ? -1 : Math.min(Math.max(meta.current, 0), value.matches.length - 1);
					return { ...value, current, decorations: decorate(tr.doc, value.matches, current) };
				}
				if (tr.docChanged && value.options) {
					// An edit moves every position, so the matches are found again and the
					// current one stays on the same ordinal where it can.
					const matches = findMatches(tr.doc, value.options);
					const current = matches.length === 0 ? -1 : Math.min(Math.max(value.current, 0), matches.length - 1);
					return { options: value.options, matches, current, decorations: decorate(tr.doc, matches, current) };
				}
				return value;
			},
		},
		props: {
			decorations: (state) => findKey.getState(state)?.decorations ?? DecorationSet.empty,
		},
	});
}

/** The plugin as Milkdown takes it: `editor.use(findPlugin)`. */
export const findPlugin = $prose(() => createFindPlugin());

export function findStatus(state: EditorState): FindStatus {
	const value = findKey.getState(state);
	if (!value || value.matches.length === 0) return { total: 0, current: 0 };
	return { total: value.matches.length, current: value.current + 1 };
}

/** Starts or refreshes a search, selecting the first match at or after the cursor. */
export function searchTransaction(state: EditorState, options: FindOptions): Transaction {
	const tr = state.tr.setMeta(findKey, { type: 'search', options } satisfies FindMeta);
	const matches = findMatches(state.doc, options);
	const index = indexAtOrAfter(matches, state.selection.from);
	return index === -1 ? tr : select(tr, matches[index]);
}

export function clearTransaction(state: EditorState): Transaction {
	return state.tr.setMeta(findKey, { type: 'clear' } satisfies FindMeta);
}

/** Moves to the next or previous match, wrapping around. */
export function stepTransaction(state: EditorState, direction: 1 | -1): Transaction | null {
	const value = findKey.getState(state);
	if (!value || value.matches.length === 0) return null;
	const total = value.matches.length;
	const current = (value.current + direction + total) % total;
	const tr = state.tr.setMeta(findKey, { type: 'select', current } satisfies FindMeta);
	return select(tr, value.matches[current]);
}

/** The match the bar is on, or null. */
export function currentMatch(state: EditorState): Match | null {
	const value = findKey.getState(state);
	return value && value.current >= 0 ? value.matches[value.current] : null;
}

export function allMatches(state: EditorState): readonly Match[] {
	return findKey.getState(state)?.matches ?? [];
}

function select(tr: Transaction, match: Match): Transaction {
	return tr.setSelection(TextSelection.create(tr.doc, match.from, match.to)).scrollIntoView();
}
