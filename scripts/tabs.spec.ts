import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';
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
const { createTabMovers, createTransferOptions } = await import('../src/lib/sessions/windowTransfer.js');
const { snapshotTab } = await import('../src/lib/utils/tabTransfer.js');
const { outgoingTabAnchorLine } = await import('../src/lib/utils/editorPosition.js');
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
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
	});

	function reset() {
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
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

	test('a tab arriving from another window does not duplicate a file open here', () => {
		reset();
		tabManager.addTab('/notes/shared.md', 'resident copy');

		tabManager.insertTransferredTab({
			path: '/notes/shared.md',
			title: 'shared.md',
			rawContent: 'edited elsewhere',
			originalContent: 'resident copy',
			isDirty: true,
			isEditing: true,
			scrollTop: 0,
			scrollPercentage: 0,
			anchorLine: asRendererLine(0),
			isSplit: false,
			splitRatio: 0.5,
			isScrollSynced: false,
			hasReplacementChars: false,
			encoding: 'UTF-8',
			history: ['/notes/shared.md'],
			historyIndex: 0,
		});

		assert.equal(tabsFor('/notes/shared.md').length, 1);
		assert.equal(tabsFor('/notes/shared.md')[0].rawContent, 'edited elsewhere');
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
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
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
			setShowHome: () => {},
			currentFile: () => tabManager.activeTab?.path ?? '',
			resetScrollHistory: () => {},
			renderMarkdown: async (raw: string) => raw,
			afterLoad: async () => {},
			saveRecentFile: (path: string) => void recents.push(path),
			deleteRecentFile: () => {},
			setLoadingTabs: () => {},
			measureInitialViewport: () => {},
			isScrolling: () => false,
			onError: (message: string) => void errors.push(message),
			onDiskChangedUnderSave: () => {},
			cancelPendingAutoSave: () => {},
			askClose: async () => 'discard' as const,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
		});
	}

	function reset() {
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
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

	test('a command line spelling an open file differently still switches its view', async () => {
		reset();
		const session = makeSession();
		settings.openFileMode = 'preview';
		disk.set('/notes/A.md', { body: 'a', lossy: false });
		await session.loadMarkdown('/notes/A.md');
		commandLine.set('/notes/a.md', { mode: 'editor', missing: false });
		const switched: string[] = [];

		await session.openFiles(['/notes/a.md'], async (mode) => void switched.push(mode));

		assert.equal(tabManager.tabs.length, 1);
		assert.deepEqual(switched, ['editor']);
	});

	test('a command line naming a missing file that is open switches its view', async () => {
		reset();
		const session = makeSession();
		await session.openMissingFile('/notes/new.md', 'editor');
		commandLine.set('/notes/new.md', { mode: 'preview', missing: true });
		const switched: string[] = [];

		await session.openFiles(['/notes/new.md'], async (mode) => void switched.push(mode));

		assert.equal(tabManager.tabs.length, 1);
		assert.deepEqual(switched, ['preview']);
	});

	// #1087: a background tab joins recent files through its first read, which
	// records only a read that succeeds, not when the link is clicked: a dead
	// link must not leave a dead entry.
	test('a background tab enters recent files only once it reads', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/A.md', { body: 'a', lossy: false });
		disk.set('/notes/b.md', { body: 'b', lossy: false });

		await session.loadMarkdown('/notes/A.md');
		const reading = tabManager.activeTabId!;
		recents.length = 0;
		await session.openInBackgroundTab('/notes/b.md');
		assert.deepEqual(recents, [], 'nothing is recorded before a read');

		tabManager.setActive(tabManager.tabs.find((item) => item.id !== reading)!.id);
		await session.readActiveIfUnread();
		await session.readActiveIfUnread();
		assert.deepEqual(recents, ['/notes/b.md'], 'recorded once, by the read');
	});

	// Back/forward and a tab arriving from another window put a path on a tab
	// before anything has resolved it, so their claim compares spellings. The
	// identity arrives a moment later, and the claim has to be made again then.
	test('going back to a file open in another tab under another spelling leaves one tab', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/A.md', { body: 'a', lossy: false });
		disk.set('/notes/b.md', { body: 'b', lossy: false });

		await session.loadMarkdown('/notes/A.md');
		const walker = tabManager.activeTabId!;
		await session.loadMarkdown('/notes/b.md', { navigate: true });
		await session.loadMarkdown('/notes/a.md');
		tabManager.setActive(walker);

		const path = tabManager.goBack(walker)!;
		await session.loadMarkdown(path, { skipTabManagement: true });

		assert.equal(tabManager.tabs.length, 1, 'one file, one tab');
		assert.equal(tabManager.activeTabId, walker);
	});

	test('a tab arriving from another window under another spelling leaves one tab', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/A.md', { body: 'resident copy', lossy: false });
		await session.loadMarkdown('/notes/A.md');

		const arrived = tabManager.insertTransferredTab({
			path: '/notes/a.md',
			title: 'a.md',
			rawContent: 'edited elsewhere',
			originalContent: 'resident copy',
			isDirty: true,
			isEditing: true,
			scrollTop: 0,
			scrollPercentage: 0,
			anchorLine: asRendererLine(0),
			isSplit: false,
			splitRatio: 0.5,
			isScrollSynced: false,
			hasReplacementChars: false,
			encoding: 'UTF-8',
			history: ['/notes/a.md'],
			historyIndex: 0,
		});
		// The path is resolved in the background; let that answer land.
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(tabManager.tabs.length, 1, 'one file, one tab');
		assert.equal(tabManager.tabs[0].id, arrived);
		assert.equal(tabManager.tabs[0].rawContent, 'edited elsewhere');
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

	// The guard runs on the tab the content is about to land in, so it only sees a
	// mis-spelled path on the routes that pick the tab themselves and pass
	// `navigate` / `skipTabManagement`: a link followed in place, and back/forward.
	// A link written `./A.md` inside a document whose tab is open as `/notes/a.md`
	// is that case exactly — and it is the ordinary way to reach it, since link
	// text is typed by the document's author, not by the filesystem.
	test('following a link that spells the current file differently does not overwrite its unsaved edits', async () => {
		// `setTabRawContent` replaces rawContent AND originalContent, so the reload
		// would not merely lose the edits — the tab would look clean afterwards and
		// the user could not tell what went missing.
		reset();
		const session = makeSession();
		disk.set('/notes/a.md', { body: 'on disk', lossy: false });

		await session.loadMarkdown('/notes/a.md');
		const id = tabManager.activeTabId!;
		tabManager.updateTabRawContent(id, 'my unsaved paragraph');

		await session.loadMarkdown('/notes/A.md', { navigate: true });

		const tab = tabManager.tabs.find((item) => item.id === id)!;
		assert.equal(tab.rawContent, 'my unsaved paragraph', 'the edits survive');
		assert.equal(tab.originalContent, 'on disk', 'the saved baseline is intact, so the tab can still say what changed');
		assert.equal(tab.isDirty, true, 'the tab still knows it has something to save');
	});

	test('an explicit revert still discards the buffer whatever the spelling', async () => {
		// "Reload from disk" and the external-change "Reload" pass
		// `discardUnsavedBuffer`; the identity fix must not make them unreachable.
		reset();
		const session = makeSession();
		disk.set('/notes/a.md', { body: 'on disk', lossy: false });

		await session.loadMarkdown('/notes/a.md');
		const id = tabManager.activeTabId!;
		tabManager.updateTabRawContent(id, 'my unsaved paragraph');

		await session.loadMarkdown('/notes/A.md', { navigate: true, discardUnsavedBuffer: true });

		const tab = tabManager.tabs.find((item) => item.id === id)!;
		assert.equal(tab.rawContent, 'on disk');
		assert.equal(tab.isDirty, false);
	});

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
		// Untitled buffers and the home sentinel are not files and never collide.
		assert.equal(isSameFilePath({ path: '' }, { path: '' }), false);
		assert.equal(isSameFilePath({ path: 'HOME' }, { path: 'HOME' }), false);
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
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
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
			setShowHome: () => {},
			currentFile: () => tabManager.activeTab?.path ?? '',
			resetScrollHistory: () => {},
			renderMarkdown: async (raw: string) => `<p>${raw}</p>`,
			afterLoad: async () => {},
			saveRecentFile: () => {},
			deleteRecentFile: () => {},
			setLoadingTabs: () => {},
			measureInitialViewport: () => {},
			isScrolling: () => false,
			onError: () => {},
			onDiskChangedUnderSave: () => {},
			cancelPendingAutoSave: () => {},
			askClose: async () => 'discard' as const,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
		});
	}

	function reset() {
		tabManager.closeAll();
		disk.clear();
		held.clear();
		storedSnapshot = null;
		settings.openFileMode = 'preview';
	}

	function hold(cmd: string) {
		const d = deferred();
		held.set(cmd, d);
		return d;
	}

	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	const tabById = (id: string) => tabManager.tabs.find((tab) => tab.id === id)!;

	test('typing during a Live Mode reload is kept, and the tab stays dirty', async () => {
		for (const mode of ['preview', 'editor'] as const) {
			reset();
			settings.openFileMode = mode;
			const session = makeSession();
			disk.set('/notes/a.md', 'changed by another program');
			tabManager.addTab('/notes/a.md', 'original');
			const a = tabManager.activeTabId!;
			tabById(a).isEditing = mode === 'editor';

			const gate = hold(mode === 'editor' ? 'read_file_content_checked' : 'open_markdown_preview');
			const load = session.loadMarkdown('/notes/a.md');
			await settle();
			tabManager.updateTabRawContent(a, 'original plus typing');
			gate.resolve(undefined);
			await load;

			assert.equal(tabById(a).rawContent, 'original plus typing', `typing lost (${mode})`);
			assert.equal(tabById(a).isDirty, true, `edits must still read as unsaved (${mode})`);
		}
	});

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

	test('completing a partial buffer does not land on a tab that navigated away', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/big.md', 'the whole big file');
		tabManager.addTab('/notes/big.md', '');
		const a = tabManager.activeTabId!;
		tabManager.setTabRawContent(a, 'the whole', true);

		const gate = hold('read_file_content_checked');
		const completing = session.ensureFullContent(a);
		tabManager.navigate(a, '/notes/other.md');
		tabManager.setTabRawContent(a, 'other text');
		gate.resolve(undefined);
		assert.equal(await completing, true, 'the buffer the tab now holds is whole');

		assert.equal(tabById(a).rawContent, 'other text');
		assert.equal(tabById(a).path, '/notes/other.md');
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

	test('typing into a restored tab before its read lands is kept', async () => {
		reset();
		tabManager.addTab('/notes/a.md', '');
		storedSnapshot = tabManager.serializeState();
		tabManager.closeAll();
		localStorage.clear();
		disk.set('/notes/a.md', 'a on disk');
		const session = makeSession();

		const windowSession = createWindowSession({
			restoreInProgressKey: 'readLandsProgress',
			serializeState: () => tabManager.serializeState(),
			shouldRestoreState: () => true,
			isDisposed: () => false,
			restoreState: (json) => tabManager.restoreState(json),
			restoredTabs: () => tabManager.tabs.map((tab) => ({ id: tab.id, path: tab.path })),
			loadRestoredTab: (tabId) => session.readRestoredTab(tabId),
			dropRestoredTab: (tabId) => tabManager.closeTab(tabId),
			canTransfer: () => true,
			canDetach: () => true,
			transferPayload: () => '',
			onTransferClaimed: () => {},
			acceptTransferredTab: async () => 'arrived',
			onError: () => {},
			onWarning: () => {},
			onInterrupted: () => {},
		});

		// Restore reads the tab the way an open does.
		const gate = hold('read_file_content_checked');
		const restoring = windowSession.restore();
		while (tabManager.tabs.length === 0 || held.has('read_file_content_checked')) await settle();
		const a = tabManager.tabs[0].id;
		tabManager.updateTabRawContent(a, 'typed while restoring');
		gate.resolve(undefined);
		await restoring;

		assert.equal(tabById(a).rawContent, 'typed while restoring');
		assert.equal(tabById(a).isDirty, true);
	});
});

describe('tab transfer races', () => {
	beforeAll(() => {
		(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
		(window as any).__TAURI_INTERNALS__ = {
			metadata: {
				currentWindow: { label: 'main' },
				currentWebview: { windowLabel: 'main', label: 'main' },
			},
			transformCallback: (fn: unknown) => fn,
			invoke: async (cmd: string, args: any) => {
				if (cmd === 'plugin:event|listen') {
					const id = nextListener++;
					listeners.set(id, { event: args.event, handler: args.handler });
					return id;
				}
				if (cmd === 'plugin:event|unlisten') {
					listeners.delete(args.eventId);
					return null;
				}
				if (cmd === 'get_os_type') return 'macos';
				calls.push({ cmd, args });
				return respond(cmd, args);
			},
		};
	});

	afterAll(() => {
		// One store for the whole file: leave it empty for the next describe.
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
	});

	/*
	 * Moving a tab to another window takes a snapshot when it starts and closes
	 * the source tab when the destination completes, one to two seconds later.
	 * These drive the source and destination halves of `windowSession` against a
	 * scripted broker: the session and the tab store run for real, only the Tauri
	 * backend is stubbed.
	 */

	type Handler = (event: { event: string; id: number; payload: unknown }) => void;

	const listeners = new Map<number, { event: string; handler: Handler }>();
	let nextListener = 1;
	let calls: Array<{ cmd: string; args: any }> = [];
	let respond: (cmd: string, args: any) => unknown = () => null;

	const TOKEN = 'tok';

	function emit(event: string, payload: unknown) {
		for (const [id, listener] of listeners) {
			if (listener.event === event) listener.handler({ event, id, payload });
		}
	}

	/** Lets pending IPC promises resolve and effects flush. */
	async function settle() {
		for (let i = 0; i < 20; i++) {
			flushSync();
			await Promise.resolve();
		}
	}

	function makeSession(accept: () => Promise<string | null> = async () => null) {
		const claimed: string[] = [];
		const session = createWindowSession({
			restoreInProgressKey: 'markpad-window-restore-in-progress',
			serializeState: () => '',
			shouldRestoreState: () => false,
			isDisposed: () => false,
			restoreState: () => {},
			restoredTabs: () => [],
			loadRestoredTab: async () => {},
			dropRestoredTab: () => {},
			canTransfer: () => true,
			canDetach: () => true,
			transferPayload: (tabId) => tabManager.tabs.find((tab) => tab.id === tabId)!.rawContent,
			onTransferClaimed: (tabId) => {
				claimed.push(tabId);
				tabManager.closeTab(tabId);
			},
			acceptTransferredTab: accept,
			onError: () => {},
			onWarning: () => {},
			onInterrupted: () => {},
		});
		return { session, claimed };
	}

	function openTab(text: string) {
		tabManager.addTab('/notes/a.md', text);
		return tabManager.activeTabId!;
	}

	afterEach(() => {
		vi.useRealTimers();
		tabManager.closeAll();
		listeners.clear();
		calls = [];
		respond = () => null;
	});

	test('typing before the destination claims travels with the tab', async () => {
		respond = (cmd) => (cmd === 'stage_detached_tab' ? TOKEN : cmd === 'refresh_detached_tab' ? 'updated' : null);
		const tabId = openTab('first');
		const { session } = makeSession();

		const moving = session.transfer(tabId, async () => {});
		await settle();
		tabManager.updateTabRawContent(tabId, 'first, then more');
		await settle();

		const refresh = calls.find((call) => call.cmd === 'refresh_detached_tab');
		assert.ok(refresh, 'the edit never reached the broker; the destination claims the stale snapshot');
		assert.equal(refresh.args.payload, 'first, then more');

		emit('tab-transfer-claimed', TOKEN);
		assert.equal(await moving, true);
		assert.equal(tabManager.tabs.length, 0);
	});

	test('an edit after the claim withdraws the transfer and the source keeps its tab', async () => {
		respond = (cmd) => (cmd === 'stage_detached_tab' ? TOKEN : cmd === 'refresh_detached_tab' ? 'revoked' : null);
		const tabId = openTab('first');
		const { session, claimed } = makeSession();

		const moving = session.transfer(tabId, async () => {});
		await settle();
		tabManager.updateTabRawContent(tabId, 'typed while the new window rendered');
		await settle();

		assert.equal(await moving, false);
		assert.deepEqual(claimed, []);
		assert.equal(tabManager.tabs[0]?.rawContent, 'typed while the new window rendered');
	});

	test('a completion that overtook the last edit does not close the edited tab', async () => {
		// The refresh lands after `complete` took the entry: the broker says
		// `gone` and `tab-transfer-claimed` is already on its way.
		respond = (cmd) => (cmd === 'stage_detached_tab' ? TOKEN : cmd === 'refresh_detached_tab' ? 'gone' : null);
		const tabId = openTab('first');
		const { session, claimed } = makeSession();

		const moving = session.transfer(tabId, async () => {});
		await settle();
		tabManager.updateTabRawContent(tabId, 'last keystroke');
		await settle();
		emit('tab-transfer-claimed', TOKEN);

		assert.equal(await moving, false);
		assert.deepEqual(claimed, []);
		assert.equal(tabManager.tabs[0]?.rawContent, 'last keystroke');
	});

	test('a destination whose completion is refused drops the tab it built', async () => {
		respond = (cmd) => {
			if (cmd === 'claim_detached_tab') {
				return JSON.stringify({
					path: '/notes/a.md',
					title: 'a.md',
					rawContent: 'old',
					originalContent: 'old',
					isDirty: false,
					isEditing: false,
					isSplit: false,
					isScrollSynced: false,
					hasReplacementChars: false,
					encoding: 'UTF-8',
					splitRatio: 0.5,
					scrollTop: 0,
					scrollPercentage: 0,
					anchorLine: 0,
					historyIndex: 0,
					history: [],
				});
			}
			if (cmd === 'complete_detached_tab') {
				return Promise.reject('TRANSFER_NOT_FOUND: the staged tab is gone; the source window kept it');
			}
			return null;
		};
		const { session } = makeSession(async () => openTab('old'));

		assert.equal(await session.acceptOfferedTransfer(TOKEN), false);
		assert.equal(tabManager.tabs.length, 0, 'the source kept the tab, so this copy is a duplicate');
	});

	test('a claim the destination never completes is handed back after its grace', async () => {
		vi.useFakeTimers();
		// Claimed, then the destination window died: the broker protects the
		// claim for a while and then lets the source cancel it.
		const outcomes = [
			{ cancelled: false, claimed: true },
			{ cancelled: false, claimed: true },
			{ cancelled: true, claimed: true },
		];
		respond = (cmd) => (cmd === 'stage_detached_tab' ? TOKEN : cmd === 'cancel_detached_tab' ? outcomes.shift() : null);
		const tabId = openTab('doc');
		const { session } = makeSession();

		let result: boolean | undefined;
		void session.transfer(tabId, async () => {}).then((moved) => (result = moved));
		for (let i = 0; i < 4; i++) {
			await vi.advanceTimersByTimeAsync(15_000);
			await settle();
		}

		assert.equal(result, false, 'the source stopped asking after one refusal and stayed stuck');
		assert.equal(tabManager.tabs.length, 1);
		// The tab is movable again.
		assert.equal(calls.filter((call) => call.cmd === 'stage_detached_tab').length, 1);
		void session.transfer(tabId, async () => {});
		await settle();
		assert.equal(calls.filter((call) => call.cmd === 'stage_detached_tab').length, 2);
	});

	const ARRIVING = JSON.stringify({
		path: '/notes/a.md',
		title: 'a.md',
		rawContent: 'old',
		originalContent: 'old',
		isDirty: false,
		isEditing: false,
		isSplit: false,
		isScrollSynced: false,
		hasReplacementChars: false,
		encoding: 'UTF-8',
		splitRatio: 0.5,
		scrollTop: 0,
		scrollPercentage: 0,
		anchorLine: 0,
		historyIndex: 0,
		history: [],
	});

	test('the source keeps waiting when the destination has already claimed', async () => {
		// The 15s timeout is a guess about a window that may simply be slow to
		// render. Cancelling regardless is what stranded a copy on each side.
		vi.useFakeTimers();
		respond = (cmd) =>
			cmd === 'stage_detached_tab' ? TOKEN : cmd === 'cancel_detached_tab' ? { cancelled: false, claimed: true } : null;
		const tabId = openTab('doc');
		const { session } = makeSession();

		let result: boolean | undefined;
		void session.transfer(tabId, async () => {}).then((moved) => (result = moved));
		for (let i = 0; i < 3; i++) {
			await vi.advanceTimersByTimeAsync(15_000);
			await settle();
		}
		assert.ok(calls.some((call) => call.cmd === 'cancel_detached_tab'), 'the timeout asked the broker');
		assert.equal(result, undefined, 'a claimed transfer was given up on while the destination rendered');

		emit('tab-transfer-claimed', TOKEN);
		await settle();
		assert.equal(result, true);
		assert.equal(tabManager.tabs.length, 0);
	});

	test('the destination releases its claim when it cannot finish', async () => {
		// Because a claimed transfer is immune to the source's timeout, the
		// destination is the only party that can end a claim it cannot complete.
		const cases: Array<[string, string, () => Promise<string | null>]> = [
			['an invalid payload', '{"not":"a tab"}', async () => 'never'],
			['a refusing destination', ARRIVING, async () => null],
			['a thrown render', ARRIVING, async () => { throw new Error('render failed'); }],
		];
		for (const [why, payload, accept] of cases) {
			calls = [];
			respond = (cmd) => (cmd === 'claim_detached_tab' ? payload : null);
			const { session } = makeSession(accept);

			assert.equal(await session.acceptOfferedTransfer(TOKEN), false, why);
			assert.deepEqual(
				calls.filter((call) => call.cmd === 'cancel_detached_tab').map((call) => call.args),
				[{ token: TOKEN }],
				`${why} must hand the claim back exactly once`,
			);
		}
	});

	test('a claim is distinguished from "no such token"', async () => {
		// Releasing a token that was never claimed would be a no-op at best and a
		// cancel of someone else's transfer at worst.
		respond = () => null;
		const { session } = makeSession(async () => 'never');

		assert.equal(await session.acceptOfferedTransfer(TOKEN), false);
		assert.deepEqual(calls.map((call) => call.cmd), ['claim_detached_tab']);
	});

	test('a second transfer of the same tab is refused while one is in flight', async () => {
		// The menu entry becomes clickable again long before the transfer
		// resolves; two payloads for one tab means two windows each build it.
		respond = (cmd) => (cmd === 'stage_detached_tab' ? TOKEN : null);
		const tabId = openTab('doc');
		const { session } = makeSession();

		const first = session.transfer(tabId, async () => {});
		await settle();
		const second = session.transfer(tabId, async () => {});
		await settle();
		assert.equal(calls.filter((call) => call.cmd === 'stage_detached_tab').length, 1, 'a second payload was staged');

		emit('tab-transfer-claimed', TOKEN);
		assert.equal(await first, true);
		assert.equal(await second, false);
	});

	// --- the viewer's side: what this window sends and how it takes a tab in ---

	function makeTransfer(overrides: Partial<Parameters<typeof createTransferOptions>[0]> = {}) {
		return createTransferOptions({
			
			windowStateJson: () => tabManager.serializeState(),
			isCloseWalkActive: () => false,
			isDisposed: () => false,
			renderPreview: async () => {},
			restoreReadingPosition: () => {},
			...overrides,
		});
	}

	/** A payload as another window would send it, with this store left empty. */
	function arrivingSnapshot() {
		const tabId = openTab('# arriving');
		const snapshot = snapshotTab(tabManager.tabs.find((tab) => tab.id === tabId)!);
		tabManager.closeAll();
		return snapshot;
	}

	test('a failed render undoes the inserted tab', async () => {
		// The tab must exist before it can be rendered, so the destination owns a
		// document the source still shows until the render succeeds.
		const snapshot = arrivingSnapshot();
		const failing = makeTransfer({ renderPreview: () => Promise.reject(new Error('render failed')) });
		await assert.rejects(failing.acceptTransferredTab(snapshot), /render failed/);
		assert.equal(tabManager.tabs.length, 0);

		let disposed = false;
		const closing = makeTransfer({ isDisposed: () => disposed, renderPreview: async () => void (disposed = true) });
		assert.equal(await closing.acceptTransferredTab(snapshot), null);
		assert.equal(tabManager.tabs.length, 0, 'a window torn down mid-render keeps no half-arrived tab');
	});

	test('the arriving tab is put back where its reader was, after its document lands', async () => {
		// `insertTransferredTab` activates the tab while its preview is still
		// empty, so a restore before the render has nothing to scroll.
		const snapshot = arrivingSnapshot();
		const log: string[] = [];
		const transfer = makeTransfer({
			renderPreview: async () => {
				await Promise.resolve();
				log.push('rendered');
			},
			restoreReadingPosition: (tab) => log.push(`restored ${tab.path}`),
		});
		const id = await transfer.acceptTransferredTab(snapshot);
		assert.equal(id, tabManager.activeTabId);
		assert.deepEqual(log, ['rendered', 'restored /notes/a.md']);

		// Only the active tab's host is displayed: a reader who switched away
		// during the render must not have the document on screen moved.
		tabManager.closeAll();
		log.length = 0;
		const switching = makeTransfer({
			renderPreview: async () => void tabManager.addTab('/notes/other.md', 'other'),
			restoreReadingPosition: () => log.push('restored'),
		});
		await switching.acceptTransferredTab(snapshot);
		assert.deepEqual(log, []);
	});

	test('moving to an existing window uses the acknowledged transfer protocol', async () => {
		respond = (cmd) => (cmd === 'stage_detached_tab' ? TOKEN : null);
		const tabId = openTab('doc');
		const { session } = makeSession();
		const movers = createTabMovers({ ensureFullContent: async () => true, onPartialDocument: () => {}, session });

		const moving = movers.moveTabToWindow(tabId, 'w2', true);
		await settle();
		const offer = calls.find((call) => call.cmd === 'offer_tab_to_window');
		assert.deepEqual(offer?.args, { targetLabel: 'w2', token: TOKEN });
		assert.equal(tabManager.tabs.length, 1, 'the source keeps the tab until the target acknowledges');

		emit('tab-transfer-claimed', TOKEN);
		assert.equal(await moving, true);
		assert.equal(tabManager.tabs.length, 0);
		assert.deepEqual(calls.find((call) => call.cmd === 'focus_window')?.args, { label: 'w2' });
	});
});

describe('tabs the store builds', () => {
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
		};
	});

	let language: typeof settings.language;
	beforeEach(() => {
		language = settings.language;
		tabManager.closeAll();
	});
	afterEach(() => {
		settings.language = language;
		tabManager.closeAll();
	});

	test('a tab arriving from another window gets a free localized untitled title, becomes active, and its id is returned', async () => {
		await loadLocale('de');
		settings.language = 'de';
		tabManager.addNewTab();
		const resident = tabManager.activeTabId;

		const id = tabManager.insertTransferredTab({
			// Numbered in the source window, where it was the first untitled tab.
			path: '',
			title: 'Unbenannt 1',
			rawContent: 'draft',
			originalContent: '',
			isDirty: true,
			isEditing: true,
			scrollTop: 0,
			scrollPercentage: 0,
			anchorLine: asRendererLine(0),
			isSplit: false,
			splitRatio: 0.5,
			isScrollSynced: false,
			hasReplacementChars: false,
			encoding: 'UTF-8',
			history: [],
			historyIndex: 0,
		});

		assert.notEqual(id, resident);
		assert.equal(tabManager.activeTabId, id);
		assert.equal(tabManager.tabs.find((tab) => tab.id === id)?.rawContent, 'draft');
		assert.deepEqual(tabManager.tabs.map((tab) => tab.title), ['Unbenannt 1', 'Unbenannt 2']);
	});

});
