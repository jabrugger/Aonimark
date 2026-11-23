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
	let editor = $state<Editor | null>(null);

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

	const tools = $derived(
		[
			{ id: 'undo', label: t('menu.undo', language), run: () => runCmd(undoCommand) },
			{ id: 'redo', label: t('menu.redo', language), run: () => runCmd(redoCommand) },
			{ id: 'bold', label: t('menu.bold', language), run: () => runCmd(toggleStrongCommand) },
			{ id: 'italic', label: t('menu.italic', language), run: () => runCmd(toggleEmphasisCommand) },
			{ id: 'strikethrough', label: t('menu.strikethrough', language), run: () => runCmd(toggleStrikethroughCommand) },
			{ id: 'inline-code', label: t('menu.inlineCode', language), run: () => runCmd(toggleInlineCodeCommand) },
			{ id: 'code-block', label: t('menu.codeBlock', language), run: () => runCmd(createCodeBlockCommand) },
			{ id: 'quote', label: t('menu.quote', language), run: () => runCmd(wrapInBlockquoteCommand) },
			{ id: 'heading-1', label: t('menu.heading1', language), run: () => runCmd(wrapInHeadingCommand, 1) },
			{ id: 'heading-2', label: t('menu.heading2', language), run: () => runCmd(wrapInHeadingCommand, 2) },
			{ id: 'heading-3', label: t('menu.heading3', language), run: () => runCmd(wrapInHeadingCommand, 3) },
			{ id: 'bullet-list', label: t('menu.bulletList', language), run: () => runCmd(wrapInBulletListCommand) },
			{ id: 'numbered-list', label: t('menu.numberedList', language), run: () => runCmd(wrapInOrderedListCommand) },
			{ id: 'hr', label: t('menu.horizontalRule', language), run: () => runCmd(insertHrCommand) },
			{ id: 'link', label: t('menu.link', language), run: () => void insertLink() },
			{ id: 'table', label: t('menu.insertTable', language), run: () => runCmd(insertTableCommand, { row: 3, col: 3 }) },
		] as const,
	);
</script>

<div class="wysiwyg-root">
	<div class="wysiwyg-toolbar" role="toolbar" aria-label={t('menu.editor', language)} bind:clientHeight={toolbarHeight}>
		<div class="wysiwyg-tools">
			{#each tools as tool (tool.id)}
				<button
					type="button"
					class="wysiwyg-btn"
					aria-label={tool.label}
					title={tool.label}
					onmousedown={(e) => e.preventDefault()}
					onclick={tool.run}>
					{@render renderToolIcon(tool.id)}
				</button>
			{/each}
		</div>
	</div>
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
	.wysiwyg-surface :global(.milkdown) {
		box-sizing: border-box;
		min-height: 100%;
		padding: 20px max(24px, 10%);
		color: var(--color-fg-default);
		font-size: 16px;
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
