import assert from 'node:assert/strict';
import { after, before, describe, test, type TestContext } from 'node:test';

import postcss, { type Root } from 'postcss';
import { parse as parseSvelte } from 'svelte/compiler';

import { installShimDom, parseHtml } from './renderProtocolDom.ts';
import { stubTauriInvoke } from './tauriInvoke.js';
import { addFrontMatterListItems, getFrontMatterListItems, frontMatterFenceLines, getMarkdownBodyWithoutFrontMatter, parseFrontMatter, removeFrontMatterListItem, updateFrontMatterField, updateFrontMatterListItem } from '../src/lib/utils/frontMatter.js';
import { readSource } from './sourceTree.js';
import { getMarkdownLinkTarget, hasMarkdownLinkExtension, resolveMarkdownTargetPath } from '../src/lib/utils/markdownLinks.js';

/*
 * Issue #604's second item: Enter on a list item continues the list, Tab
 * changes its level, and Enter on an empty item ends the list.
 *
 * WHAT IS RUN AND WHAT IS ONLY READ
 *
 * The decision — "given this line and this caret, what should the next line
 * say" — is a pure function in `src/lib/utils/listEditing.ts` and is CALLED
 * here, once per shape of list item and block quote the app claims to
 * understand.
 *
 * The key handlers themselves run in 'editing keys in the editor' below.
 */





describe('callout marker', () => {
	// The shim globals are this block's alone: install them for its tests and put
	// back whatever was there before.
	const SHIM_GLOBALS = ['DOMParser', 'document', 'Node', 'NodeFilter'] as const;
	const saved = new Map<string, PropertyDescriptor | undefined>();
	let processMarkdownHtml: (typeof import('../src/lib/utils/markdown.ts'))['processMarkdownHtml'];
	before(async () => {
		for (const name of SHIM_GLOBALS) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		installShimDom();
		({ processMarkdownHtml } = await import('../src/lib/utils/markdown.ts'));
	});
	after(() => {
		for (const [name, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	});

	// Only the text a quote opens with can make it a callout, as in Obsidian and
	// GitHub. The marker used to be looked for in every text node of the quote, so
	// a `[!note]` shown in inline code, a code block or a nested quote turned the
	// whole quote into a callout and the matched text was deleted.

	function render(html: string) {
		return parseHtml(processMarkdownHtml(html, '/doc.md', new Set()));
	}

	test('a marker in inline code is text, not a callout', () => {
		const root = render('<blockquote>\n<p>Use <code>[!note]</code> to make a callout</p>\n</blockquote>');
		assert.equal(root.querySelector('.markdown-alert'), null);
		assert.equal(root.querySelector('code')?.textContent, '[!note]');
	});

	test('a marker at the top of a code block is text, not a callout', () => {
		const root = render('<blockquote>\n<pre><code>[!warning] Title\n</code></pre>\n</blockquote>');
		assert.equal(root.querySelector('.markdown-alert'), null);
		assert.equal(root.querySelector('code')?.textContent, '[!warning] Title\n');
	});

	test('a callout in a nested quote leaves the outer quote alone', () => {
		const root = render(
			'<blockquote>\n<p>Outer</p>\n<blockquote>\n<p>[!tip] Inner</p>\n</blockquote>\n</blockquote>',
		);
		const outer = root.querySelector('blockquote');
		assert.ok(outer, 'the outer quote is still a quote');
		assert.equal(outer.querySelector('p')?.textContent, 'Outer');
		const tip = outer.querySelector('.markdown-alert-tip');
		assert.ok(tip, 'the inner quote is the callout');
		assert.equal(tip.querySelector('.callout-title-inner')?.textContent, 'Inner');
	});

	test('a quote that opens with the marker is still a callout, fold and title included', () => {
		const root = render('<blockquote>\n<p>[!note]+ My title<br />\nbody</p>\n</blockquote>');
		const callout = root.querySelector('.markdown-alert-note');
		assert.ok(callout);
		assert.ok(callout.classList.contains('callout-foldable'));
		assert.equal(callout.querySelector('.callout-title-inner')?.textContent, 'My title');
		assert.match(callout.querySelector('.content-inner')?.textContent ?? '', /body/);
	});
});


describe('front matter parsing and editing', () => {
	const planMarkdown = `---
type: plan
name: dflex-logger-onoff-dir-synlog
title: "Sterowanie loggerami dFLEX: on/off domyslnie OFF"
project: "dflex"
keywords: [logger, synlog, appconfig, onoff, codesite]
created: 2026-06-26T18:29:35+02:00
status: in-progress
---

## Summary

Body text.
`;

	test('parseFrontMatter extracts top-level YAML metadata and body', () => {
		const parsed = parseFrontMatter(planMarkdown);

		assert.equal(parsed.exists, true);
		assert.equal(parsed.valid, true);
		assert.equal(parsed.body, '## Summary\n\nBody text.\n');
		assert.deepEqual(
			parsed.fields.map((field) => [field.key, field.kind, field.displayValue]),
			[
				['type', 'string', 'plan'],
				['name', 'string', 'dflex-logger-onoff-dir-synlog'],
				['title', 'string', 'Sterowanie loggerami dFLEX: on/off domyslnie OFF'],
				['project', 'string', 'dflex'],
				['keywords', 'list', 'logger, synlog, appconfig, onoff, codesite'],
				['created', 'string', '2026-06-26T18:29:35+02:00'],
				['status', 'string', 'in-progress'],
			],
		);
	});

	test('parseFrontMatter ignores thematic breaks outside the first document line', () => {
		const markdown = `# Title

---

Body`;
		const parsed = parseFrontMatter(markdown);

		assert.equal(parsed.exists, false);
		assert.equal(parsed.body, markdown);
		assert.equal(getMarkdownBodyWithoutFrontMatter(markdown), markdown);
	});

	test('parseFrontMatter strips invalid front matter from rendered body but keeps the error', () => {
		const parsed = parseFrontMatter(`---
title: [broken
---

# Body
`);

		assert.equal(parsed.exists, true);
		assert.equal(parsed.valid, false);
		assert.match(parsed.error || '', /Flow sequence|unexpected|end/i);
		assert.equal(parsed.body, '# Body\n');
		assert.deepEqual(parsed.fields, []);
	});

	test('updateFrontMatterField updates one property without changing markdown body', () => {
		const updated = updateFrontMatterField(planMarkdown, 'status', 'done');
		const parsed = parseFrontMatter(updated);

		assert.equal(parsed.exists, true);
		assert.equal(parsed.valid, true);
		assert.equal(parsed.fields.find((field) => field.key === 'status')?.displayValue, 'done');
		assert.equal(parsed.body, '## Summary\n\nBody text.\n');
	});

	test('updateFrontMatterField preserves CRLF documents', () => {
		const markdown = '---\r\nname: old\r\ntags:\r\n  - one\r\n---\r\n\r\nText\r\n';
		const updated = updateFrontMatterField(markdown, 'name', 'new');

		assert.match(updated, /^---\r\nname: new\r\ntags:/);
		assert.equal(parseFrontMatter(updated).body, 'Text\r\n');
	});

	test('getFrontMatterListItems returns string tag values for YAML lists', () => {
		const parsed = parseFrontMatter(planMarkdown);
		const keywords = parsed.fields.find((field) => field.key === 'keywords');

		assert.ok(keywords);
		assert.deepEqual(getFrontMatterListItems(keywords), ['logger', 'synlog', 'appconfig', 'onoff', 'codesite']);
	});

	test('front matter tag helpers add, edit, and remove tags predictably', () => {
		const original = ['logger', 'synlog'];

		assert.deepEqual(addFrontMatterListItems(original, [' appconfig ']), ['logger', 'synlog', 'appconfig']);
		assert.deepEqual(addFrontMatterListItems(original, ['logger']), ['logger', 'synlog']);
		assert.deepEqual(addFrontMatterListItems(original, [' ', 'synlog', 'codesite, onoff']), ['logger', 'synlog', 'codesite', 'onoff']);
		assert.deepEqual(updateFrontMatterListItem(original, 1, ' syslog '), ['logger', 'syslog']);
		assert.deepEqual(updateFrontMatterListItem(original, 1, 'logger'), ['logger', 'synlog']);
		assert.deepEqual(updateFrontMatterListItem(original, 1, ' '), ['logger', 'synlog']);
		assert.deepEqual(removeFrontMatterListItem(original, 0), ['synlog']);
	});

	test('updateFrontMatterField writes edited keywords as a YAML list', () => {
		const updated = updateFrontMatterField(planMarkdown, 'keywords', ['logger', 'synlog']);
		const parsed = parseFrontMatter(updated);
		const keywords = parsed.fields.find((field) => field.key === 'keywords');

		assert.ok(keywords);
		assert.deepEqual(getFrontMatterListItems(keywords), ['logger', 'synlog']);
		assert.equal(parsed.body, '## Summary\n\nBody text.\n');
	});
});


// `[[Notes#Setup]]` — the exact string the "Copy Reference" context-menu item
// writes to the clipboard — used to render as literal text: the Rust
// preprocessor only understood the same-document form `[[#Setup]]`. It now
// emits a plain markdown link, and these tests pin the *shape* of the href it
// emits against the frontend that has to claim it. The Rust side owns the
// other half of this contract in src-tauri/src/lib.rs (`copy_reference_output_
// becomes_a_real_link` and friends); if either half moves, the other fails.
//
// Scope: only the heading-bearing forms (`[[#h]]`, `[[file#h]]`, and their
// `|alias` variants) are rewritten. Obsidian's bare note link `[[Notes]]` is
// a separate feature, not this defect, and is left literal.
//
// Not covered here: whether the file exists, and the actual tab-opening (that
// runs inside MarkdownViewer.svelte and needs a live webview). These tests
// only prove the href is recognized as a local markdown target and decodes
// back to the path and anchor the document asked for.
describe('wikilink file targets', () => {
	// href values as produced by process_wikilinks() in src-tauri/src/lib.rs.
	// Only the heading-bearing forms appear: a wikilink with no `#` is
	// deliberately left as literal text and never reaches the frontend at all.
	const cases: { wikilink: string; href: string; path: string; hash: string }[] = [
		{ wikilink: '[[Notes#Setup]]', href: 'Notes.md#setup', path: 'Notes.md', hash: 'setup' },
		{ wikilink: '[[docs/Guide#Setup]]', href: 'docs/Guide.md#setup', path: 'docs/Guide.md', hash: 'setup' },
		{ wikilink: '[[docs/Guide#1. 概述|Overview]]', href: 'docs/Guide.md#1-概述', path: 'docs/Guide.md', hash: '1-概述' },
		{ wikilink: '[[My Notes (v2)#Setup]]', href: 'My%20Notes%20%28v2%29.md#setup', path: 'My Notes (v2).md', hash: 'setup' },
		{ wikilink: '[[Notes#^abc123]]', href: 'Notes.md#abc123', path: 'Notes.md', hash: 'abc123' },
		{ wikilink: '[[log.txt#Errors]]', href: 'log.txt#errors', path: 'log.txt', hash: 'errors' },
	];

	test('every href the wikilink rewriter emits is claimed as a local markdown target', () => {
		for (const { wikilink, href, path, hash } of cases) {
			const target = getMarkdownLinkTarget(href);
			assert.notEqual(target, null, `${wikilink} -> ${href} was not claimed as a markdown link`);
			assert.equal(target?.path, path, `${wikilink} resolved to the wrong path`);
			assert.equal(target?.hash, hash, `${wikilink} resolved to the wrong anchor`);
		}
	});

	test('a bare note name without the appended extension would not be claimed', () => {
		// This is why the rewriter appends ".md": Obsidian omits the extension,
		// but getMarkdownLinkTarget() keys entirely off it, and an unclaimed href
		// falls through to the external-URL opener instead of opening a tab.
		assert.equal(hasMarkdownLinkExtension('Notes'), false);
		assert.equal(getMarkdownLinkTarget('Notes#setup'), null);
	});

	test('wikilink targets resolve relative to the document that contains them', () => {
		const target = getMarkdownLinkTarget('docs/Guide.md#1-概述');
		assert.notEqual(target, null);
		assert.equal(resolveMarkdownTargetPath('/vault/index.md', target!), '/vault/docs/Guide.md');
	});

	test('non-markdown wikilink targets are left literal rather than emitted as links', () => {
		// The rewriter declines these (`wikilinks_to_files_the_viewer_cannot_open_
		// stay_literal`); this asserts the reason — the frontend would not claim
		// them either.
		assert.equal(getMarkdownLinkTarget('report.pdf#Intro'), null);
		assert.equal(getMarkdownLinkTarget('diagram.svg#part'), null);
	});
});

/*
 * Issue #604: the condition the app DECLARES for Enter, Tab and Shift+Tab — the
 * `when` expression `editorKeyCommands` hands Monaco — because an Enter binding
 * that forgets `!suggestWidgetVisible` breaks the completion popup silently.
 */
describe('list keys in the editor', () => {
	// ------------------------------------------------------------- the when clauses

});

// #675: Monaco draws the find widget's button tooltips into a `.context-view`
// it appends beside the editor, above the target, and the widget sits at the
// top edge of the editor pane, so the tooltip lands in the strip the pane and
// `.editor-outer` clip away, and behind the fixed title bar. Both halves of the
// fix are CSS a test without a real layout cannot render, so they are read off
// the parsed stylesheets.
describe('find widget tooltip clip', () => {
	const styles = postcss.parse(readSource('src/styles.css'));
	const titleBarAst = parseSvelte(readSource('src/lib/components/TitleBar.svelte'), { modern: true });
	assert.ok(titleBarAst.css, 'TitleBar.svelte must keep its <style> block');
	const titleBar = postcss.parse(titleBarAst.css.content.styles);

	function declarations(root: Root, selector: string, property: string) {
		const found: { value: string; important: boolean }[] = [];
		root.walkRules((rule) => {
			if (!rule.selectors.includes(selector)) return;
			rule.walkDecls(property, (decl) => {
				found.push({ value: decl.value, important: decl.important });
			});
		});
		return found;
	}

	test('the find widget tooltip escapes both clips, and only while the widget is up', () => {
		// Not `overflow: clip` with a margin: WebKit ships `clip` without
		// `overflow-clip-margin`, so that spelling is a no-op on macOS and Linux.
		const rules: string[][] = [];
		styles.walkRules((rule) => {
			if (rule.some((node) => node.type === 'decl' && node.prop === 'overflow' && node.value === 'visible')) {
				rules.push(rule.selectors);
			}
		});
		assert.ok(
			rules.some((selectors) =>
				selectors.length === 2
				&& selectors[0] === '.pane.editor-pane:has(.find-widget.visible)'
				&& selectors[1] === '.pane.editor-pane:has(.find-widget.visible) .editor-outer'),
			'the pane and .editor-outer must both drop their clip while .find-widget.visible is inside',
		);
	});

	test('the tooltip outranks the title bar it now paints over', () => {
		const [contextView] = declarations(styles, '.context-view', 'z-index');
		const [titleBarZ] = declarations(titleBar, '.custom-title-bar', 'z-index');
		assert.ok(contextView, 'expected a z-index on .context-view');
		assert.ok(titleBarZ, 'expected a z-index on .custom-title-bar');
		assert.ok(
			Number(contextView.value) > Number(titleBarZ.value),
			`.context-view (${contextView.value}) must stay above .custom-title-bar (${titleBarZ.value})`,
		);
		// Monaco writes `z-index: 2576` inline on the node, so the rule only lands
		// if it is marked important.
		assert.equal(contextView.important, true);
	});
});
