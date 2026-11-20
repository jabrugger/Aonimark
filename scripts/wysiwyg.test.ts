import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	dominantEmphasisMarker,
	dominantOrderedMarker,
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
