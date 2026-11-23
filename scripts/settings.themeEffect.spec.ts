import assert from 'node:assert/strict';
import { flushSync } from 'svelte';
import { describe, test } from 'vitest';

import type { ThemeSetting } from '../src/lib/stores/settings.svelte.js';
import { followTheme } from '../src/lib/utils/themeEffect.svelte.js';
import { runeEffect } from './runeEffect.svelte.js';
import { runeProps } from './runeProps.svelte.js';

/** The theme effect, driven by a real `$state` and real effects. */
function harness(theme: ThemeSetting) {
	const state = runeProps({ theme, mode: 'view' });
	const calls: string[] = [];
	const dispose = runeEffect(() => followTheme(() => state.theme as ThemeSetting, (appearance) => void calls.push(appearance)));
	flushSync();
	return { state, calls, dispose };
}

describe('theme effect', () => {
	test('a chosen theme is put on the document and told to Rust as the startup appearance', () => {
		const run = harness('dark');
		assert.equal(document.documentElement.dataset.theme, 'dark');
		assert.deepEqual(run.calls, ['dark']);

		run.state.theme = 'light';
		flushSync();
		assert.equal(document.documentElement.dataset.theme, 'light');
		assert.deepEqual(run.calls, ['dark', 'light']);
		run.dispose();
	});

	test('following the system removes the document override but still tells Rust', () => {
		const run = harness('dark');
		run.state.theme = 'system';
		flushSync();
		assert.equal(document.documentElement.dataset.theme, undefined);
		assert.equal(run.calls.at(-1), 'system');
		run.dispose();
	});
});
