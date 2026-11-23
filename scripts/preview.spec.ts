import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { flashCopiedLabel, renderRichContent, replacedBy, type RichContentLibraries } from '../src/lib/utils/richContent.js';
import { readDiagramSource } from '../src/lib/utils/mermaidPrint.js';
import { resetDiagramCache } from '../src/lib/utils/diagramCache.js';
import { toggleFold } from '../src/lib/utils/foldState.js';
import { type AnchorBox, type AnchorNode, findAnchorElement, getPreviewOffsetForSourceLine, getSourceLineAtPreviewOffset } from '../src/lib/utils/previewAnchor.js';
import { processMarkdownHtml } from '../src/lib/utils/markdown.js';
import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';
import { blockMiddleClickNavigation, linkTooltipFor } from '../src/lib/utils/previewLinks.js';
import { imageMenuItems, saveImageAs, type SaveImageDeps } from '../src/lib/utils/viewerContextMenu.js';
import { loadLocale } from '../src/lib/utils/i18n.js';
import { type DomPoint, pointAtSource, sourceAtPoint, type SourcePoint } from '../src/lib/utils/previewCursor.js';
import { ALLOWED_MARKDOWN_URI_REGEXP, sanitizeMarkdownFragment, sanitizeMarkdownHtml } from '../src/lib/utils/sanitize.js';
import blocks from './fixtures/markdown-syntax.blocks.json';
import DOMPurify from 'dompurify';
import { readSource } from './sourceTree.js';

/**
 * #1087: WebKit navigates the whole window on a middle-click's `auxclick`, and
 * the app became a 404 page. The window-level guard cancels it for any link.
 */
describe('middle-click navigation guard', () => {
	function dispatch(type: string, button: number, html: string) {
		document.body.innerHTML = html;
		const target = document.querySelector('[data-target]')!;
		const guard = (e: Event) => blockMiddleClickNavigation(e as MouseEvent);
		const reached: string[] = [];
		window.addEventListener(type, guard, true);
		target.addEventListener(type, () => void reached.push('target'));
		const event = new MouseEvent(type, { button, bubbles: true, cancelable: true });
		target.dispatchEvent(event);
		window.removeEventListener(type, guard, true);
		document.body.innerHTML = '';
		return { prevented: event.defaultPrevented, reached };
	}

	test('a middle-click on a link is cancelled before any handler sees it', () => {
		for (const type of ['auxclick', 'click']) {
			assert.deepEqual(dispatch(type, 1, '<a href="b.md#deep-section"><span data-target>b</span></a>'), { prevented: true, reached: [] }, type);
		}
	});

	test('other buttons and non-links are left alone', () => {
		assert.deepEqual(dispatch('click', 0, '<a data-target href="b.md">b</a>'), { prevented: false, reached: ['target'] });
		assert.deepEqual(dispatch('auxclick', 1, '<span data-target>x</span>'), { prevented: false, reached: ['target'] });
	});
});

/**
 * Clicking a code block's Copy label twice within 1.5 s left it reading
 * "Copied!" for good: the second click saved "Copied!" as the label to restore.
 */
describe('copy button label flash', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test('a second copy inside the 1.5 s still restores the language name', () => {
		vi.useFakeTimers();
		const label = document.createElement('button');
		label.textContent = 'typescript';

		flashCopiedLabel(label);
		vi.advanceTimersByTime(500);
		flashCopiedLabel(label);
		expect(label.innerHTML).toBe('Copied!');

		vi.advanceTimersByTime(1500);
		expect(label.innerHTML).toBe('typescript');
		expect(label.classList.contains('copied')).toBe(false);

		// And the label still works after that.
		flashCopiedLabel(label);
		expect(label.innerHTML).toBe('Copied!');
		vi.advanceTimersByTime(1500);
		expect(label.innerHTML).toBe('typescript');
	});
});

/**
 * A block with a language used to show only the language name, in 9 px text
 * at 30 % opacity — it read as a caption, and readers did not find the copy
 * button at all. Every label now carries the copy icon; the name sits beside it.
 */
describe('copy button markup', () => {
	const libraries: RichContentLibraries = {
		hljs: { getLanguage: () => undefined, highlight: () => ({ value: '' }) },
		katex: { renderToString: (source: string) => source },
		renderMathInElement: () => {},
		mermaid: { initialize: () => {}, render: async () => ({ svg: '<svg></svg>' }) },
	};

	async function labelFor(html: string): Promise<HTMLElement> {
		const article = document.createElement('div');
		article.innerHTML = html;
		document.body.replaceChildren(article);
		await renderRichContent({ roots: [article], libraries, mermaidTheme: 'default', onCopyCode: () => {} });
		return article.querySelector('.lang-label') as HTMLElement;
	}

	test('a block with a language shows the copy icon and the language name', async () => {
		const label = await labelFor('<pre><code class="language-bash">echo hi</code></pre>');
		expect(label.querySelector('svg')).not.toBeNull();
		expect(label.querySelector('.lang-label-name')!.textContent).toBe('bash');
		expect(label.textContent).toBe('bash');
	});

	test('a block with no language shows the icon alone', async () => {
		const label = await labelFor('<pre><code>plain text</code></pre>');
		expect(label.querySelector('svg')).not.toBeNull();
		expect(label.querySelector('.lang-label-name')).toBeNull();
		expect(label.textContent).toBe('');
	});
});

/**
 * Switching theme has to re-draw the diagrams, and until this file existed it
 * did not — in any mode, for any theme.
 *
 * Mermaid bakes fills, strokes and label colours into the SVG as attributes, so
 * a stylesheet cannot retarget them; `mermaidPrint.ts` says why at length, and
 * re-rendering is the answer it already reaches for on the way to a PDF. The
 * preview's own theme change was supposed to do the same thing through
 * `renderRichContent`, and could not: that function finds diagrams by
 * `pre code`, and a diagram that has been drawn once has no `<pre>` any more —
 * it was replaced by the `.mermaid-diagram` container holding the SVG.
 *
 * That was invisible while the preview was `{@html sanitizedHtml}`, because
 * every render put the whole document back as source. the block patch (#632)
 * keeps enriched nodes across renders instead, and from then on a theme change
 * reached no diagram at all. The `<pre>` is gone, `patch.inserted` is empty on
 * a re-render of the same document, and typing does not help either: the
 * diagram's markup is unchanged, so the patch keeps the node.
 *
 * The libraries are stood in for at the same boundary `exportRichContent` and
 * `richContentIdempotence` use. What is under test is Markpad's bookkeeping:
 * which containers it decides are stale, and what it does to them.
 */
describe('diagram theme refresh', () => {
	const SOURCE = 'graph TD;A-->B;';

	/** Records every draw so "did it re-render" is a count, not an inference. */
	function libraries(draws: string[]): RichContentLibraries {
		let theme = 'unset';
		return {
			hljs: { getLanguage: () => undefined, highlight: () => ({ value: '' }) },
			katex: { renderToString: (source: string) => source },
			renderMathInElement: () => {},
			mermaid: {
				initialize: (config: { theme: string }) => {
					theme = config.theme;
				},
				render: async (id: string, source: string) => {
					draws.push(`${theme}:${source}`);
					return { svg: `<svg id="${id}" data-drawn-for="${theme}"></svg>` };
				},
			},
		} as any;
	}

	function article(html: string): HTMLElement {
		const element = document.createElement('div');
		element.innerHTML = html;
		document.body.replaceChildren(element);
		return element;
	}

	async function render(root: HTMLElement, mermaidTheme: string, draws: string[], seed = 0) {
		await renderRichContent({
			roots: [root],
			libraries: libraries(draws),
			mermaidTheme,
			idFactory: (index) => `d${seed}-${index}`,
		});
	}

	function drawnFor(root: ParentNode): string | null {
		return root.querySelector('.mermaid-diagram svg')?.getAttribute('data-drawn-for') ?? null;
	}

	const PRE = `<pre data-sourcepos="1:1-3:3"><code class="language-mermaid">${SOURCE}</code></pre>`;

	describe('a theme change', () => {
		test('re-draws a diagram that is already on screen', async () => {
			resetDiagramCache();
			const draws: string[] = [];
			const root = article(PRE);

			await render(root, 'dark', draws);
			expect(drawnFor(root)).toBe('dark');

			// The whole-article pass a theme change makes. There is no `<pre>` left.
			expect(root.querySelectorAll('pre code').length).toBe(0);
			await render(root, 'neutral', draws, 1);

			expect(drawnFor(root)).toBe('neutral');
			expect(draws).toEqual([`dark:${SOURCE}`, `neutral:${SOURCE}`]);
		});

		test('leaves the source on the container, so the PDF path still works', async () => {
			resetDiagramCache();
			const root = article(PRE);
			await render(root, 'dark', []);
			await render(root, 'neutral', [], 1);

			expect(readDiagramSource(root.querySelector('.mermaid-diagram')!)).toBe(SOURCE);
		});
	});

	describe('a pass that is not a theme change', () => {
		test('does not re-draw a diagram already in the theme being asked for', async () => {
			resetDiagramCache();
			const draws: string[] = [];
			const root = article(PRE);

			await render(root, 'dark', draws);
			// `syncPreviewForPrint` and a re-activated tab both re-run this over the
			// whole host without the theme having moved.
			await render(root, 'dark', draws, 1);
			await render(root, 'dark', draws, 2);

			expect(draws).toEqual([`dark:${SOURCE}`]);
		});

	});

	/**
	 * Mermaid's config is one global: `initialize` writes it at once, and `render`
	 * reads it only when its turn in Mermaid's own queue comes. The stand-in keeps
	 * that shape: one global theme, read after the draw has yielded.
	 */
	function queuedLibraries(): RichContentLibraries {
		let theme = 'unset';
		return {
			hljs: { getLanguage: () => undefined, highlight: () => ({ value: '' }) },
			katex: { renderToString: (source: string) => source },
			renderMathInElement: () => {},
			mermaid: {
				initialize: (config: { theme: string }) => {
					theme = config.theme;
				},
				render: async (id: string) => {
					await new Promise((resolve) => setTimeout(resolve, 0));
					return { svg: `<svg id="${id}" data-drawn-for="${theme}"></svg>` };
				},
			},
		} as any;
	}

});

describe('line samples cache', () => {
	/**
	 * Scroll sync's sample table is built once per root and reused by every
	 * scroll event until something changes which elements it should hold: a
	 * patch, a fold, a host switch, a diagram replacing its `<pre>`. Boxes are
	 * still measured on every call, so only the walk is saved.
	 */
	function preview() {
		const root = document.createElement('div');
		root.innerHTML =
			'<h2 class="foldable-header" data-fold-key="a" data-sourcepos="1:1-1:4">A</h2>' +
			'<div class="foldable-content-wrapper"><p data-sourcepos="3:1-3:1">x</p><p data-sourcepos="10:1-10:1">y</p></div>' +
			'<pre data-sourcepos="20:1-22:3"><code class="language-mermaid">graph TD; A--&gt;B;</code></pre>';
		document.body.replaceChildren(root);
		const tops = new Map<Element, number>();
		const at = (selector: string, top: number) => tops.set(root.querySelector(selector)!, top);
		at('h2', 0);
		at('.foldable-content-wrapper', 20);
		at('[data-sourcepos="3:1-3:1"]', 20);
		at('[data-sourcepos="10:1-10:1"]', 100);
		at('pre', 200);
		const measure = (node: AnchorNode) => {
			const element = node as unknown as Element;
			// A detached node has no box; the diagram stands where its `<pre>` was.
			const top = element.isConnected ? (tops.get(element) ?? 200) : NaN;
			return { top, height: 0 };
		};
		return { root, measure, lineAt: (offset: number) => getSourceLineAtPreviewOffset(root, offset, measure) };
	}

	test('the table is walked once, and rebuilt after a fold and after a diagram replaces its <pre>', async () => {
		const { root, lineAt } = preview();
		expect(lineAt(100)).toBe(10);

		const walk = vi.spyOn(Node.prototype, 'childNodes', 'get');
		expect(lineAt(150)).toBe(15);
		expect(walk).not.toHaveBeenCalled();
		walk.mockRestore();

		// Shut, the fold owns lines 3-10 at its own top, so offset 100 now falls
		// between the fold's last line and the diagram.
		toggleFold({ root, folds: new Set(), setFolds() {} }, 'a');
		expect(lineAt(100)).toBe(10 + ((100 - 20) / (200 - 20)) * 10);

		const libraries: RichContentLibraries = {
			hljs: null,
			katex: null,
			renderMathInElement: null,
			mermaid: { initialize() {}, render: async () => ({ svg: '<svg></svg>' }) },
		};
		await renderRichContent({ roots: [root], libraries, mermaidTheme: 'default' });
		expect(root.querySelector('pre')).toBeNull();
		expect(lineAt(250)).toBe(20);
	});

});

describe('NBSP blank lines', () => {
	/**
	 * An NBSP is typed on purpose, to keep an empty line Markdown would collapse
	 * or to indent text (#843). The inputs are `convert_markdown` output,
	 * captured from comrak.
	 */

	function render(html: string): HTMLElement {
		const root = document.createElement('div');
		root.innerHTML = processMarkdownHtml(html, '/doc.md', new Set());
		return root;
	}

	test('an NBSP paragraph after a code block is kept', () => {
		// "```\ncode block\n```\n\u00a0\n\nAfter.\n"
		const root = render(
			'<pre data-sourcepos="1:1-3:3"><code>code block\n</code></pre>\n' +
				'<p data-sourcepos="4:1-4:2">\u00a0</p>\n' +
				'<p data-sourcepos="6:1-6:6">After.</p>\n',
		);

		assert.deepEqual(
			Array.from(root.querySelectorAll('p'), (p) => p.textContent),
			['\u00a0', 'After.'],
		);
	});

	test('an NBSP first line in a callout body is kept', () => {
		// "> [!NOTE]\n> \u00a0\n> Body.\n"
		const root = render(
			'<blockquote data-sourcepos="1:1-3:7">\n' +
				'<p data-sourcepos="1:3-3:7">[!NOTE]<br data-sourcepos="1:10-1:10" />\n' +
				'\u00a0<br data-sourcepos="2:5-2:5" />\nBody.</p>\n</blockquote>\n',
		);

		const body = root.querySelector('.markdown-alert-content');
		assert.ok(body, 'the blockquote became a callout');
		assert.match(body.textContent ?? '', /^\s*\u00a0/);
		assert.ok(body.querySelector('br'), 'the NBSP line keeps its break');
	});

	test('the empty paragraph the callout marker leaves is still removed', () => {
		// "> [!NOTE]\n>\n> Body.\n" puts an ordinary blank line under the marker.
		const root = render(
			'<blockquote data-sourcepos="1:1-3:7">\n' +
				'<p data-sourcepos="1:3-1:9">[!NOTE]</p>\n' +
				'<p data-sourcepos="3:3-3:7">Body.</p>\n</blockquote>\n',
		);

		const body = root.querySelector('.markdown-alert-content');
		assert.ok(body, 'the blockquote became a callout');
		assert.deepEqual(
			Array.from(body.querySelectorAll('p'), (p) => p.textContent),
			['Body.'],
		);
	});

	test('NBSP indentation at the start of a task item is kept', () => {
		// "- [ ] \u00a0\u00a0indented\n"
		const root = render(
			'<ul class="contains-task-list" data-sourcepos="1:1-1:18">\n' +
				'<li data-sourcepos="1:1-1:18"><input type="checkbox" data-task-checkbox="" ' +
				'class="task-list-item-checkbox" disabled="" /> \u00a0\u00a0indented</li>\n</ul>\n',
		);

		assert.equal(root.querySelector('.task-text')?.textContent, '\u00a0\u00a0indented');
	});
});

describe('preview cursor mapping', () => {
	// #799's shared cursor: a click in the preview lands on a source character,
	// and the editor's cursor is drawn back onto the rendered character. The HTML
	// is `convert_markdown`'s real output for SOURCE, so the columns are comrak's
	// UTF-8 byte offsets, which the Chinese lines exercise.

	const SOURCE = "# Title here\n\nA paragraph with **bold text** and a [link](https://example.com) here.\nSecond line with `code` and an escaped \\* star & more.\n\n中文段落里有**粗体**和测试。\n\n- item one\n- item **two**\n\n> quoted text\n\n```js\nlet x = 1;\n```\n\n| name | 值 |\n| --- | --- |\n| 甲 | beta |\n";

	const HTML = "<h1 id=\"title-here\" data-sourcepos=\"1:1-1:12\">Title here<a href=\"#title-here\" aria-label=\"Link to heading 'Title here'\" data-heading-content=\"Title here\" class=\"anchor\"></a></h1>\n<p data-sourcepos=\"3:1-4:54\">A paragraph with <strong data-sourcepos=\"3:18-3:30\">bold text</strong> and a <a data-sourcepos=\"3:38-3:64\" href=\"https://example.com\">link</a> here.<br data-sourcepos=\"3:71-3:71\" />\nSecond line with <code data-sourcepos=\"4:18-4:23\">code</code> and an escaped * star &amp; more.</p>\n<p data-sourcepos=\"6:1-6:40\">中文段落里有<strong data-sourcepos=\"6:19-6:28\">粗体</strong>和测试。</p>\n<ul data-sourcepos=\"8:1-9:14\">\n<li data-sourcepos=\"8:1-8:10\">item one</li>\n<li data-sourcepos=\"9:1-10:0\">item <strong data-sourcepos=\"9:8-9:14\">two</strong></li>\n</ul>\n<blockquote data-sourcepos=\"11:1-11:13\">\n<p data-sourcepos=\"11:3-11:13\">quoted text</p>\n</blockquote>\n<pre data-sourcepos=\"13:1-15:3\"><code class=\"language-js\">let x = 1;\n</code></pre>\n<table data-sourcepos=\"17:1-19:14\">\n<thead>\n<tr data-sourcepos=\"17:1-17:14\">\n<th data-sourcepos=\"17:2-17:7\">name</th>\n<th data-sourcepos=\"17:9-17:13\">值</th>\n</tr>\n</thead>\n<tbody>\n<tr data-sourcepos=\"19:1-19:14\">\n<td data-sourcepos=\"19:2-19:6\">甲</td>\n<td data-sourcepos=\"19:8-19:13\">beta</td>\n</tr>\n</tbody>\n</table>\n";

	const sourceLines = SOURCE.split('\n');

	const readLine = (line: number) => sourceLines[line - 1];

	function render() {
		const root = document.createElement('div');
		root.innerHTML = HTML;
		return root;
	}

	/** The text node and offset of the `nth` occurrence of `char` in rendered text under `selector`. */
	function charIn(root: Element, selector: string, char: string, nth = 0) {
		const walker = document.createTreeWalker(root.querySelector(selector)!, NodeFilter.SHOW_TEXT);
		let seen = 0;
		for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
			for (let offset = 0; offset < node.data.length; offset++) {
				if (node.data[offset] === char && seen++ === nth) return { node, offset };
			}
		}
		throw new Error(`no ${char} under ${selector}`);
	}

	const at = (line: number, column: number): SourcePoint => ({ line: asRendererLine(line), column });

	test('a click lands on the source character it rendered', () => {
		const root = render();
		const cases: Array<[string, string, SourcePoint, number?]> = [
			['h1', 'T', at(1, 3)],
			['p strong', 'b', at(3, 20)],
			['p a', 'l', at(3, 39)],
			['p code', 'c', at(4, 19)],
			['p', '*', at(4, 41)],
			['p', '&', at(4, 48)],
			['p:nth-of-type(2)', '粗', at(6, 9)],
			['p:nth-of-type(2)', '测', at(6, 14)],
			['li', 'o', at(8, 8)],
			['li:nth-of-type(2) strong', 't', at(9, 10)],
			['blockquote p', 'q', at(11, 3)],
			['pre', 'x', at(14, 5)],
			['td', '甲', at(19, 3)],
			['td:nth-of-type(2)', 'b', at(19, 7)],
		];
		for (const [selector, char, expected] of cases) {
			assert.deepEqual(sourceAtPoint(root, charIn(root, selector, char), readLine), expected, `${char} in ${selector}`);
			assert.equal(sourceLines[expected.line - 1][expected.column - 1], char, `${char} is the source character there`);
		}
	});

	test('every rendered character goes to the source and back to itself', () => {
		const root = render();
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let checked = 0;
		for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
			for (let offset = 0; offset < node.data.length; offset++) {
				if (/\s/.test(node.data[offset]) || !node.parentElement?.closest('[data-sourcepos]')) continue;
				const source: SourcePoint = sourceAtPoint(root, { node, offset }, readLine)!;
				const back: DomPoint = pointAtSource(root, source, readLine)!;
				assert.equal(back.node, node, `"${node.data[offset]}" came back in another node`);
				assert.equal(back.offset, offset, `"${node.data[offset]}" came back at another offset`);
				checked++;
			}
		}
		assert.ok(checked > 130, `the fixture was walked (${checked})`);
	});

	test('a fenced block pairs its code, not its info string', () => {
		// `js` on the fence would take the first two characters of `js = 1`.
		const root = document.createElement('div');
		root.innerHTML = '<pre data-sourcepos="1:1-3:3"><code class="language-js">js = 1;\n</code></pre>';
		const lines = ['```js', 'js = 1;', '```'];
		const point = sourceAtPoint(root, charIn(root, 'pre', 's'), (line) => lines[line - 1]);
		assert.deepEqual(point, at(2, 2));
	});

	test('a point inside KaTeX lands just after the formula', () => {
		const root = document.createElement('div');
		root.innerHTML = '<p data-sourcepos="1:1-1:14">sum <span class="katex">x2x^2</span> done</p>';
		const katex = root.querySelector('.katex')!;
		const point = sourceAtPoint(root, { node: katex.firstChild!, offset: 1 }, () => 'sum $x^2$ done');
		assert.deepEqual(point, at(1, 10), 'on the space after `$x^2$`');
	});
});



/**
 * What the shared sanitizer actually does to an author stylesheet — run, not
 * described.
 *
 * The lint rules (eslint.config.js) pin the WIRING: that the preview reaches the
 * shared policy, that the policy forbids `<style>`, that no second DOMPurify
 * call site assembles a config of its own. None of that runs DOMPurify, because
 * DOMPurify needs a real DOM and `node --test` has none. The behavioural half
 * therefore used to be a table of numbers measured by hand in a browser and
 * pasted into a comment — true when it was written and unfalsifiable ever
 * after.
 *
 * jsdom has a real DOM and a real cascade, so it is a test now. The payload is
 * the one that comment recorded, verbatim:
 *
 *     <style>.titlebar{display:none} body{background-image:url("…/beacon")}</style>
 *
 * and the observable is the same one: the preview injects `tab.content` into
 * the APPLICATION'S OWN document, so a stylesheet that survives the filter is
 * not scoped to the article — it restyles Markpad. `.titlebar` is a real
 * element of the app's chrome, and `getComputedStyle` is what answers whether
 * the document author moved it.
 *
 * The `background-image` half is the beacon: in a browser the computed value
 * being a URL is followed by a request for it (the comment recorded the entry
 * in `performance.getEntriesByType('resource')`, and the shipped CSP allows it
 * — `img-src … https:`). jsdom does not fetch it. The computed value is the
 * part that is a property of the sanitizer rather than of the network stack,
 * and it is the part asserted here.
 *
 * WHY THE "BEFORE" ROW IS ASSERTED TOO: without it "the `<style>` is gone"
 * proves nothing about the policy — an unrelated change that dropped every
 * `<style>` on any config would keep it green. The old config is DOMPurify's
 * default plus the URI pattern the viewer had hand-copied, which is exactly the
 * shape the regression had, and under it the payload still works. That is the
 * difference the policy makes.
 */
describe('preview sanitizing', () => {
	/** The document author's payload, as it arrives from comrak (`render.unsafe_ = true`). */
	const POC_STYLE = '<style>.titlebar{display:none} body{background-image:url("https://attacker.example/beacon")}</style>';

	/**
	 * A rendered document carrying it.
	 *
	 * The leading paragraph is not decoration. DOMPurify serializes its parse
	 * tree's `<body>`, and the HTML parser puts a `<style>` that opens a fragment
	 * into `<head>` instead — so a payload-only string comes back empty on ANY
	 * config, and the two rows below would agree for a reason that has nothing to
	 * do with the policy. Every real rendered document has prose before the raw
	 * HTML in it.
	 */
	const RENDERED = `<p>An ordinary paragraph of prose.</p>\n${POC_STYLE}`;

	/** The config the viewer used to build at its own call site: the URI pattern, and nothing else. */
	const VIEWER_LOCAL_CONFIG = { ALLOWED_URI_REGEXP: ALLOWED_MARKDOWN_URI_REGEXP };

	/**
	 * The app's own document, with the chrome the payload aims at.
	 *
	 * No inline `style` on the titlebar: an inline declaration outranks a class
	 * selector, which would make the "before" row look safe for the wrong reason.
	 * The app's own rule is a stylesheet rule, so the test's is too.
	 */
	function mountApp(): { titlebar: Element; preview: HTMLElement } {
		document.head.innerHTML = '<style>.titlebar{display:flex} body{background-image:none}</style>';
		document.body.innerHTML = '<div class="titlebar"></div><div class="markdown-body"></div>';
		return {
			titlebar: document.querySelector('.titlebar')!,
			preview: document.querySelector<HTMLElement>('.markdown-body')!,
		};
	}

	afterEach(() => {
		document.head.innerHTML = '';
		document.body.innerHTML = '';
	});

	test('the config the preview used to build lets a document restyle the application', () => {
		const { titlebar, preview } = mountApp();
		assert.equal(getComputedStyle(titlebar).display, 'flex', 'precondition: the app decides where its chrome is');

		const sanitized = DOMPurify.sanitize(RENDERED, VIEWER_LOCAL_CONFIG);
		assert.match(sanitized, /<style>/, 'the old config keeps the author stylesheet — that is the regression');

		preview.innerHTML = sanitized;

		assert.equal(getComputedStyle(titlebar).display, 'none', "the document hid the app's title bar");
		assert.equal(
			getComputedStyle(document.body).backgroundImage,
			'url("https://attacker.example/beacon")',
			'and pointed the app at an outbound URL',
		);
	});

	test('the shared policy drops the stylesheet and leaves the application alone', () => {
		const { titlebar, preview } = mountApp();

		const sanitized = sanitizeMarkdownHtml(RENDERED);
		assert.doesNotMatch(sanitized, /<style/i, 'the shared policy forbids the tag');
		assert.match(sanitized, /<p>An ordinary paragraph of prose\.<\/p>/, 'and keeps the document itself');

		preview.innerHTML = sanitized;

		assert.equal(getComputedStyle(titlebar).display, 'flex');
		assert.equal(getComputedStyle(document.body).backgroundImage, 'none');
	});

	test('the inline style attribute is still allowed, because documents use it', () => {
		// The other half of the policy decision, and the reason it is `FORBID_TAGS`
		// rather than "strip everything that styles": an inline declaration is scoped
		// to the one element the author wrote it on, so `<img style="width:50%">`
		// keeps working. Run rather than read: `FORBID_ATTR: ['style']` would pass
		// every assertion in the test above and silently break existing files.
		const { preview } = mountApp();

		preview.innerHTML = sanitizeMarkdownHtml('<p style="text-align:center">centred</p>');

		const paragraph = preview.querySelector('p')!;
		assert.equal(getComputedStyle(paragraph).textAlign, 'center');
	});

});

describe('rich content idempotence', () => {
	/**
	 * `renderRichContent` is run twice over the same nodes, and has to survive it.
	 *
	 * The reuse branches in the code-block pass — the `.code-block-shell` it adopts
	 * instead of nesting, the `.lang-label`s it removes before adding one — look
	 * like export-only defensiveness, on the theory that the preview always hands
	 * this function freshly parsed markup. It does not. Three preview paths call it
	 * with no `roots` at all, which means the whole live article, every node of it
	 * already enriched by the render before:
	 *
	 *   - a theme change (`MarkdownViewer.svelte`), because Mermaid bakes its
	 *     colours into the SVG and the diagrams have to be drawn again;
	 *   - `syncPreviewForPrint`, before a PDF export;
	 *   - re-activating a tab (`documentSession.svelte.ts`).
	 *
	 * #632 made this sharper rather than moot. The preview used to throw its
	 * article away on every keystroke, so an enriched node's life was one render
	 * long; now the patch keeps nodes across renders and the passes above meet
	 * markup that has been through here an unbounded number of times. Without the
	 * reuse, each pass wraps the last pass's shell in another shell and adds
	 * another copy button — a `.code-block-shell` per theme toggle, for the life of
	 * the document.
	 *
	 * The libraries are stood in for at the same boundary `exportRichContent`
	 * uses: what is under test is Markpad's own bookkeeping around them.
	 */
	function libraries(): RichContentLibraries {
		return {
			hljs: {
				getLanguage: (name: string) => (name === 'js' ? {} : undefined),
				highlight: (code: string) => ({ value: `<span class="hl">${code}</span>` }),
			},
			katex: { renderToString: (source: string) => `<span class="katex">${source}</span>` },
			renderMathInElement: () => {},
			mermaid: { initialize: () => {}, render: async () => ({ svg: '<svg></svg>' }) },
		};
	}

	function root(html: string): HTMLElement {
		const element = document.createElement('div');
		element.innerHTML = html;
		document.body.replaceChildren(element);
		return element;
	}

	async function render(target: HTMLElement) {
		await renderRichContent({ roots: [target], libraries: libraries(), mermaidTheme: 'default' });
	}

	describe('a second pass over already enriched nodes', () => {
		test('adopts the shell it built last time instead of nesting another one', async () => {
			const article = root('<pre><code class="language-js">const answer = 42;</code></pre>');

			await render(article);
			const shell = article.querySelector('.code-block-shell');
			const pre = article.querySelector('pre');
			expect(shell).not.toBeNull();

			await render(article);
			await render(article);

			expect(article.querySelectorAll('.code-block-shell').length).toBe(1);
			expect(article.querySelector('.code-block-shell')).toBe(shell);
			expect(shell!.parentElement).toBe(article);
			expect(pre!.parentElement).toBe(shell);
		});

		test('leaves one copy button, not one per pass', async () => {
			const article = root('<pre><code class="language-js">const answer = 42;</code></pre>');

			await render(article);
			await render(article);
			await render(article);

			expect(article.querySelectorAll('.lang-label').length).toBe(1);
			expect(article.querySelector('.lang-label')!.textContent).toBe('js');
		});

		test('holds for a fenced block with no language, which gets the icon instead', async () => {
			const article = root('<pre><code>plain text</code></pre>');

			await render(article);
			await render(article);

			expect(article.querySelectorAll('.code-block-shell').length).toBe(1);
			expect(article.querySelectorAll('.lang-label').length).toBe(1);
		});
	});
});

describe('link hover preview', () => {
	test('the hover preview never prints the webview origin', () => {
		// `[3.md](./3.md)` showed `tauri://localhost/3.md`: the DOM resolves
		// `href` against the webview's own origin. The box names the link as the
		// document wrote it.
		const anchor = document.createElement('a');
		anchor.setAttribute('href', './3.md');
		assert.notEqual(anchor.href, './3.md', 'jsdom resolves the property, as the webview does');
		assert.deepEqual(linkTooltipFor(anchor, { findAnchorTarget: () => null, footnoteRoot: null }), {
			text: './3.md',
			html: '',
			isFootnote: false,
		});
	});

	test('a footnote tooltip is read back out of the rendered preview', () => {
		// `{@html tooltip.html}` is the one sink besides the patched article, and it
		// is allowed because its body is a clone of what the sanitized article
		// already holds — never markup built from the unrendered buffer.
		const preview = document.createElement('div');
		preview.innerHTML = '<ol><li id="fn-1"><p>The <em>note</em> <a href="#fnref-1" class="footnote-backref">↩</a></p></li></ol>';
		const ref = document.createElement('a');
		ref.setAttribute('href', 'fn-1');
		ref.setAttribute('data-footnote-ref', '');
		const label = linkTooltipFor(ref, { findAnchorTarget: () => null, footnoteRoot: preview });
		assert.equal(label?.isFootnote, true);
		assert.equal(label?.html, '<p>The <em>note</em> </p>');
		assert.equal(preview.querySelector('.footnote-backref')?.textContent, '↩', 'the preview keeps its own back-link');
	});
});

/*
 * "Save image as" could never save a remote image, and on Windows it could not
 * save a LOCAL one either. It took `src.startsWith('http')` -> `fetch(src)`:
 * the app's CSP is `connect-src 'self'`, so that fetch is refused before a
 * request is made, and `convertFileSrc` spells a local file
 * `http://asset.localhost/…` on Windows, so every Windows image fell into that
 * unreachable branch. `normalizeAssetPath` (#363) recognises both spellings.
 */
describe('save image as', () => {
	function recordingDeps(dest: string | null = '/out/saved.png') {
		const calls: string[] = [];
		const deps: SaveImageDeps = {
			save: async (options) => {
				calls.push(`save:${options.defaultPath}`);
				return dest;
			},
			copyFile: async (src, to) => void calls.push(`copy:${src}->${to}`),
			toast: (message, type = 'info') => void calls.push(`toast:${type}:${message}`),
			language: () => 'en',
		};
		return { deps, calls };
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('the viewer recognises an asset URL with the shared helper', async () => {
		// Both spellings convertFileSrc emits, Windows first.
		for (const [src, path] of [
			['http://asset.localhost/C%3A%2FUsers%2FDaniel%2Fimg%2Fdiagram.png', 'C:/Users/Daniel/img/diagram.png'],
			['asset://localhost/%2Fhome%2Fdaniel%2Fdiagram.png', '/home/daniel/diagram.png'],
		]) {
			const { deps, calls } = recordingDeps();
			await saveImageAs(src, deps);
			assert.equal(calls[1], `copy:${path}->/out/saved.png`, src);
		}
	});

	test('nothing tries to fetch image bytes from the webview any more', async () => {
		// Dead code that reads like a working feature: it opened no dialog, wrote
		// no file, and reported a network failure that never happened.
		const fetch = vi.fn(async () => new Response(new Uint8Array([1])));
		vi.stubGlobal('fetch', fetch);
		for (const src of ['https://example.test/a.png', 'http://asset.localhost/C%3A%2Fa.png', 'data:image/png;base64,AA==']) {
			await saveImageAs(src, recordingDeps().deps);
		}
		assert.equal(fetch.mock.calls.length, 0);
	});

	test('a local image is copied on the Rust side', async () => {
		const local = recordingDeps();
		await saveImageAs('asset://localhost/%2Fpics%2Fcat.jpg', local.deps);
		assert.deepEqual(local.calls, ['save:image.jpg', 'copy:/pics/cat.jpg->/out/saved.png', 'toast:info:Image saved successfully']);

		// And the save dialog is only offered for a file that can actually be
		// written; the remote case bails out before it.
		const remote = recordingDeps();
		await saveImageAs('https://example.test/a.png', remote.deps);
		assert.equal(remote.calls.length, 1);
		assert.match(remote.calls[0], /^toast:error:/);
	});

	test('the saved toast uses the language chosen while the dialog was open', async () => {
		await loadLocale('de');
		let language: 'en' | 'de' = 'en';
		const { deps, calls } = recordingDeps();
		const save = deps.save;
		deps.save = async (options) => {
			language = 'de';
			return save(options);
		};
		deps.language = () => language;
		await saveImageAs('asset://localhost/%2Fpics%2Fcat.jpg', deps);
		assert.equal(calls.at(-1), 'toast:info:Bild erfolgreich gespeichert');
	});

	test('the preview offers Save Image As only for a local image', () => {
		// A remote or data: image cannot be saved, so the item is not shown for one
		// rather than shown and answered with an error toast.
		const itemsFor = (src: string) => {
			const img = document.createElement('img');
			img.src = src;
			return imageMenuItems(img, 'en', () => {}).map((item) => item.label ?? '-');
		};
		assert.deepEqual(itemsFor('asset://localhost/%2Fpics%2Fcat.jpg'), ['Save Image As...', '-']);
		assert.deepEqual(itemsFor('http://asset.localhost/C%3A%2Fcat.jpg'), ['Save Image As...', '-']);
		assert.deepEqual(itemsFor('https://example.test/cat.jpg'), []);
		assert.deepEqual(itemsFor('data:image/png;base64,AA=='), []);
	});
});

// #681 floated inline code above the words of a heading, #791 ate the spaces
// around `*not*` and broke it into `n`/`o`/`t` on a narrow pane. Both came from
// a flex heading: every text run, `<em>`, `<code>` and image becomes its own
// flex item. The fold chevron is absolutely positioned, so inline layout costs
// it nothing.
describe('inline content in headings', () => {
	afterEach(() => {
		document.head.innerHTML = '';
		document.body.innerHTML = '';
	});

	test('a rendered heading lays its content out as one line of text under the app stylesheet', () => {
		// The stylesheet the app loads, run by jsdom's cascade (`?raw` comes back
		// empty under vitest's CSS handling).
		const style = document.createElement('style');
		style.textContent = readSource('src/styles.css');
		document.head.append(style);
		const body = document.createElement('div');
		body.className = 'markdown-body';
		body.innerHTML = processMarkdownHtml(
			[1, 2, 3, 4, 5, 6].map((level) => `<h${level}>Use <code>x</code> and <em>not</em> y</h${level}>`).join('\n'),
			'/doc.md',
			new Set(),
		);
		document.body.append(body);
		const headings = Array.from(body.querySelectorAll<HTMLElement>('.foldable-header'));
		assert.equal(headings.length, 6, 'precondition: every level is a foldable heading');
		for (const heading of headings) {
			assert.doesNotMatch(getComputedStyle(heading).display, /flex|grid/, `${heading.tagName} lays its words out as flex items`);
		}
	});
});

