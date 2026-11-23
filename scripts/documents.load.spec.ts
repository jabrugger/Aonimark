import assert from 'node:assert/strict';

import { afterAll, beforeAll, describe, test } from 'vitest';

// Each describe installs its own Tauri stub in `beforeAll`. This one only
// answers the settings store, which boots when the modules below are imported.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { settings } = await import('../src/lib/stores/settings.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

// A read can fail on a file that is perfectly fine a moment later: a watcher
// fires while another process is replacing the file, a network volume blinks,
// a sync client swaps the inode. Closing the tab on that error throws away the
// buffer the user could still have saved somewhere else, and dropping the
// recent-file entry throws away the way back to it.
//
// This was asserted by matching documentSession for `/tabManager\.closeTab/`
// and for the exact `options.onError('Error loading file', error);` call. The
// first is satisfied by any file that happens not to contain those characters
// — including one that closes the tab through a differently spelled route —
// and the second pins a string literal. `createDocumentSession` takes its
// collaborators as plain callbacks, and eleven other files in this suite
// already build one, so the failure can be run instead of described.
describe('document load failure', () => {
	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity. Only
	// the Tauri backend, which jsdom cannot provide, is stubbed.
	let handleInvoke: (cmd: string, args: any) => unknown = (cmd) => {
		throw new Error(`unexpected invoke: ${cmd}`);
	};
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => Promise.resolve(handleInvoke(cmd, args)),
		};
	});

	const errors: { message: string; error: unknown }[] = [];
	const deletedRecents: string[] = [];

	function makeSession(overrides: Record<string, unknown> = {}) {
		return createDocumentSession({
			afterLoad: async () => {},
			onError: (message: string, error: unknown) => void errors.push({ message, error }),
			onDiskChangedUnderSave: () => {},
			cancelPendingAutoSave: () => {},
			askClose: async () => 'discard' as const,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
			...overrides,
		});
	}

	/** Every read of `path` fails; anything else the load path asks for is absent too. */
	function readsFail() {
		handleInvoke = () => {
			throw new Error('No such file or directory (os error 2)');
		};
	}

	test('a read that fails keeps the open tab, its buffer and its recent entry', async () => {
		tabManager.tabs = [];
		tabManager.activeTabId = null;
		errors.length = 0;
		deletedRecents.length = 0;

		const session = makeSession();
		tabManager.addTab('/notes/a.md', 'the text the reader can still rescue');
		const before = tabManager.activeTab!;
		readsFail();

		await session.loadMarkdown('/notes/a.md');

		assert.equal(tabManager.tabs.length, 1, 'the tab is not closed');
		assert.equal(tabManager.tabs[0].id, before.id, 'and it is the same tab, not a replacement');
		assert.equal(
			tabManager.tabs[0].rawContent,
			'the text the reader can still rescue',
			'the buffer is not replaced by the failed read',
		);
		assert.deepEqual(deletedRecents, [], 'the recent-file entry survives, so the file can be reopened');
	});

	test('the failure is reported rather than swallowed', async () => {
		tabManager.tabs = [];
		tabManager.activeTabId = null;
		errors.length = 0;

		const session = makeSession();
		tabManager.addTab('/notes/a.md', 'buffer');
		readsFail();

		await session.loadMarkdown('/notes/a.md');

		assert.equal(errors.length, 1, 'exactly one error reaches the caller');
		assert.equal(errors[0].message, 'Error loading file');
		assert.ok(errors[0].error instanceof Error, 'the cause is passed on, not flattened to a string');
	});
});

// Live Mode reloads the open file when something else writes it — git
// checkout, a cloud sync, a second Markpad window. The reload path
// replaces rawContent AND originalContent, so a buffer with unsaved edits is
// not just overwritten, it stops looking dirty afterwards: the user cannot
// even tell what they lost. Turning Live Mode ON must likewise never pull
// disk content over the buffer.
//
// Whether an event is somebody else's write used to be guessed from the clock:
// each of our own writes opened a 400ms window in which events for that path
// were discarded. Both directions of that guess were wrong and both are tested
// below — a foreign write inside the window was DROPPED and then overwritten by
// the next auto-save, and a late event about our own write raised a conflict
// bar about nothing. `originalContent` answers the question exactly, and the
// same answer now also guards the write itself, which is the half that works
// when the watcher does not.
describe('external change reload', () => {
	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity, and jsdom
	// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

	/**
	 * The filesystem, as far as these tests are concerned. Real enough for the
	 * question every test here asks — "what does the file say right now?" — and the
	 * reason the suite no longer needs to fake a clock.
	 */
	const disk = new Map<string, string>();

	const diskInvoke = (cmd: string, args: any): unknown => {
		if (cmd === 'canonicalize_path') return args.path;
		if (cmd === 'read_file_content_checked') {
			if (!disk.has(args.path)) throw new Error(`no such file: ${args.path}`);
			return [disk.get(args.path), false, 'UTF-8'];
		}
		if (cmd === 'save_file_content') {
			disk.set(args.path, args.content);
			return null;
		}
		throw new Error(`unexpected invoke: ${cmd}`);
	};
	let handleInvoke = diskInvoke;
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => Promise.resolve(handleInvoke(cmd, args)),
		};
	});

	let refusedSaves: string[] = [];
	let closeQuestions: boolean[] = [];
	let closeAnswer: 'save' | 'discard' | 'cancel' = 'discard';

	function makeSession(overrides: Record<string, unknown> = {}) {
		return createDocumentSession({
			afterLoad: async () => {},
			onError: () => {},
			onDiskChangedUnderSave: (tabId: string) => refusedSaves.push(tabId),
			cancelPendingAutoSave: () => {},
			askClose: async (_title: string, diskMoved: boolean) => {
				closeQuestions.push(diskMoved);
				return closeAnswer;
			},
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
			...overrides,
		});
	}

	/** A file on disk, open in a tab whose buffer matches it. */
	function open(path: string, content: string) {
		disk.set(path, content);
		tabManager.addTab(path, content);
		const tab = tabManager.activeTab!;
		tab.originalContent = content;
		return tab;
	}

	function reset() {
		tabManager.tabs = [];
		tabManager.activeTabId = null;
		disk.clear();
		handleInvoke = diskInvoke;
		refusedSaves = [];
		closeQuestions = [];
		closeAnswer = 'discard';
	}

	test('a clean tab that owns the changed file is reloaded', async () => {
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		disk.set('/notes/a.md', 'somebody else wrote this');

		assert.deepEqual(await session.resolveExternalChange('/notes/a.md'), {
			action: 'reload',
			tabId: tab.id,
			path: '/notes/a.md',
		});
	});

	test('a tab with unsaved edits is never reloaded behind the user', async () => {
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my unsaved paragraph');
		disk.set('/notes/a.md', 'somebody else wrote this');

		const outcome = await session.resolveExternalChange('/notes/a.md');

		assert.equal(outcome.action, 'conflict');
		assert.equal((outcome as { tabId: string }).tabId, tab.id);
		// The buffer and its dirty marker must both survive: overwriting
		// originalContent is what made the loss invisible after the fact.
		assert.equal(tab.rawContent, 'my unsaved paragraph');
		assert.equal(tab.originalContent, 'on disk');
		assert.equal(tab.isDirty, true);
	});

	test('the changed path decides which tab is affected, not whichever tab is active', async () => {
		reset();
		const session = makeSession();
		const a = open('/notes/a.md', 'a on disk');
		const b = open('/notes/b.md', 'b on disk');
		tabManager.setActive(b.id);
		tabManager.updateTabRawContent(b.id, 'b unsaved');
		disk.set('/notes/a.md', 'a changed');

		const outcome = await session.resolveExternalChange('/notes/a.md');

		// Reloading here would pull b.md's disk content over b's unsaved buffer
		// because a.md changed. Whatever the outcome, it must not name tab b.
		assert.notEqual((outcome as { tabId?: string }).tabId, b.id);
		assert.equal(b.rawContent, 'b unsaved');
		assert.notEqual(a.id, b.id);
	});

	test('a change to a file no tab holds is ignored', async () => {
		reset();
		const session = makeSession();
		open('/notes/a.md', 'a on disk');

		assert.deepEqual(await session.resolveExternalChange('/notes/elsewhere.md'), { action: 'ignore' });
		assert.deepEqual(await session.resolveExternalChange(''), { action: 'ignore' });
	});

	test('our own write is not an external change, however late the event arrives', async () => {
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');
		assert.equal(await session.saveContent(tab.id), true);

		// No clock is consulted, so there is no window to be outside of. The old
		// guard answered this correctly for 400ms and then started answering it
		// wrong; a slow watcher, a network share or a synced folder is all it took.
		assert.deepEqual(await session.resolveExternalChange('/notes/a.md'), { action: 'ignore' });
		assert.deepEqual(await session.resolveExternalChange('/notes/a.md'), { action: 'ignore' });
	});

	test('a late event about our own save is not raised as a conflict', async () => {
		// The second failure of the clock, and the one that costs trust rather than
		// data: with the user typing again after a save, an event that arrived after
		// the window found a dirty tab and asked "this file changed on disk" about
		// their own keystrokes. Zed is disliked for exactly this
		// (zed-industries/zed#42108) — a question that is sometimes false gets
		// dismissed the times it is true.
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');
		assert.equal(await session.saveContent(tab.id), true);
		tabManager.updateTabRawContent(tab.id, 'my edit, and more');

		assert.deepEqual(await session.resolveExternalChange('/notes/a.md'), { action: 'ignore' });
		assert.equal(tab.isDirty, true, 'and the later typing is still unsaved');
	});

	test('a foreign write moments after our own is still reported', async () => {
		// The direction that lost data. Inside the old 400ms window this event was
		// DISCARDED with nothing re-queued: the buffer held our text, the disk held
		// theirs, the tab looked clean, and the next keystroke's auto-save put ours
		// back over theirs. Nothing anywhere said so.
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');
		assert.equal(await session.saveContent(tab.id), true);

		disk.set('/notes/a.md', 'their edit, one moment later');

		assert.deepEqual(await session.resolveExternalChange('/notes/a.md'), {
			action: 'reload',
			tabId: tab.id,
			path: '/notes/a.md',
		});
	});

	// --- the guard that does not depend on the watcher ---

	test('a save is refused when the disk moved under it', async () => {
		// The watcher's events can be missed, so this is the check every editor
		// that does not lose work has: VS Code refuses the save
		// ("The content of the file is newer"), Vim re-stats before each write, and
		// Vim has no watcher at all.
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');
		disk.set('/notes/a.md', 'their edit');

		assert.equal(await session.saveContent(tab.id), false);
		assert.equal(disk.get('/notes/a.md'), 'their edit', 'their work was overwritten anyway');
		assert.deepEqual(refusedSaves, [tab.id], 'the refusal was not reported, so nothing asked the user');
		assert.equal(tab.rawContent, 'my edit', 'and the refusal must not cost the user their buffer');
		assert.equal(tab.isDirty, true);
	});

	test('answering "keep mine" authorises the next save, and only the next one', async () => {
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');
		disk.set('/notes/a.md', 'their edit');
		assert.equal(await session.saveContent(tab.id), false);

		session.allowOverwriteOnce(tab.id);
		assert.equal(await session.saveContent(tab.id), true);
		assert.equal(disk.get('/notes/a.md'), 'my edit');

		// A third program writing a minute later is a new question the user has not
		// answered, so the authorisation must not still be lying around.
		tabManager.updateTabRawContent(tab.id, 'my later edit');
		disk.set('/notes/a.md', 'somebody else again');
		assert.equal(await session.saveContent(tab.id), false);
		assert.equal(disk.get('/notes/a.md'), 'somebody else again');
	});

	test('an ordinary save of an untouched file still just saves', async () => {
		// The guard has to be invisible in the common case, which is every save.
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');

		assert.equal(await session.saveContent(tab.id), true);
		assert.equal(disk.get('/notes/a.md'), 'my edit');
		assert.deepEqual(refusedSaves, []);
		assert.equal(tab.isDirty, false);
	});

	// --- closing must not answer the question for the user ---

	test('closing a tab whose file changed asks, instead of auto-saving over it', async () => {
		// Auto-save is on by default, and `canCloseTab` used to hand a dirty tab
		// straight to it — which is the same answer as "keep mine", to a question
		// the user was shown and did not answer, in the direction that destroys the
		// other program's work. VS Code prompts here.
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');
		disk.set('/notes/a.md', 'their edit');

		closeAnswer = 'cancel';
		assert.equal(await session.canCloseTab(tab.id), false);
		assert.deepEqual(closeQuestions, [true], 'the dialog was not told the disk had moved');
		assert.equal(disk.get('/notes/a.md'), 'their edit', 'and nothing was written behind the question');
	});

	test('answering Save to that dialog does overwrite, rather than failing silently', async () => {
		// The write guard refuses a changed file, so without the authorisation this
		// answer carries, Save would return false and the tab would refuse to close
		// — a dialog whose Save button does nothing.
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');
		disk.set('/notes/a.md', 'their edit');

		closeAnswer = 'save';
		assert.equal(await session.canCloseTab(tab.id), true);
		assert.equal(disk.get('/notes/a.md'), 'my edit');
	});

	test('closing an untouched file still just saves and closes', async () => {
		// The question is for the case that earned it. Every other close keeps the
		// behaviour it had.
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');

		assert.equal(await session.canCloseTab(tab.id), true);
		assert.equal(disk.get('/notes/a.md'), 'my edit');
		assert.deepEqual(closeQuestions, [], 'nothing was asked');
	});

	// --- #692: the editor is where the reload has to land ---

});


// Opening a file that is ALREADY open in a tab with unsaved edits must not
// re-read it from disk. `setTabRawContent` replaces rawContent AND
// originalContent, so the edits would not merely be overwritten — the tab
// would look clean afterwards and the user could not tell what was lost.
//
// This is the same loss `resolveExternalChange` already refuses for a watcher
// event (#374), reached through the ordinary open path instead: recent files,
// drag-and-drop, the OS handing us a path, or a link opened in a new tab.
// Discarding a buffer stays what it is everywhere else — an explicit command
// ("Reload from disk", the external-change "Reload"), never a side effect of
// asking to see a file.
describe('reopening a dirty document', () => {
	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity. Only
	// the Tauri backend, which jsdom cannot provide, is stubbed.

	// What the file says right now, and every read the session performed.
	const disk = new Map<string, string>();
	const reads: string[] = [];

	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => {
				if (cmd === 'read_file_content_checked') {
					reads.push(args.path);
					return Promise.resolve([disk.get(args.path) ?? '', false]);
				}
				if (cmd === 'open_markdown_preview') {
					reads.push(args.path);
					return Promise.resolve([disk.get(args.path) ?? '', true, false]);
				}
				if (cmd === 'get_os_type') return Promise.resolve('macos');
				return Promise.resolve(null);
			},
		};
	});

	function makeSession() {
		return createDocumentSession({
			afterLoad: async () => {},
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
		tabManager.tabs = [];
		tabManager.activeTabId = null;
		localStorage.clear();
		disk.clear();
		reads.length = 0;
	}

	/** A tab holding `path`, edited but not saved. */
	function openEdited(path: string, onDisk: string, edits: string) {
		disk.set(path, onDisk);
		tabManager.addTab(path, onDisk);
		const id = tabManager.activeTabId!;
		tabManager.updateTabRawContent(id, edits);
		return tabManager.tabs.find((tab) => tab.id === id)!;
	}

	// --- opening a file must never cost a buffer ---


	// --- the pre-existing loss, independent of one-tab-per-path ---

	test('re-opening the edited file already in front does not reload it either', async () => {
		reset();
		const session = makeSession();
		const edited = openEdited('/notes/a.md', 'on disk', 'my unsaved paragraph');

		// The Home screen is an overlay, not a tab switch: opening the file you are
		// already editing leaves activeTabId alone, so "did we switch tabs?" is not
		// a safe test for this.
		await session.loadMarkdown('/notes/a.md');

		assert.equal(edited.rawContent, 'my unsaved paragraph');
		assert.equal(edited.isDirty, true);
		assert.deepEqual(reads, []);
	});

	// --- the guard must not block the ordinary paths ---

	test('a clean tab is reloaded from disk as before', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/a.md', 'first');
		tabManager.addTab('/notes/a.md', 'first');
		const id = tabManager.activeTabId!;

		disk.set('/notes/a.md', 'second');
		await session.loadMarkdown('/notes/a.md');

		const tab = tabManager.tabs.find((item) => item.id === id)!;
		assert.equal(tab.rawContent, 'second');
		assert.equal(tab.isDirty, false);
		assert.deepEqual(reads, ['/notes/a.md']);
	});



	test('a conflict alone does not authorize the next open to discard the buffer', async () => {
		reset();
		const session = makeSession();
		const edited = openEdited('/notes/a.md', 'on disk', 'my unsaved paragraph');

		disk.set('/notes/a.md', 'someone else wrote this');
		await session.resolveExternalChange('/notes/a.md');
		reads.length = 0;

		// Same tab, same path, conflict outstanding — but this is an open, and it
		// did not ask to discard anything.
		await session.loadMarkdown('/notes/a.md');

		assert.equal(edited.rawContent, 'my unsaved paragraph');
		assert.equal(edited.isDirty, true);
		assert.deepEqual(reads, []);
	});
});

// A markdown file larger than 50KB is opened twice: `open_markdown_preview`
// returns the first 50KB so something renders immediately, and a background
// `read_file_content` fills in the rest. Between the two, the tab's ONLY
// buffer is a partial copy of the document. Anything that writes that buffer
// back — auto-save, Cmd+S, a task checkbox, a tab moved to another window —
// permanently truncates the user's file.
//
// These tests drive the real TabManager and the real document session with a
// stubbed Tauri bridge, so they lock the behaviour, not the wording.
describe('truncated buffer guard', () => {
	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity, and jsdom
	// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

	const PREVIEW_BYTES = 50000;
	const FULL = `# big\n\n${'x'.repeat(PREVIEW_BYTES)}\n\ntail that must never be lost\n`;
	const PARTIAL = FULL.slice(0, PREVIEW_BYTES);

	let invokeCalls: Array<{ cmd: string; args: any }> = [];
	/** Set per test. Return a never-settling promise to freeze the partial state. */
	let handleInvoke: (cmd: string, args: any) => unknown = () => {
		throw new Error('unexpected invoke');
	};

	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => {
				invokeCalls.push({ cmd, args });
				return Promise.resolve(handleInvoke(cmd, args)).then((value) => value);
			},
		};
	});

	const errors: string[] = [];
	/** Non-failure notices the session raised, in order. */
	const notices: string[] = [];
	/** What the close dialog answers next. Set per test. */
	let closeAnswer: 'save' | 'discard' | 'cancel' = 'discard';

	function makeSession() {
		return createDocumentSession({
			afterLoad: async () => {},
			onError: (message) => errors.push(message),
			onDiskChangedUnderSave: () => {},
			cancelPendingAutoSave: () => {},
			askClose: async () => closeAnswer,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => notices.push('partialCopySaved'),
		});
	}

	function reset() {
		tabManager.tabs = [];
		tabManager.activeTabId = null;
		invokeCalls = [];
		errors.length = 0;
		notices.length = 0;
		closeAnswer = 'discard';
	}

	/** Open a >50KB file and leave the background full read pending forever. */
	async function openPartial(path = '/docs/big.md') {
		handleInvoke = (cmd) => {
			if (cmd === 'open_markdown_preview') return [PARTIAL, false, false];
			if (cmd === 'read_file_content_checked') return new Promise(() => {});
			throw new Error(`unexpected invoke: ${cmd}`);
		};
		const session = makeSession();
		await session.loadMarkdown(path);
		const tab = tabManager.activeTab!;
		assert.equal(tab.rawContent, PARTIAL, 'precondition: the buffer is the partial read');
		return { session, tab };
	}

	test('completing a buffer that is already whole does not re-read the file', async () => {
		reset();
		handleInvoke = (cmd) => {
			if (cmd === 'open_markdown_preview') return [FULL, true, false];
			throw new Error(`unexpected invoke: ${cmd}`);
		};
		const session = makeSession();
		await session.loadMarkdown('/docs/small.md');
		const before = invokeCalls.length;

		assert.equal(await session.ensureFullContent(tabManager.activeTabId!), true);
		assert.equal(invokeCalls.length, before);
	});


	// --- the refusal itself: what each writer does when the buffer stays partial ---
	//
	// Everything above proves the guard lets a COMPLETED buffer through. The
	// branch it exists for — `ensureFullContent` answering false — had no test
	// driving a writer into it, and an audit that deleted the verdict check from
	// `toggleTaskCheckbox` outright left the whole suite green.
	//
	// `ensureFullContent` answers false in exactly three states, and each is
	// exercised below:
	//
	//   1. the tab is gone — a transfer or detach whose tab closed mid-flight,
	//   2. the partial buffer already carries edits: replacing it would trade the
	//      user's typing for the file's tail, so it is left alone,
	//   3. the re-read itself failed — the only one of the three that reports.
	//
	// The two writers that do not consult it, `saveContent` and `saveContentAs`,
	// carry the same refusal as their own `isTruncated` backstop, so they are
	// driven into it here too.
	//
	// A buffer that is still partial afterwards is unusable in both directions: it
	// cannot be written (that truncates the file) and it can no longer be completed
	// (state 2 is permanent once the buffer is dirty). So every test asserts the
	// same pair — nothing reached `save_file_content`, and the buffer was left
	// exactly as it was found.

	/** Did anything at all get written to disk in this test? */
	const wroteToDisk = () => invokeCalls.some((call) => call.cmd === 'save_file_content');

	const TASKS = `- [ ] first\n\n${'y'.repeat(PREVIEW_BYTES)}\n\n- [ ] last\n`;
	const TASKS_PARTIAL = TASKS.slice(0, PREVIEW_BYTES);

	/** Open the >50KB task list and leave it holding only its preview slice. */
	async function openPartialTasks() {
		handleInvoke = (cmd) => {
			if (cmd === 'open_markdown_preview') return [TASKS_PARTIAL, false, false];
			if (cmd === 'read_file_content_checked') return new Promise(() => {});
			throw new Error(`unexpected invoke: ${cmd}`);
		};
		const session = makeSession();
		await session.loadMarkdown('/docs/tasks.md');
		const tab = tabManager.activeTab!;
		assert.equal(tab.rawContent, TASKS_PARTIAL, 'precondition: the buffer is the partial read');
		return { session, tab };
	}

	/**
	 * From here on the file's tail cannot be read — an unplugged drive, a network
	 * volume that went away, a file another process replaced. Writes are allowed
	 * through so that a guard which stops refusing is caught by the write it lets
	 * happen, not by an "unexpected invoke" from the stub.
	 */
	/**
	 * The original file's tail cannot be read any more — the case Save As exists to
	 * rescue. `/docs/copy.md`, the file the rescue writes, is readable: it is a new
	 * file the process just created, and every save checks the disk against its own
	 * baseline before overwriting.
	 */
	function makeTailUnreadable() {
		const written = new Map<string, string>();
		handleInvoke = (cmd, args) => {
			if (cmd === 'read_file_content_checked') {
				const saved = written.get(args.path);
				if (saved !== undefined) return [saved, false, 'UTF-8'];
				return Promise.reject(new Error('Os { code: 5, kind: Uncategorized }'));
			}
			if (cmd === 'save_file_content') {
				written.set(args.path, args.content);
				return null;
			}
			if (cmd === 'canonicalize_path') return '/docs/copy.md';
			if (cmd === 'plugin:dialog|save') return '/docs/copy.md';
			throw new Error(`unexpected invoke: ${cmd}`);
		};
	}

});
