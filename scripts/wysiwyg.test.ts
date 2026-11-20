import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	dominantEmphasisMarker,
	dominantOrderedMarker,
	splitFrontMatter,
	withLineEnding,
	wysiwygStringifyOptions,
} from '../src/lib/utils/wysiwygMarkdown.js';

describe('wysiwyg markdown options', () => {
	test('the defaults match CommonMark and the sample files', () => {
		assert.deepEqual(wysiwygStringifyOptions(''), {
			bullet: '-',
			bulletOrdered: '.',
			emphasis: '*',
			strong: '*',
			fence: '`',
			rule: '-',
			ruleRepetition: 3,
			ruleSpaces: false,
		});
	});

	test('the dominant emphasis marker is the one the document writes', () => {
		assert.equal(dominantEmphasisMarker('**bold** and *italic*'), '*');
		assert.equal(dominantEmphasisMarker('__bold__ and _italic_'), '_');
		// No emphasis at all falls back to CommonMark's `*`.
		assert.equal(dominantEmphasisMarker('plain text'), '*');
	});

	test('thematic breaks, snake_case and 2*3*4 do not count as emphasis', () => {
		// `***` and `___` are rules, not emphasis runs.
		assert.equal(dominantEmphasisMarker('***\n___'), '*');
		// `snake_case_names` is prose, not `_emphasis_`.
		assert.equal(dominantEmphasisMarker('snake_case_names here'), '*');
		// `2*3*4` is multiplication, not `*emphasis*`.
		assert.equal(dominantEmphasisMarker('2*3*4'), '*');
	});

	test('the dominant ordered-list marker is the one the document writes', () => {
		assert.equal(dominantOrderedMarker('1. first\n2. second'), '.');
		assert.equal(dominantOrderedMarker('1) first\n2) second'), ')');
		// Indented items still vote.
		assert.equal(dominantOrderedMarker('1. first\n   1. nested\n2. second'), '.');
		// Ties default to `.`.
		assert.equal(dominantOrderedMarker('plain text'), '.');
	});

	test('the options follow the dominant emphasis marker', () => {
		const underscore = wysiwygStringifyOptions('__bold__ and _italic_');
		assert.equal(underscore.emphasis, '_');
		assert.equal(underscore.strong, '_');
		const star = wysiwygStringifyOptions('**bold** and *italic*');
		assert.equal(star.emphasis, '*');
		assert.equal(star.strong, '*');
	});
});

describe('wysiwyg front matter split', () => {
	test('splits a leading YAML block off verbatim and leaves the body', () => {
		const markdown = '---\ntitle: x\n---\n\n# H\n';
		const split = splitFrontMatter(markdown);
		assert.equal(split.frontMatter, '---\ntitle: x\n---\n\n');
		assert.equal(split.body, '# H\n');
		assert.equal(split.frontMatter + split.body, markdown);
	});

	test('no front matter returns an empty block and the whole document as body', () => {
		const markdown = '# H\n\nbody\n';
		assert.deepEqual(splitFrontMatter(markdown), { frontMatter: '', body: markdown, lineEnding: '\n' });
	});

	test('a --- rule later in the body is not front matter', () => {
		const markdown = '---\ntitle: x\n---\n\n# H\n\n---\n\nbody\n';
		const split = splitFrontMatter(markdown);
		assert.equal(split.frontMatter, '---\ntitle: x\n---\n\n');
		assert.equal(split.body, '# H\n\n---\n\nbody\n');
	});

	test('unclosed front matter is plain body', () => {
		const markdown = '---\ntitle: x\n# H\n';
		const split = splitFrontMatter(markdown);
		assert.equal(split.frontMatter, '');
		assert.equal(split.body, markdown);
	});

	test('front matter only leaves an empty body', () => {
		const markdown = '---\ntitle: x\n---\n';
		const split = splitFrontMatter(markdown);
		assert.equal(split.frontMatter, markdown);
		assert.equal(split.body, '');
	});

	test('a CRLF document is split at the CRLF blank line and reported CRLF', () => {
		const markdown = '---\r\ntitle: x\r\n---\r\n\r\n# H\r\n';
		const split = splitFrontMatter(markdown);
		assert.equal(split.frontMatter, '---\r\ntitle: x\r\n---\r\n\r\n');
		assert.equal(split.body, '# H\r\n');
		assert.equal(split.lineEnding, '\r\n');
		assert.equal(split.frontMatter + split.body, markdown);
	});

	test('TOML +++ is not front matter (the preview does not strip it)', () => {
		const markdown = '+++\ntitle = "x"\n+++\n\n# H\n';
		const split = splitFrontMatter(markdown);
		assert.equal(split.frontMatter, '');
		assert.equal(split.body, markdown);
	});

	test('a leading --- block that is not a YAML mapping stays body', () => {
		const markdown = '---\nLead paragraph\n---\n\nBody\n';
		const split = splitFrontMatter(markdown);
		assert.equal(split.frontMatter, '');
		assert.equal(split.body, markdown);
	});
});

describe('wysiwyg line endings', () => {
	test('withLineEnding keeps LF and rewrites to CRLF', () => {
		assert.equal(withLineEnding('a\nb\n', '\n'), 'a\nb\n');
		assert.equal(withLineEnding('a\nb\n', '\r\n'), 'a\r\nb\r\n');
	});
});
