import assert from 'node:assert/strict';
import { after, before, describe, test, type TestContext } from 'node:test';

import postcss, { type Root } from 'postcss';
import { parse as parseSvelte } from 'svelte/compiler';

import { installShimDom, parseHtml } from './renderProtocolDom.ts';
import { stubTauriInvoke } from './tauriInvoke.js';
import { getMarkdownBodyWithoutFrontMatter, parseFrontMatter } from '../src/lib/utils/frontMatter.js';
import { readSource } from './sourceTree.js';
import { hasMarkdownLinkExtension } from '../src/lib/utils/markdownLinks.js';

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

});


