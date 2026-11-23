import assert from 'node:assert/strict';

import { flushSync } from 'svelte';
import { afterAll, beforeEach, describe, onTestFinished, test } from 'vitest';

describe('settings persistence', async () => {
	(window as any).__TAURI_INTERNALS__ = { invoke: async () => 'macos' };

	/** jsdom does not fire `storage` for writes made by this same document. */
	function dispatchStorage(key: string | null, newValue: string | null) {
		window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: localStorage }));
	}

	function setNavigatorLanguage(language: string) {
		Object.defineProperty(globalThis, 'navigator', { value: { language }, configurable: true });
	}

	const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
	afterAll(() => {
		if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
	});
	setNavigatorLanguage('en-US');

	const {
		SettingsStore,
		ZOOM_LEVEL_RANGE,
		clampToRange,
		createSettingsPersistence,
		detectSystemLanguage,
		isSupportedLanguage,
		resolveLanguageTag,
		resolveTheme,
		stepWithinRange,
		wheelZoomFactor,
		writeStoredSetting,
	} = await import('../src/lib/stores/settings.svelte.js');

	/** A store that is torn down when its test ends: its effects would otherwise outlive it in the shared jsdom. */
	function createStore(): InstanceType<typeof SettingsStore> {
		const store = new SettingsStore();
		onTestFinished(() => store.dispose());
		return store;
	}

	beforeEach(() => localStorage.clear());

	test('a stored value is read back into a new store', () => {
		localStorage.setItem('theme', 'dark');
		localStorage.setItem('zoomLevel', '150');
		localStorage.setItem('editor.autoSaveEdits', 'false');
		localStorage.setItem('editor.language', 'es');
		const store = createStore();

		assert.equal(store.theme, 'dark');
		assert.equal(store.zoomLevel, 150);
		assert.equal(store.autoSave, false);
		assert.equal(store.language, 'es');
	});

	test('defaults apply when nothing is stored, and garbage falls back to them', () => {
		localStorage.setItem('theme', 'neon');
		localStorage.setItem('zoomLevel', 'huge');
		localStorage.setItem('editor.language', 'xx');
		const store = createStore();

		assert.equal(store.theme, 'system');
		assert.equal(store.zoomLevel, ZOOM_LEVEL_RANGE.default);
		assert.equal(store.language, 'en');
		assert.equal(store.autoSave, true);
		assert.equal(store.persistOpenEditors, true);
		assert.equal(store.restoreStateOnReopen, true);
	});

	test('changing one setting rewrites only its own key', () => {
		const store = createStore();
		flushSync();
		localStorage.setItem('editor.persistOpenEditors', 'sentinel');

		store.autoSave = false;
		flushSync();

		assert.equal(localStorage.getItem('editor.autoSaveEdits'), 'false');
		assert.equal(localStorage.getItem('editor.persistOpenEditors'), 'sentinel');
	});

	test('a change made in another window is folded into this one', () => {
		const store = createStore();
		flushSync();

		dispatchStorage('theme', 'light');
		dispatchStorage('zoomLevel', '200');

		assert.equal(store.theme, 'light');
		assert.equal(store.zoomLevel, 200);
	});

	test('every persisted key has a field behind it', () => {
		assert.deepEqual(
			createSettingsPersistence().map((entry) => entry.key).sort(),
			['editor.autoSaveEdits', 'editor.language', 'editor.persistOpenEditors', 'editor.restoreStateOnReopen', 'editor.zenMode', 'theme', 'zoomLevel'],
		);
	});

	test('writing a value already stored is not a write', () => {
		assert.equal(writeStoredSetting('k', 'v'), true);
		assert.equal(writeStoredSetting('k', 'v'), false);
		assert.equal(writeStoredSetting('k', null), true);
		assert.equal(writeStoredSetting('k', null), false);
	});

	test('zoom steps stay inside the range and reset returns to the default', () => {
		const store = createStore();
		store.zoomLevel = ZOOM_LEVEL_RANGE.max;
		store.zoomIn();
		assert.equal(store.zoomLevel, ZOOM_LEVEL_RANGE.max);
		store.zoomLevel = ZOOM_LEVEL_RANGE.min;
		store.zoomOut();
		assert.equal(store.zoomLevel, ZOOM_LEVEL_RANGE.min);
		store.resetZoom();
		assert.equal(store.zoomLevel, ZOOM_LEVEL_RANGE.default);
	});

	test('a slow pinch accumulates instead of rounding each event away', () => {
		const store = createStore();
		for (let i = 0; i < 20; i++) store.zoomBy(1.01);
		assert.ok(store.zoomLevel >= 120, `zoomed to ${store.zoomLevel}`);
	});

	test('zoom helpers clamp and step', () => {
		assert.equal(clampToRange(9999, ZOOM_LEVEL_RANGE), ZOOM_LEVEL_RANGE.max);
		assert.equal(clampToRange(null, ZOOM_LEVEL_RANGE), ZOOM_LEVEL_RANGE.default);
		assert.equal(stepWithinRange(100, 10, ZOOM_LEVEL_RANGE), 110);
		assert.ok(wheelZoomFactor(-100) > 1 && wheelZoomFactor(100) < 1);
	});

	test('zen mode toggles', () => {
		const store = createStore();
		store.toggleZenMode();
		assert.equal(store.zenMode, true);
		store.toggleZenMode();
		assert.equal(store.zenMode, false);
	});

	test('the OS type comes from the backend', async () => {
		const store = createStore();
		await store.initOSType();
		assert.equal(store.osType, 'macos');
	});

	test('themes and languages resolve from loose input', () => {
		assert.equal(resolveTheme('dark'), 'dark');
		assert.equal(resolveTheme('vscode:Night Owl'), 'system');
		assert.equal(isSupportedLanguage('fr'), true);
		assert.equal(isSupportedLanguage('klingon'), false);
		assert.equal(resolveLanguageTag('pt-BR'), 'pt-BR');
		assert.equal(resolveLanguageTag('zh-Hant'), 'zh-TW');
		assert.equal(resolveLanguageTag('xx'), null);
		setNavigatorLanguage('de-AT');
		assert.equal(detectSystemLanguage(), 'de');
		setNavigatorLanguage('en-US');
	});
});
