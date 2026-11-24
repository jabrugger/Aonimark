<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Editor,
		rootCtx,
		defaultValueCtx,
		editorViewCtx,
		editorViewOptionsCtx,
		remarkStringifyOptionsCtx,
		serializerCtx,
		type CmdKey,
	} from '@milkdown/kit/core';
	import {
		commonmark,
		createCodeBlockCommand,
		insertHrCommand,
		toggleEmphasisCommand,
		toggleInlineCodeCommand,
		toggleStrongCommand,
		wrapInBlockquoteCommand,
		wrapInBulletListCommand,
		wrapInHeadingCommand,
		wrapInOrderedListCommand,
	} from '@milkdown/kit/preset/commonmark';
	import {
		gfm,
		insertTableCommand,
		toggleStrikethroughCommand,
	} from '@milkdown/kit/preset/gfm';
	import { history, redoCommand, undoCommand } from '@milkdown/kit/plugin/history';
	import { clipboard } from '@milkdown/kit/plugin/clipboard';
	import { cursor } from '@milkdown/kit/plugin/cursor';
	import { trailing } from '@milkdown/kit/plugin/trailing';
	import { callCommand, getMarkdown, insert, replaceAll } from '@milkdown/kit/utils';
	import type { EditorView } from '@milkdown/prose/view';
	import { t, type LanguageCode } from '../utils/i18n.js';
	import {
		allMatches,
		clearTransaction,
		findPlugin,
		currentMatch,
		findStatus,
		replaceAllMatches,
		replaceMatch,
		searchTransaction,
		stepTransaction,
		type FindStatus,
	} from '../utils/documentFind.js';
	import FindBar from './FindBar.svelte';
	import { splitFrontMatter, withLineEnding, wysiwygStringifyOptions } from '../utils/wysiwygMarkdown.js';

	import '@milkdown/prose/view/style/prosemirror.css';
	import '@milkdown/prose/tables/style/tables.css';

	let {
		value,
		language = 'en',
		onchange,
		onrequesturl,
		toolbarHeight = $bindable(0),
	} = $props<{
		value: string;
		language?: LanguageCode;
		onchange: (markdown: string) => void;
		onrequesturl: (defaultText: string) => Promise<string | null>;
		toolbarHeight?: number;
	}>();

	let container = $state<HTMLDivElement>();
	let findBar = $state<{ focus: () => void }>();

	// The find bar. The matches themselves live in the editor state (see
	// `documentFind.ts`); these are what the bar shows and sends.
	let findOpen = $state(false);
	let showReplace = $state(false);
	let query = $state('');
	let replacement = $state('');
	let matchCase = $state(false);
	let wholeWord = $state(false);
	let status = $state<FindStatus>({ total: 0, current: 0 });
	let editor = $state<Editor | null>(null);
	let activeTools = $state<Set<string>>(new Set());

	function computeActiveTools(state: EditorView['state']): Set<string> {
		const active = new Set<string>();
		const sel = state.selection;
		const { from, to, empty } = sel;
		const anchorPos = sel.$from;
		const markMap: [string, string][] = [
			['strong', 'bold'],
			['emphasis', 'italic'],
			['strike_through', 'strikethrough'],
			['inlineCode', 'inline-code'],
		];
		const activeMarks = empty ? (state.storedMarks ?? anchorPos.marks()) : null;
		for (const [markName, toolId] of markMap) {
			const markType = state.schema.marks[markName];
			if (!markType) continue;
			const has = activeMarks
				? activeMarks.some((m) => m.type === markType)
				: state.doc.rangeHasMark(from, to, markType);
			if (has) active.add(toolId);
		}
		for (let d = anchorPos.depth; d >= 1; d--) {
			const node = anchorPos.node(d);
			const name = node.type.name;
			if (name === 'heading') {
				const level = node.attrs?.level;
				if (level === 1 || level === 2 || level === 3) active.add(`heading-${level}`);
			} else if (name === 'blockquote') {
				active.add('quote');
			} else if (name === 'code_block') {
				active.add('code-block');
			} else if (name === 'bullet_list') {
				active.add('bullet-list');
			} else if (name === 'ordered_list') {
				active.add('numbered-list');
			}
		}
		return active;
	}

	// The Milkdown callbacks are registered once, before Svelte has settled, so
	// they reach the latest props through this holder rather than a captured
	// (possibly stale) copy. Only the non-Svelte closures need it: the toolbar
	// buttons are Svelte handlers and read the props directly.
	const handlers: {
		onchange: (markdown: string) => void;
		onrequesturl: (defaultText: string) => Promise<string | null>;
	} = {
		onchange: () => {},
		onrequesturl: () => Promise.resolve(null),
	};
	$effect(() => {
		handlers.onchange = onchange;
		handlers.onrequesturl = onrequesturl;
	});

	/** The markdown last sent upward, so an echo (our own edit) is not re-applied. */
	let lastEmitted = '';

	/**
	 * Whether the ProseMirror document has changed since it was last seeded
	 * (the initial mount, or an external buffer replacement). The teardown
	 * serialization below is only allowed to report a change when this is set:
	 * re-serializing a document Milkdown cannot fully represent (tables, maths,
	 * wikilinks, …) must not mark the tab dirty on open-and-close.
	 */
	let changed = false;

	// The front matter block hidden from Milkdown and re-attached verbatim on
	// every report, plus the line ending the serialized body must be written
	// back in. Fixed for the life of the editor and recomputed only when an
	// external value replacement re-seeds it.
	let frontMatter = '';
	let lineEnding: '\n' | '\r\n' = '\n';

	onMount(() => {
		// Seed the echo guard before the async create resolves, so the
		// replace-all effect below does not re-seed (and move the cursor in) a
		// document the editor already holds.
		lastEmitted = value;
		const seed = splitFrontMatter(value);
		frontMatter = seed.frontMatter;
		lineEnding = seed.lineEnding;
		Editor.make()
			.config((ctx) => {
				ctx.set(rootCtx, container);
				// Milkdown edits the BODY only: the front matter is split off
				// before parsing and re-attached verbatim on serialize, so it
				// survives byte for byte.
				ctx.set(defaultValueCtx, seed.body);
				// Serialize back with the markers the document already uses, so an
				// edited file keeps its formatting and the saved diff stays minimal
				// (bullet '-', dominant emphasis, backtick fences, `---` rules, …).
				ctx.update(remarkStringifyOptionsCtx, (prev) => ({
					...prev,
					...wysiwygStringifyOptions(seed.body),
				}));
				ctx.update(editorViewOptionsCtx, (prev) => ({
					...prev,
					// Commit every transaction ourselves so a document change reaches
					// the tab synchronously. Milkdown's `listener` plugin debounces
					// 200ms, which is a window where a tab switch or close could drop
					// the last keystrokes; here there is no such window.
					// ProseMirror calls this with the view as `this`, and it can run
					// while the view is still being constructed (a plugin dispatches
					// from its first `view()`), before `editorViewCtx` holds it. The
					// view it hands over is the one to apply to.
					dispatchTransaction(this: EditorView, tr) {
						const next = this.state.apply(tr);
						this.updateState(next);
						status = findStatus(next);
						activeTools = computeActiveTools(next);
						if (tr.docChanged) {
							changed = true;
							const markdown = frontMatter + withLineEnding(ctx.get(serializerCtx)(next.doc), lineEnding);
							lastEmitted = markdown;
							handlers.onchange(markdown);
						}
					},
				}));
			})
			.use(commonmark)
			.use(gfm)
			.use(history)
			.use(clipboard)
			.use(cursor)
			.use(trailing)
			.use(findPlugin)
			.create()
			.then((created) => {
				editor = created;
			});

		return () => {
			const current = editor;
			if (!current) return;
			// A final safety net: `dispatchTransaction` already wrote every change,
			// so this is normally a no-op — it only fires if a change slipped past
			// the commit path. It is gated on `changed` so a lossy re-serialization
			// (a document with tables, maths, wikilinks, …) never reports an
			// edit the user did not make, which would mark the tab dirty and, on
			// save, rewrite the file.
			if (changed) {
				const markdown = frontMatter + withLineEnding(current.action(getMarkdown()), lineEnding);
				if (markdown !== lastEmitted) handlers.onchange(markdown);
			}
			void current.destroy();
		};
	});

	// An external buffer replacement — a tab switch, a reload from disk — lands
	// in `value` without passing through the editor. Re-seed it. The editor's own
	// edits already set `lastEmitted`, so they are skipped.
	$effect(() => {
		const current = editor;
		if (!current) return;
		if (value === lastEmitted) return;
		lastEmitted = value;
		// The external value is the new baseline: any earlier edits are already
		// reported, and this replacement is not the user's, so nothing is pending.
		changed = false;
		const seed = splitFrontMatter(value);
		frontMatter = seed.frontMatter;
		lineEnding = seed.lineEnding;
		current.action(replaceAll(seed.body, true));
	});

	function runCmd<T>(command: { key: CmdKey<T> }, payload?: T) {
		const current = editor;
		if (!current) return;
		current.action(callCommand(command.key, payload));
	}

	function focus() {
		const current = editor;
		if (!current) return;
		current.action((ctx) => ctx.get(editorViewCtx).focus());
	}

	async function insertLink() {
		const current = editor;
		if (!current) return;

		const selected = current.action((ctx) => {
			const view = ctx.get(editorViewCtx);
			const { from, to } = view.state.selection;
			return view.state.doc.textBetween(from, to);
		});

		const url = await handlers.onrequesturl(selected);
		if (!url) return;
		current.action(insert(`[${selected || url}](${url})`));
		focus();
	}

	function withView(action: (view: EditorView) => void) {
		editor?.action((ctx) => action(ctx.get(editorViewCtx)));
	}

	const findOptions = () => ({ query, matchCase, wholeWord });

	/** Search again with the bar's current text and options. */
	function runFind() {
		withView((view) => view.dispatch(searchTransaction(view.state, findOptions())));
	}

	function step(direction: 1 | -1) {
		withView((view) => {
			const tr = stepTransaction(view.state, direction);
			if (tr) view.dispatch(tr);
		});
	}

	function replaceCurrent() {
		withView((view) => {
			const match = currentMatch(view.state);
			if (!match) return;
			view.dispatch(replaceMatch(view.state, match, replacement));
			// The cursor now sits after the replacement: land on the next match.
			view.dispatch(searchTransaction(view.state, findOptions()));
		});
	}

	function replaceEvery() {
		withView((view) => view.dispatch(replaceAllMatches(view.state, allMatches(view.state), replacement)));
	}

	/** Opens the bar, starting from the selected text when it is a single line. */
	function openFind(withReplace: boolean) {
		withView((view) => {
			const { from, to } = view.state.selection;
			const selected = view.state.doc.textBetween(from, to, '\n');
			if (selected && !selected.includes('\n')) query = selected;
		});
		findOpen = true;
		if (withReplace) showReplace = true;
		runFind();
		// The bar mounts on the next tick.
		queueMicrotask(() => findBar?.focus());
	}

	function closeFind() {
		findOpen = false;
		withView((view) => view.dispatch(clearTransaction(view.state)));
		focus();
	}

	function onrootkeydown(e: KeyboardEvent) {
		const mod = e.ctrlKey || e.metaKey;
		if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
			e.preventDefault();
			openFind(false);
		} else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'h') {
			e.preventDefault();
			openFind(true);
		} else if (findOpen && e.key === 'F3') {
			e.preventDefault();
			step(e.shiftKey ? -1 : 1);
		} else if (findOpen && e.key === 'Escape') {
			e.preventDefault();
			closeFind();
		}
	}

	const toolGroups = $derived(
		[
			[
				{ id: 'undo', label: t('menu.undo', language), toggle: false, run: () => runCmd(undoCommand) },
				{ id: 'redo', label: t('menu.redo', language), toggle: false, run: () => runCmd(redoCommand) },
			],
			[
				{ id: 'heading-1', label: t('menu.heading1', language), toggle: true, run: () => runCmd(wrapInHeadingCommand, 1) },
				{ id: 'heading-2', label: t('menu.heading2', language), toggle: true, run: () => runCmd(wrapInHeadingCommand, 2) },
				{ id: 'heading-3', label: t('menu.heading3', language), toggle: true, run: () => runCmd(wrapInHeadingCommand, 3) },
			],
			[
				{ id: 'bold', label: t('menu.bold', language), toggle: true, run: () => runCmd(toggleStrongCommand) },
				{ id: 'italic', label: t('menu.italic', language), toggle: true, run: () => runCmd(toggleEmphasisCommand) },
				{ id: 'strikethrough', label: t('menu.strikethrough', language), toggle: true, run: () => runCmd(toggleStrikethroughCommand) },
				{ id: 'inline-code', label: t('menu.inlineCode', language), toggle: true, run: () => runCmd(toggleInlineCodeCommand) },
			],
			[
				{ id: 'bullet-list', label: t('menu.bulletList', language), toggle: true, run: () => runCmd(wrapInBulletListCommand) },
				{ id: 'numbered-list', label: t('menu.numberedList', language), toggle: true, run: () => runCmd(wrapInOrderedListCommand) },
				{ id: 'quote', label: t('menu.quote', language), toggle: true, run: () => runCmd(wrapInBlockquoteCommand) },
				{ id: 'code-block', label: t('menu.codeBlock', language), toggle: true, run: () => runCmd(createCodeBlockCommand) },
			],
			[
				{ id: 'link', label: t('menu.link', language), toggle: false, run: () => void insertLink() },
				{ id: 'table', label: t('menu.insertTable', language), toggle: false, run: () => runCmd(insertTableCommand, { row: 3, col: 3 }) },
				{ id: 'hr', label: t('menu.horizontalRule', language), toggle: false, run: () => runCmd(insertHrCommand) },
			],
		] as const,
	);
</script>

<div class="wysiwyg-root" role="presentation" onkeydown={onrootkeydown}>
	<div class="wysiwyg-toolbar" role="toolbar" aria-label={t('menu.editor', language)} bind:clientHeight={toolbarHeight}>
		<div class="wysiwyg-tools">
			{#each toolGroups as group, groupIndex (groupIndex)}
				{#if groupIndex > 0}
					<span class="wysiwyg-sep" aria-hidden="true"></span>
				{/if}
				{#each group as tool (tool.id)}
					<button
						type="button"
						class="wysiwyg-btn"
						class:active={activeTools.has(tool.id)}
						aria-label={tool.label}
						aria-pressed={tool.toggle ? activeTools.has(tool.id) : undefined}
						title={tool.label}
						onmousedown={(e) => e.preventDefault()}
						onclick={tool.run}>
						{@render renderToolIcon(tool.id)}
					</button>
				{/each}
			{/each}
		</div>
	</div>
	{#if findOpen}
		<FindBar
			bind:this={findBar}
			bind:query
			bind:replacement
			bind:matchCase
			bind:wholeWord
			bind:showReplace
			{status}
			{language}
			onchange={runFind}
			onnext={() => step(1)}
			onprevious={() => step(-1)}
			onreplace={replaceCurrent}
			onreplaceall={replaceEvery}
			onclose={closeFind} />
	{/if}
	<div class="wysiwyg-surface" bind:this={container}></div>
</div>

{#snippet renderToolIcon(id: string)}
	{#if id === 'undo'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
	{:else if id === 'redo'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>
	{:else if id === 'bold'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h9a4 4 0 0 0 0-8H6v8Zm0 0h10a4 4 0 0 1 0 8H6v-8Z"/></svg>
	{:else if id === 'italic'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/></svg>
	{:else if id === 'strikethrough'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/></svg>
	{:else if id === 'inline-code'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
	{:else if id === 'code-block'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m10 10-2 2 2 2"/><path d="m14 10 2 2-2 2"/></svg>
	{:else if id === 'quote'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M4.5 6H10v6.5C10 16 7.5 18 4 18v-2.5c2 0 3.5-1 3.5-3H4.5V6zM14.5 6H20v6.5C20 16 17.5 18 14 18v-2.5c2 0 3.5-1 3.5-3h-3V6z"/></svg>
	{:else if id === 'heading-1' || id === 'heading-2' || id === 'heading-3'}
		<svg width="15" height="15" viewBox="0 0 24 24"><text x="2" y="15" font-family="system-ui, sans-serif" font-weight="700" font-size="12" fill="currentColor">H</text><text x="12" y="17" font-family="system-ui, sans-serif" font-weight="700" font-size="9" fill="currentColor">{id === 'heading-1' ? '1' : id === 'heading-2' ? '2' : '3'}</text></svg>
	{:else if id === 'bullet-list'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><circle cx="3.5" cy="6" r="1.5" fill="currentColor"/><circle cx="3.5" cy="12" r="1.5" fill="currentColor"/><circle cx="3.5" cy="18" r="1.5" fill="currentColor"/></svg>
	{:else if id === 'numbered-list'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" x2="21" y1="6" y2="6"/><line x1="10" x2="21" y1="12" y2="12"/><line x1="10" x2="21" y1="18" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>
	{:else if id === 'hr'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" x2="20" y1="12" y2="12"/></svg>
	{:else if id === 'link'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
	{:else if id === 'table'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/></svg>
	{/if}
{/snippet}

<style>
	.wysiwyg-root {
		display: flex;
		flex-direction: column;
		flex: 1;
		height: 100%;
		width: 100%;
		min-width: 0;
		background: var(--color-canvas-default);
		color: var(--color-fg-default);
	}

	.wysiwyg-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 4px;
		min-height: 34px;
		padding: 3px 8px;
		border-bottom: 1px solid var(--color-border-muted);
		background: var(--color-canvas-default);
		box-sizing: border-box;
		user-select: none;
		flex: 0 0 auto;
	}

	.wysiwyg-tools {
		display: flex;
		align-items: center;
		gap: 2px;
		flex-wrap: wrap;
		min-width: 0;
		flex: 1;
	}

	.wysiwyg-btn {
		width: 28px;
		height: 28px;
		flex: 0 0 28px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: var(--color-fg-muted);
		cursor: pointer;
		padding: 0;
		transition: background-color 0.15s, color 0.15s, border-color 0.15s;
		font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
	}

	.wysiwyg-btn:hover {
		background: var(--color-neutral-muted, rgba(175, 184, 193, 0.2));
		color: var(--color-fg-default);
		border-color: var(--color-border-muted);
	}

	.wysiwyg-btn.active {
		background: color-mix(in srgb, var(--color-accent-fg) 14%, transparent);
		color: var(--color-accent-fg);
		border-color: color-mix(in srgb, var(--color-accent-fg) 30%, transparent);
	}

	.wysiwyg-sep {
		width: 1px;
		height: 16px;
		background: var(--color-border-muted);
		margin: 0 3px;
		flex-shrink: 0;
	}

	.wysiwyg-btn:focus-visible {
		outline: 2px solid var(--color-accent-fg);
		outline-offset: 1px;
	}

	.wysiwyg-surface {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		min-height: 0;
	}

	/* Milkdown builds its DOM imperatively, outside Svelte, so its content is
	   styled through :global() selectors anchored to this component's root. The
	   colours are the app's own CSS variables, so light and dark follow the
	   resolved theme with no editor-specific work. */
	.wysiwyg-surface :global(.find-match) {
		background: color-mix(in srgb, var(--color-attention-fg) 28%, transparent);
		border-radius: 2px;
	}

	.wysiwyg-surface :global(.find-match-current) {
		background: color-mix(in srgb, var(--color-attention-fg) 55%, transparent);
	}

	.wysiwyg-surface :global(.milkdown) {
		box-sizing: border-box;
		min-height: 100%;
		max-width: 820px;
		margin: 0 auto;
		padding: 24px 32px;
		color: var(--color-fg-default);
		font-size: calc(16px * var(--editor-zoom, 1));
		line-height: 1.6;
		outline: none;
	}

	.wysiwyg-surface :global(.ProseMirror) {
		outline: none;
		caret-color: var(--color-accent-fg);
	}

	.wysiwyg-surface :global(.ProseMirror-selectednode) {
		outline: 2px solid var(--color-accent-fg);
	}

	.wysiwyg-surface :global(.milkdown h1),
	.wysiwyg-surface :global(.milkdown h2),
	.wysiwyg-surface :global(.milkdown h3),
	.wysiwyg-surface :global(.milkdown h4),
	.wysiwyg-surface :global(.milkdown h5),
	.wysiwyg-surface :global(.milkdown h6) {
		margin: 1.2em 0 0.6em;
		font-weight: 600;
		line-height: 1.25;
	}

	.wysiwyg-surface :global(.milkdown h1) {
		font-size: 2em;
		border-bottom: 1px solid var(--color-border-muted);
		padding-bottom: 0.3em;
	}
	.wysiwyg-surface :global(.milkdown h2) {
		font-size: 1.5em;
		border-bottom: 1px solid var(--color-border-muted);
		padding-bottom: 0.3em;
	}
	.wysiwyg-surface :global(.milkdown h3) {
		font-size: 1.25em;
	}
	.wysiwyg-surface :global(.milkdown h4) {
		font-size: 1em;
	}
	.wysiwyg-surface :global(.milkdown h5) {
		font-size: 0.875em;
	}
	.wysiwyg-surface :global(.milkdown h6) {
		font-size: 0.85em;
		color: var(--color-fg-muted);
	}

	.wysiwyg-surface :global(.milkdown p) {
		margin: 0.6em 0;
	}

	.wysiwyg-surface :global(.milkdown a) {
		color: var(--color-accent-fg);
	}

	.wysiwyg-surface :global(.milkdown blockquote) {
		margin: 0.8em 0;
		padding: 0 1em;
		color: var(--color-fg-muted);
		border-left: 0.25em solid var(--color-border-default);
	}

	.wysiwyg-surface :global(.milkdown ul),
	.wysiwyg-surface :global(.milkdown ol) {
		padding-left: 2em;
		margin: 0.6em 0;
	}

	.wysiwyg-surface :global(.milkdown li) {
		margin: 0.2em 0;
	}

	.wysiwyg-surface :global(.milkdown code) {
		padding: 0.2em 0.4em;
		margin: 0;
		font-size: 0.9em;
		background: var(--color-canvas-subtle);
		border-radius: 6px;
		font-family: var(--code-font, Consolas, monospace);
	}

	.wysiwyg-surface :global(.milkdown pre) {
		margin: 0.8em 0;
		padding: 12px;
		background: var(--color-canvas-subtle);
		border-radius: 6px;
		overflow-x: auto;
	}

	.wysiwyg-surface :global(.milkdown pre code) {
		padding: 0;
		background: transparent;
		font-size: 0.9em;
	}

	.wysiwyg-surface :global(.milkdown hr) {
		margin: 1.5em 0;
		border: 0;
		border-top: 1px solid var(--color-border-default);
	}

	.wysiwyg-surface :global(.milkdown img) {
		max-width: 100%;
	}

	.wysiwyg-surface :global(.milkdown table) {
		border-collapse: collapse;
		margin: 0.8em 0;
		width: 100%;
	}

	.wysiwyg-surface :global(.milkdown th),
	.wysiwyg-surface :global(.milkdown td) {
		border: 1px solid var(--color-border-default);
		padding: 6px 12px;
	}

	.wysiwyg-surface :global(.milkdown th) {
		background: var(--color-canvas-subtle);
		font-weight: 600;
	}
</style>
