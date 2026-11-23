import assert from 'node:assert/strict';

import { flushSync, mount, unmount } from 'svelte';
import { afterAll, afterEach, beforeAll, describe, expect, onTestFinished, test, vi } from 'vitest';

import { collapsedFoldsAround, type FoldHost, revealFold, toggleFold, toggleFoldFromClick } from '../src/lib/utils/foldState.js';
import { runeProps } from './runeProps.svelte.js';
import { observeFoldLayout, type FoldLayoutObservation } from '../src/lib/utils/foldLayout.js';
import { splitRatioAfterMove } from '../src/lib/utils/splitPanes.js';
import { previewLayout } from '../src/lib/utils/previewLayout.js';
import { dismissesToc, tocAutoCollapses } from '../src/lib/utils/tocOverlay.js';
import { runeEffect } from './runeEffect.svelte.js';
import { showsHomeScreen } from '../src/lib/utils/homeTab.js';

describe('split scroll-sync preference', async () => {
	/*
	 * `editor.splitScrollSync` — the sticky "does a new split start scroll-locked"
	 * answer — was the last localStorage write outside `writeStoredSetting`. The
	 * tab store read it in its constructor and wrote it with a bare
	 * `localStorage.setItem`.
	 *
	 * That is the milder half of the defect #618 collected the other three writers
	 * for: one key and one write, so it could not clobber its neighbours the way a
	 * whole-snapshot write did. What it still had was the other half — no `storage`
	 * listener. Markpad opens several windows, each a separate webview over one
	 * shared localStorage, so flipping scroll sync in window A left window B
	 * seeding its next split from its own construction-time answer until it was
	 * restarted, while every preference beside it synced live.
	 *
	 * It is a preference, not tab state: `Tab.isScrollSynced` is the per-tab value
	 * (it lives in the window-state snapshot and is what the title bar toggles),
	 * and this is the one scalar every tab and every window seeds from. So it now
	 * lives in `SettingsStore` with the rest of them, and `TabManager` exposes it
	 * under its tab-side name.
	 *
	 * This runs under vitest so the runes are the compiler's: `$effect` really
	 * tracks, `flushSync()` really runs the write effects, and jsdom's
	 * `localStorage` and `window` are real. Only the Tauri backend is stubbed.
	 */
	(window as any).__TAURI_INTERNALS__ = {
		metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
		invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
	};

	const { createSettingsPersistence, settings, writeStoredSetting } = await import('../src/lib/stores/settings.svelte.js');
	const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');

	const KEY = 'editor.splitScrollSync';

	/** jsdom does not fire `storage` for writes made by this same document. */
	function dispatchStorage(key: string | null, newValue: string | null) {
		window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: localStorage }));
	}

	function reset() {
		tabManager.closeAll();
		settings.splitScrollSync = false;
		// The write effects and the `storage` listener are only live once flushed.
		flushSync();
	}

	/** A split tab, the way the app reaches one. */
	function splitTab(path: string) {
		tabManager.addTab(path, `# ${path}`);
		const id = tabManager.activeTabId!;
		tabManager.setSplitEnabled(id, true);
		return { id, tab: () => tabManager.tabs.find((candidate) => candidate.id === id)! };
	}

	test('the split scroll-sync preference is a persisted setting like every other one', () => {
		const entry = createSettingsPersistence().find((candidate) => candidate.key === KEY);
		assert.ok(entry, `${KEY} is not in createSettingsPersistence, so nothing syncs or validates it`);
	});

	test('a stored preference survives a restart and seeds the next split', () => {
		reset();
		localStorage.setItem(KEY, 'true');
		dispatchStorage(KEY, 'true');

		const { tab } = splitTab('/notes/restored.md');
		assert.equal(tab().isScrollSynced, true);
	});

	test('a sibling window flipping scroll sync arrives without a restart', () => {
		// THE BUG. Window B holds its own answer; window A flips the toggle and
		// publishes it. With no listener, B kept seeding splits from `false` until it
		// was restarted — the one behaviour the settings mechanism exists to give.
		reset();
		assert.equal(tabManager.splitScrollSyncPreference, false);

		localStorage.setItem(KEY, 'true');
		dispatchStorage(KEY, 'true');

		assert.equal(tabManager.splitScrollSyncPreference, true, 'the sibling window change never arrived');

		const { tab } = splitTab('/notes/sibling.md');
		assert.equal(tab().isScrollSynced, true, 'and the next split still started from the stale answer');
	});

	test('the arriving value is not echoed back at the window that sent it', () => {
		// Compare-and-set, not a flag: the write-back is dropped because the value is
		// already what is stored, so storage -> state -> effect -> write stops here.
		reset();
		localStorage.setItem(KEY, 'true');
		dispatchStorage(KEY, 'true');

		const entry = createSettingsPersistence().find((candidate) => candidate.key === KEY)!;
		assert.equal(writeStoredSetting(entry.key, entry.read(settings)), false);
	});

	test('toggling scroll sync on a tab publishes the preference for the other windows', () => {
		reset();
		const { id } = splitTab('/notes/toggled.md');

		tabManager.toggleScrollSync(id);
		assert.equal(tabManager.splitScrollSyncPreference, true);
		flushSync();
		assert.equal(localStorage.getItem(KEY), 'true');

		// Un-splitting keeps whatever the tab ended up with, as it always did.
		tabManager.setSplitEnabled(id, false);
		assert.equal(tabManager.splitScrollSyncPreference, true);
	});

	test('a splitter dragged past the end stops at the store bounds', () => {
		// The move is unclamped and the store holds 0.1-0.9, so the two cannot
		// disagree about where the bar stops.
		reset();
		const { id, tab } = splitTab('/notes/dragged.md');

		assert.equal(splitRatioAfterMove(0.9, 0.5, 'left'), 1.4);
		tabManager.setSplitRatio(id, splitRatioAfterMove(0.9, 0.5, 'left'));
		assert.equal(tab().splitRatio, 0.9);

		assert.equal(splitRatioAfterMove(0.1, -0.5, 'left'), -0.4);
		tabManager.setSplitRatio(id, splitRatioAfterMove(0.1, -0.5, 'right'));
		assert.equal(tab().splitRatio, 0.6);
		tabManager.setSplitRatio(id, splitRatioAfterMove(0.1, -0.5, 'left'));
		assert.equal(tab().splitRatio, 0.1);
	});
});



/*
 * The viewer's effects call these helpers. Each skips a reactive read the way
 * the inline condition it replaced did, so the effect does not subscribe to a
 * value that cannot change its outcome.
 */
describe('viewer effect helpers read only what decides them', () => {
	/** Runs `read` in an effect; returns how many times it has run. */
	function runs(read: () => void) {
		let count = 0;
		const stop = runeEffect(() => {
			count++;
			read();
		});
		onTestFinished(stop);
		flushSync();
		assert.equal(count, 1, 'the effect ran');
		return () => count;
	}

	test('the Home overlay does not read the active tab', () => {
		const s = runeProps({ showHome: true, tab: { path: '/a.md' } as { path: string } | undefined });
		const count = runs(() => showsHomeScreen(() => s.tab, s.showHome));
		s.tab = { path: '/b.md' };
		flushSync();
		assert.equal(count(), 1);
	});

	test('a pinned outline does not read the overhang', () => {
		const s = runeProps({ pinned: true, overhanging: false });
		const count = runs(() => tocAutoCollapses(() => s.overhanging, s.pinned));
		s.overhanging = true;
		flushSync();
		assert.equal(count(), 1);
	});

});


describe('fold layout', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = '';
	});

	test('fold layout observes rendered content and publishes its measured height', () => {
		// The wrapper animates `height: var(--fold-content-height)`, so it opens to
		// the height its content measures, and re-measures when that content
		// changes size (an image loading, a diagram drawing, the window narrowing).
		const frames: FrameRequestCallback[] = [];
		const observers: ResizeObserverCallback[] = [];
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
		vi.stubGlobal('cancelAnimationFrame', () => {});
		vi.stubGlobal(
			'ResizeObserver',
			class {
				constructor(callback: ResizeObserverCallback) {
					observers.push(callback);
				}
				observe() {}
				disconnect() {}
			},
		);
		const runFrames = () => frames.splice(0).forEach((frame) => frame(0));

		document.body.innerHTML =
			'<div class="markdown-body"><div class="foldable-content-wrapper"><div class="content-inner"><p>x</p></div></div></div>';
		const root = document.querySelector<HTMLElement>('.markdown-body')!;
		const wrapper = root.querySelector<HTMLElement>('.foldable-content-wrapper')!;
		let height = 120;
		root.querySelector<HTMLElement>('.content-inner')!.getBoundingClientRect = () => ({ height }) as DOMRect;

		const layout = observeFoldLayout(root);
		runFrames();
		assert.equal(wrapper.style.getPropertyValue('--fold-content-height'), '120px');

		height = 200;
		for (const callback of observers) callback([], {} as ResizeObserver);
		runFrames();
		assert.equal(wrapper.style.getPropertyValue('--fold-content-height'), '200px');
		layout.stop();
	});
});


describe('outline overlay placement', () => {
	test('the outline collapses itself only when it is in the way', () => {
		const settings = { previewMaxWidth: 880, previewFullWidth: false, tocSide: 'left' as const, splitEditorSide: 'left' as const, tocWidth: 240 };
		const wide = previewLayout(settings, { isEditing: false, isSplit: false, viewerWidth: 1400 });
		const narrow = previewLayout(settings, { isEditing: false, isSplit: false, viewerWidth: 1000 });
		// A window wide enough to hold the outline beside the text keeps it open.
		assert.equal(tocAutoCollapses(() => wide.isOverhanging, false), false);
		assert.equal(tocAutoCollapses(() => narrow.isOverhanging, false), true);
		// Pinned, it is a sidebar and stays.
		assert.equal(tocAutoCollapses(() => narrow.isOverhanging, true), false);

		// Click-outside must not fight the toggle button, which owns its own click.
		const panel = document.createElement('nav');
		const handle = panel.appendChild(document.createElement('div'));
		const toggle = document.createElement('button');
		const icon = toggle.appendChild(document.createElement('span'));
		const text = document.createElement('p');
		assert.equal(dismissesToc(icon, panel, toggle), false);
		assert.equal(dismissesToc(handle, panel, toggle), false);
		assert.equal(dismissesToc(text, panel, toggle), true);
		assert.equal(dismissesToc(null, panel, toggle), false);
	});
});

