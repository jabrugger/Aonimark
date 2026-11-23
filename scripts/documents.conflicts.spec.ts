import assert from 'node:assert/strict';

import { beforeAll, describe, test } from 'vitest';

// This stub only answers the settings store, which boots when the modules
// below are imported. The describe installs the one the tests use.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');
const { createWindowExit } = await import('../src/lib/sessions/windowExit.js');
const { createExternalChange } = await import('../src/lib/sessions/externalChange.svelte.js');


// Ctrl+S from any mode, on the tab in front.
describe('save from reading mode', () => {
	function makeSaves() {
		const saved: string[] = [];
		const conflicts = createExternalChange({
			tabManager,
			settings: { autoSave: false, language: 'en' },
			documentSession: {
				saveContent: async (id) => {
					saved.push(tabManager.tabs.find((tab) => tab.id === id)!.path);
					return true;
				},
				allowOverwriteOnce: () => {},
				resolveExternalChange: async () => ({ action: 'ignore' as const }),
			},
			loadMarkdown: async () => {},
			canCloseTab: async () => true,
			readFile: async () => ['', false, 'UTF-8'],
			addToast: () => {},
			t: (key) => key,
		});
		return { conflicts, saved };
	}

	test('an untitled buffer can be saved from reading mode', async () => {
		// The session opens the Save dialog for `path === ''`.
		const { conflicts, saved } = makeSaves();
		tabManager.tabs = [];
		tabManager.activeTabId = null;
		tabManager.addTab('', '');

		await conflicts.saveActiveTab();

		assert.deepEqual(saved, ['']);
	});

	test('a saved, unmodified document does not write on Ctrl+S', async () => {
		// Writing unconditionally would touch mtime and wake the file watcher,
		// which in live mode reloads the tab -- a keystroke that reads as a no-op
		// to the user should not move the document underneath them.
		const { conflicts, saved } = makeSaves();
		tabManager.tabs = [];
		tabManager.activeTabId = null;
		tabManager.addTab('/notes/a.md', 'saved');
		const tab = tabManager.activeTab!;
		tab.originalContent = 'saved';

		await conflicts.saveActiveTab();
		assert.deepEqual(saved, []);

		tabManager.updateTabRawContent(tab.id, 'saved!');
		await conflicts.saveActiveTab();
		assert.deepEqual(saved, ['/notes/a.md']);
	});

});
