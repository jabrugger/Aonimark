import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { flushSync } from 'svelte';

// Importing the store boots the settings singleton, which asks for the OS type,
// so a backend answering it has to be in place before the imports below. Each
// describe installs its own backend in `beforeAll`.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession, claimTabForRead } = await import('../src/lib/sessions/documentSession.svelte.js');
const { createWindowSession } = await import('../src/lib/sessions/windowSession.svelte.js');
const { settings } = await import('../src/lib/stores/settings.svelte.js');
const { loadLocale } = await import('../src/lib/utils/i18n.js');
type Tab = import('../src/lib/stores/tabs.svelte.js').Tab;


// A file path identifies a tab. Two tabs on one file are two buffers with two
// dirty flags and two auto-save timers writing the same file in turn, so
// whichever lands last silently overwrites the other's work. Every way to
// reach that state goes through a different caller — a link opened in a new
// tab, Save As onto an open file, back/forward, a tab moved in from another
// window — so the constraint belongs to the store.
//
// These tests drive the real TabManager: they assert behaviour, not wording.
describe('one tab per file', () => {
	beforeAll(() => {
		// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
		// Svelte plugin, so `$state`/`$derived`/`$effect` behave here exactly as they do
		// in the app. Only the things jsdom genuinely does not have are stubbed.
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
		};
	});

	afterAll(() => {
		// One store for the whole file: leave it empty for the next describe.
		tabManager.tabs = [];
		tabManager.activeTabId = null;
		localStorage.clear();
	});

	function reset() {
		tabManager.tabs = [];
		tabManager.activeTabId = null;
		localStorage.clear();
	}

	function tabsFor(path: string) {
		return tabManager.tabs.filter((tab) => tab.path === path);
	}

	// --- one tab per file ---

	// Scope: this proves the STORE does not clobber the buffer when an open file
	// is opened again. It does not prove the whole open flow is safe —
	// `documentSession.loadMarkdown` re-reads the file into the tab it activates,
	// which is a pre-existing behaviour of the ordinary open path and lives
	// outside this file.
	test('re-opening a file does not overwrite the unsaved edits in its tab', () => {
		reset();
		tabManager.addTab('/notes/a.md', 'saved text');
		const id = tabManager.activeTabId!;
		tabManager.updateTabRawContent(id, 'unsaved edits');

		tabManager.addTab('/notes/a.md', 'saved text');

		const tab = tabManager.tabs.find((item) => item.id === id)!;
		assert.equal(tab.rawContent, 'unsaved edits');
		assert.equal(tab.isDirty, true);
	});

	test('Save As onto a file that is already open does not leave two tabs on it', () => {
		reset();
		tabManager.addTab('/notes/target.md', 'target text');
		tabManager.addNewTab();
		const untitled = tabManager.activeTabId!;

		// saveContentAs writes the file first and then re-points the tab.
		tabManager.updateTabPath(untitled, '/notes/target.md');

		assert.equal(tabsFor('/notes/target.md').length, 1);
		assert.equal(tabsFor('/notes/target.md')[0].id, untitled);
	});

	test('Save As from a saved file onto an open one does not leave two tabs on it', () => {
		reset();
		tabManager.addTab('/notes/target.md', 'target text');
		tabManager.addTab('/notes/other.md', 'other text');
		const moved = tabManager.activeTabId!;

		tabManager.updateTabPath(moved, '/notes/target.md');

		assert.equal(tabsFor('/notes/target.md').length, 1);
		assert.equal(tabsFor('/notes/target.md')[0].id, moved);
	});


});

/** What `take_command_line_open` answers, per path: what a command line asked. */
const commandLine = new Map<string, { mode: 'preview' | 'editor' | 'split' | null; missing: boolean }>();

describe('path identity on a case-folding volume', () => {
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => {
				if (cmd === 'take_command_line_open') {
					const request = commandLine.get(args.path) ?? null;
					commandLine.delete(args.path);
					return Promise.resolve(request);
				}
				if (cmd === 'canonicalize_path') {
					const resolved = lookup(args.path);
					// A name nothing answers to is still a legal target (Save As to a
					// new file); the backend resolves its directory and keeps the name.
					return Promise.resolve(resolved ?? args.path);
				}
				if (cmd === 'read_file_content_checked') {
					const file = disk.get(lookup(args.path) ?? args.path);
					return Promise.resolve([file?.body ?? '', file?.lossy ?? false]);
				}
				if (cmd === 'open_markdown_preview') {
					const file = disk.get(lookup(args.path) ?? args.path);
					return Promise.resolve([file?.body ?? '', true, file?.lossy ?? false]);
				}
				if (cmd === 'save_file_content') {
					writes.push({ path: args.path, content: args.content });
					disk.set(lookup(args.path) ?? args.path, { body: args.content, lossy: false });
					return Promise.resolve(null);
				}
				// The Save As dialog. `@tauri-apps/plugin-dialog`'s `save()` is a thin
				// wrapper over this command, so stubbing it here needs no module
				// patching and exercises the real wrapper.
				if (cmd === 'plugin:dialog|save') return Promise.resolve(nextSaveTarget);
				if (cmd === 'get_os_type') return Promise.resolve('macos');
				return Promise.resolve(null);
			},
		};
	});

	afterAll(() => {
		// One store for the whole file: leave it empty for the next describe.
		tabManager.tabs = [];
		tabManager.activeTabId = null;
		localStorage.clear();
	});

	// On macOS and Windows the filesystem folds case: `/notes/A.md` and
	// `/notes/a.md` are ONE file. (APFS folds Unicode normalization too, so the
	// NFC and NFD spellings of `café.md` are one file as well — which no amount of
	// case folding in the frontend could ever reach.) Markpad compared paths with
	// exact string equality in three places, and each of them broke differently
	// when the same file arrived under two spellings:
	//
	//   1. the lossy-decode save guard let a Save As typed `/notes/Legacy.md`
	//      overwrite the non-UTF-8 file the tab had opened as `/notes/legacy.md`,
	//      destroying it — the one thing that guard exists to prevent;
	//   2. one-tab-per-file gave two tabs on one file, i.e. two buffers with two
	//      auto-save timers taking turns overwriting each other;
	//   3. the reopen guard did not recognise its own file, so opening it again
	//      read disk content over a buffer full of unsaved edits.
	//
	// All three now ask the filesystem what file a path names (the Rust
	// `canonicalize_path`), once, when the path enters the app, and compare that.
	//
	// These tests drive the real TabManager and the real documentSession against a
	// backend stubbed to behave like a case-insensitive volume. They assert
	// behaviour — buffers kept, files not written, tab counts — never wording.

	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity, and
	// jsdom supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

	/** Files by their on-disk name, and whether each decoded lossily. */
	const disk = new Map<string, { body: string; lossy: boolean }>();
	/** Every write the session actually performed, in order. */
	const writes: { path: string; content: string }[] = [];

	/**
	 * A case-insensitive volume, modelled the way a real one behaves: a lookup
	 * matches any spelling, and what comes back is the name the DIRECTORY holds —
	 * which is exactly what `realpath` reports and what `canonicalize_path`
	 * returns. Nothing here lowercases a path; the on-disk name is the answer.
	 */
	function lookup(path: string): string | null {
		const wanted = path.toLowerCase();
		for (const name of disk.keys()) {
			if (name.toLowerCase() === wanted) return name;
		}
		return null;
	}

	/** What the dialog will return next. */
	let nextSaveTarget: string | null = null;

	const errors: string[] = [];
	const recents: string[] = [];

	function makeSession() {
		return createDocumentSession({
			afterLoad: async () => {},
			onError: (message: string) => void errors.push(message),
			onDiskChangedUnderSave: () => {},
			cancelPendingAutoSave: () => {},
			askClose: async () => 'discard' as const,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
		});
	}

	function reset() {
		tabManager.tabs = [];
		tabManager.activeTabId = null;
		localStorage.clear();
		disk.clear();
		writes.length = 0;
		errors.length = 0;
		nextSaveTarget = null;
	}

	// --- gap 1: the lossy-decode save guard -----------------------------------

	test('Save As in a different case is still an overwrite of the source file', async () => {
		// The file is GBK, so its buffer is U+FFFD mojibake and writing it back
		// destroys the document — that is what `refuseIfLossilyDecoded` stops. The
		// user opened it as `/notes/legacy.md`; the Save As dialog comes back with
		// `/notes/Legacy.md`. On this volume that is the SAME FILE, so the refusal
		// has to hold, or the guard is one autocomplete away from being bypassed.
		reset();
		const session = makeSession();
		disk.set('/notes/legacy.md', { body: '# �� mojibake', lossy: true });

		await session.loadMarkdown('/notes/legacy.md');
		assert.equal(tabManager.activeTab?.hasReplacementChars, true, 'precondition: the buffer is known lossy');

		nextSaveTarget = '/notes/Legacy.md';
		const saved = await session.saveContentAs();

		assert.equal(saved, false, 'the refusal must hold');
		assert.deepEqual(writes, [], 'nothing may be written over the source file');
		assert.equal(disk.get('/notes/legacy.md')?.body, '# �� mojibake', 'the document is intact');
	});

	test('Save As to a genuinely different file stays open as the escape hatch', async () => {
		// The other direction, and the one that must not regress: the whole point
		// of refusing is that the user can still write a UTF-8 copy somewhere else.
		reset();
		const session = makeSession();
		disk.set('/notes/legacy.md', { body: '# �� mojibake', lossy: true });

		await session.loadMarkdown('/notes/legacy.md');
		nextSaveTarget = '/notes/legacy-utf8.md';
		const saved = await session.saveContentAs();

		assert.equal(saved, true);
		assert.equal(writes.length, 1);
		assert.equal(writes[0].path, '/notes/legacy-utf8.md');
		assert.equal(tabManager.activeTab?.hasReplacementChars, false, 'the copy is UTF-8, so the tab is savable again');
	});

	// --- gap 2: one tab per file ----------------------------------------------

	test('opening one file under two spellings leaves one tab, not two', async () => {
		// Two tabs on one file are two buffers with two dirty flags and two
		// auto-save timers writing the same file in turn; whichever lands last
		// silently overwrites the other's work.
		reset();
		const session = makeSession();
		disk.set('/notes/A.md', { body: 'shared body', lossy: false });

		await session.loadMarkdown('/notes/A.md');
		const first = tabManager.activeTabId;
		await session.loadMarkdown('/notes/a.md');

		assert.equal(tabManager.tabs.length, 1, 'one file, one tab');
		assert.equal(tabManager.activeTabId, first, 'the request resolved to the tab that already held it');
	});






	test('Save As onto a file already open under another spelling does not leave two tabs on it', async () => {
		// Reached through `updateTabPath` rather than `addTab`, and the file is
		// already written by the time the store hears about it — so the loser's
		// buffer is stale no matter which way the name was spelled.
		reset();
		const session = makeSession();
		disk.set('/notes/A.md', { body: 'original', lossy: false });
		await session.loadMarkdown('/notes/A.md');

		tabManager.addNewTab();
		const draft = tabManager.activeTabId!;
		tabManager.updateTabRawContent(draft, 'replacement');

		nextSaveTarget = '/notes/a.md';
		assert.equal(await session.saveContentAs(), true);

		assert.equal(
			tabManager.tabs.filter((tab) => tab.path !== '').length,
			1,
			'exactly one tab may claim the file',
		);
		assert.equal(tabManager.activeTabId, draft, 'the tab that owns the bytes on disk keeps it');
	});

	// --- gap 3: the reopen guard ----------------------------------------------



	// --- the fallback ----------------------------------------------------------

	test('a path the backend cannot resolve is compared exactly, as before', async () => {
		// An unreachable network volume, a deleted parent directory, or any route
		// that has not resolved a path yet must cost the improvement and nothing
		// more: the literal comparison is what every one of these sites did before.
		const { isSameFilePath } = await import('../src/lib/utils/pathIdentity.js');

		assert.equal(isSameFilePath({ path: '/notes/A.md' }, { path: '/notes/a.md' }), false);
		assert.equal(isSameFilePath({ path: '/notes/A.md' }, { path: '/notes/A.md' }), true);
		// A key is trusted only when BOTH sides have one: `/notes/today.md` may be
		// a symlink whose key is `/archive/2026-08-03.md`, so a bare path that
		// happens to equal someone else's key proves nothing.
		assert.equal(
			isSameFilePath({ path: '/notes/today.md', pathKey: '/archive/x.md' }, { path: '/archive/x.md' }),
			false,
		);
		assert.equal(
			isSameFilePath(
				{ path: '/notes/today.md', pathKey: '/archive/x.md' },
				{ path: '/archive/x.md', pathKey: '/archive/x.md' },
			),
			true,
		);
		// Untitled buffers are not files and never collide.
		assert.equal(isSameFilePath({ path: '' }, { path: '' }), false);
	});
});

describe('a read lands in its own tab', () => {
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => {
				const hold = held.get(cmd);
				if (hold) {
					held.delete(cmd);
					return hold.promise.then(() => answer(cmd, args));
				}
				return Promise.resolve(answer(cmd, args));
			},
		};
	});

	afterAll(() => {
		// One store for the whole file: leave it empty for the next describe.
		tabManager.tabs = [];
		tabManager.activeTabId = null;
		localStorage.clear();
	});

	// A disk read that fills a tab is an await, and the tab can change under it:
	// the user switches to another tab, types, ticks a task, navigates, or closes
	// it. `claimTabForRead` pins the tab, its file and its buffer when the read
	// departs, and refuses the result if any of them moved by the time it lands.
	//
	// Each test holds one backend call open, changes the tab while it is out, then
	// lets it answer — the "old result arrives late" order — and checks the stale
	// result was refused. The real TabManager, document session and window session
	// run under vitest; only the Tauri bridge is stubbed.

	type Deferred = { promise: Promise<unknown>; resolve: (value: unknown) => void };
	function deferred(): Deferred {
		let resolve!: (value: unknown) => void;
		const promise = new Promise<unknown>((r) => (resolve = r));
		return { promise, resolve };
	}

	const disk = new Map<string, string>();
	/** Calls to hold open, by command name, until the test resolves them. */
	const held = new Map<string, Deferred>();
	let storedSnapshot: string | null = null;

	function answer(cmd: string, args: any): unknown {
		switch (cmd) {
			case 'canonicalize_path':
				return args.path;
			case 'open_markdown_preview':
				return [disk.get(args.path) ?? '', true, false, 'UTF-8'];
			case 'read_file_content_checked':
				return [disk.get(args.path) ?? '', false, 'UTF-8'];
			case 'load_window_state':
				return storedSnapshot;
			default:
				return null;
		}
	}

	function makeSession() {
		return createDocumentSession({
			afterLoad: async () => {},
			onError: () => {},
			onDiskChangedUnderSave: () => {},
			cancelPendingAutoSave: () => {},
			askClose: async () => 'discard' as const,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
		});
	}

	function reset() {
		tabManager.tabs = [];
		tabManager.activeTabId = null;
		disk.clear();
		held.clear();
		storedSnapshot = null;
	}

	function hold(cmd: string) {
		const d = deferred();
		held.set(cmd, d);
		return d;
	}

	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	const tabById = (id: string) => tabManager.tabs.find((tab) => tab.id === id)!;


	test('typing during a non-markdown reload is kept', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/a.json', 'changed by another program');
		tabManager.addTab('/notes/a.json', 'original');
		const a = tabManager.activeTabId!;

		const gate = hold('read_file_content_checked');
		const load = session.loadMarkdown('/notes/a.json');
		await settle();
		tabManager.updateTabRawContent(a, 'original plus typing');
		gate.resolve(undefined);
		await load;

		assert.equal(tabById(a).rawContent, 'original plus typing');
		assert.equal(tabById(a).isDirty, true);
	});


	// The read Cmd+E and split view make (MarkdownViewer.svelte) use the claim
	// directly. A task ticked while it is out is saved by auto-save, so the tab is
	// clean again when the read lands: "not dirty" alone would let the read, which
	// left before the tick, put the unticked text back.
	test('a read that left before a ticked-and-saved task is refused', () => {
		reset();
		tabManager.addTab('/notes/a.md', '- [ ] task');
		const a = tabManager.activeTabId!;

		const mayApply = claimTabForRead(a);
		tabManager.setTabRawContent(a, '- [x] task');

		assert.equal(tabById(a).isDirty, false);
		assert.equal(mayApply(), false);
	});

	test('of two reads of one tab, only the newer may land', () => {
		reset();
		tabManager.addTab('/notes/a.md', 'text');
		const a = tabManager.activeTabId!;

		const older = claimTabForRead(a);
		const newer = claimTabForRead(a);

		assert.equal(older(), false);
		assert.equal(newer(), true);
	});

	test('a read of a closed tab is refused', () => {
		reset();
		tabManager.addTab('/notes/a.md', 'text');
		const a = tabManager.activeTabId!;
		const mayApply = claimTabForRead(a);
		tabManager.closeTab(a);
		assert.equal(mayApply(), false);
	});

});


