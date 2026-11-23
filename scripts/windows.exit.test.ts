import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createWindowExit, type WindowExitOptions } from '../src/lib/sessions/windowExit.js';

// Every way a window ends runs `createWindowExit` against a stub window. The
// Tauri bridge is the one boundary doubled: `invoke` calls are recorded, and
// `update_pinned_tag` answers whether the pin entry still exists.

type Tab = { id: string; path: string; isDirty: boolean };
type Answer = boolean | Promise<boolean>;

let invoked: { cmd: string; args: any }[] = [];
let handleInvoke: (cmd: string, args: any) => unknown = () => null;
(globalThis as any).window = {
	__TAURI_INTERNALS__: {
		invoke: async (cmd: string, args: any) => {
			invoked.push({ cmd, args });
			return handleInvoke(cmd, args);
		},
	},
};

function stubWindow(
	tabs: Tab[],
	settings: Partial<WindowExitOptions['settings']> = {},
	answers: Record<string, Answer> = {},
	recovery: Partial<WindowExitOptions['recovery']> = {},
) {
	invoked = [];
	const log: string[] = [];
	const saves: string[][] = [];
	const pin = { exists: true };
	const loaded: string[] = [];
	let destroyed = false;
	let closed = false;
	handleInvoke = (cmd, args) => {
		if (cmd === 'update_pinned_tag') {
			saves.push([...args.files]);
			return pin.exists;
		}
		if (cmd === 'save_pinned_tag') throw new Error('a closing window recreated its pin');
		if (cmd === 'list_viewer_windows') return [];
		if (cmd === 'keeps_unsaved_on_close') return true;
		return null;
	};
	const closeTab = (id: string) => {
		log.push(`close:${id}`);
		const at = tabs.findIndex((tab) => tab.id === id);
		if (at !== -1) tabs.splice(at, 1);
	};
	const tabManager = {
		tabs,
		windowTag: { name: 'work', color: '#f00', pinned: true } as { name: string; color: string; pinned: boolean } | null,
		closeTab,
		setActive: (id: string) => void log.push(`active:${id}`),
		setWindowTag: (tag: any) => void (tabManager.windowTag = tag ? { ...tag, pinned: tag.pinned === true } : null),
	};
	const others = [
		{ label: 'second', close: async () => void log.push('close-window:second') },
		{ label: 'main', close: async () => void log.push('close-window:main(other)') },
	];
	const exit = createWindowExit({
		tabManager,
		settings: {
			autoSave: false,
			restoreStateOnReopen: false,
			persistOpenEditors: false,
			...settings,
		},
		appWindow: {
			label: 'main',
			close: async () => {
				closed = true;
				log.push('close-window:main');
			},
			destroy: async () => {
				destroyed = true;
				log.push('destroy');
			},
		},
		recovery: { isReady: () => false, keep: async () => true, drop: async () => true, ...recovery },
		persistWindowState: async () => void log.push('persist'),
		canCloseTab: async (id) => {
			log.push(`ask:${id}`);
			const answer = await (answers[id] ?? true);
			// Save or Don't Save resolves the tab; Cancel leaves it as it was.
			if (answer) {
				const tab = tabs.find((item) => item.id === id);
				if (tab) tab.isDirty = false;
			}
			return answer;
		},
		saveSilently: async (id) => {
			log.push(`silent:${id}`);
			const tab = tabs.find((item) => item.id === id)!;
			tab.isDirty = false;
			return true;
		},
		hasExternalChangeConflict: () => false,
		onAutoSaveFailed: () => void log.push('toast:autoSaveFailed'),
		settle: async () => {},
	});
	return { exit, tabs, log, saves, pin, loaded, tabManager, isDestroyed: () => destroyed, isClosed: () => closed };
}

const closeEvent = (log: string[]) => ({ preventDefault: () => void log.push('prevent') });

const files = (...dirty: boolean[]): Tab[] =>
	dirty.map((isDirty, i) => ({ id: 'abc'[i], path: `/notes/${'abc'[i]}.md`, isDirty }));

/** A dialog answer the test settles by hand, to look at the window while it is up. */
function pendingAnswer() {
	let answer!: (value: boolean) => void;
	const promise = new Promise<boolean>((resolve) => (answer = resolve));
	return { promise, answer };
}

// Window close (issue #189): instead of one aggregate "you have N unsaved
// files" modal, the red close button walks the dirty tabs one at a time —
// activating each and showing the SAME unsaved-changes dialog a single tab
// close shows. Cancel stops the walk; the window stays open.
describe('the window close handler', () => {
	test('the aggregate unsaved-files modal is gone from the close handler', async () => {
		// Each dirty tab gets its own dialog, and none is discarded unasked: the
		// old discard path cleared every dirty flag and then closed.
		const w = stubWindow(files(true, true), {}, { b: false });
		await w.exit.handleCloseRequested(closeEvent(w.log));
		assert.deepEqual(w.log.filter((line) => line.startsWith('ask:')), ['ask:a', 'ask:b']);
		assert.equal(w.tabs.find((tab) => tab.id === 'b')?.isDirty, true, 'the cancelled tab keeps its edits');
		assert.equal(w.isClosed(), false);
	});

	test('closing the window still reviews unsaved tabs', async () => {
		const w = stubWindow(files(false, true));
		await w.exit.handleCloseRequested(closeEvent(w.log));
		assert.deepEqual(w.log.slice(0, 3), ['prevent', 'active:b', 'ask:b']);
		assert.equal(w.isClosed(), true);
	});

	test('the close is prevented synchronously before the walk starts', async () => {
		const w = stubWindow(files(true));
		await w.exit.handleCloseRequested(closeEvent(w.log));
		assert.ok(w.log.indexOf('prevent') !== -1 && w.log.indexOf('prevent') < w.log.indexOf('ask:a'), w.log.join(' '));
	});

	test('the window closes only after every dirty tab is resolved', async () => {
		const w = stubWindow(files(true, true));
		await w.exit.handleCloseRequested(closeEvent(w.log));
		assert.equal(w.log.at(-1), 'close-window:main', w.log.join(' '));
		assert.ok(w.log.indexOf('ask:b') < w.log.indexOf('close-window:main'));
	});

	test('a clean window is not held open', async () => {
		// The fence for the tests above: with nothing to review the native close
		// proceeds on its own, so nothing prevents it or re-triggers it.
		const w = stubWindow(files(false));
		await w.exit.handleCloseRequested(closeEvent(w.log));
		assert.equal(w.log.includes('prevent'), false);
		assert.equal(w.isClosed(), false);
	});

	test('a second close request cannot start a competing walk', async () => {
		const dialog = pendingAnswer();
		const w = stubWindow(files(true), {}, { a: dialog.promise });
		const first = w.exit.handleCloseRequested(closeEvent(w.log));
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(w.log, ['prevent', 'active:a', 'ask:a'], 'precondition: the first walk is showing its dialog');

		const second: string[] = [];
		const swallowed = await Promise.race([
			w.exit.handleCloseRequested(closeEvent(second)).then(() => true),
			new Promise((resolve) => setTimeout(() => resolve(false), 50)),
		]);
		assert.equal(swallowed, true, 'the second request returns at once instead of waiting on a dialog');
		assert.deepEqual(second, ['prevent'], 'the second request is swallowed');
		assert.equal(w.log.filter((line) => line === 'ask:a').length, 1, 'and asks nothing');

		// Cancelling releases the guard, so the next close walks again.
		dialog.answer(false);
		await first;
		await w.exit.handleCloseRequested(closeEvent(second));
		assert.equal(w.log.filter((line) => line === 'ask:a').length, 2);
	});

	test('the walk proceeds in strict tab-strip order', async () => {
		const tabs = files(false, true, true);
		const w = stubWindow(tabs);
		w.tabManager.setActive('c');
		await w.exit.settleForExit();
		assert.deepEqual(w.log.filter((line) => line.startsWith('ask:')), ['ask:b', 'ask:c']);
	});

	test('the close flow resolves dirty tabs before serializing window state', async () => {
		const w = stubWindow(files(true, true), { restoreStateOnReopen: true });
		await w.exit.settleForExit();
		assert.ok(w.log.indexOf('ask:b') < w.log.indexOf('persist'), w.log.join(' '));
	});

	test('with restore enabled resolved titled tabs stay open for the snapshot', async () => {
		const tabs = [...files(true), { id: 'u', path: '', isDirty: true }];
		const w = stubWindow(tabs, { restoreStateOnReopen: true });
		await w.exit.settleForExit();
		assert.deepEqual(w.tabs.map((tab) => tab.id), ['a'], 'the titled tab stays, the untitled one has nothing to restore');

		const off = stubWindow(files(true), { restoreStateOnReopen: false });
		await off.exit.settleForExit();
		assert.deepEqual(off.tabs, [], 'with restore off the review closes tabs one by one');
	});

	test('auto-save fast path silently saves titled tabs before the walk', async () => {
		const tabs = [...files(true), { id: 'u', path: '', isDirty: true }];
		const w = stubWindow(tabs, { autoSave: true });
		await w.exit.settleForExit();
		assert.deepEqual(
			w.log.filter((line) => line.startsWith('silent:') || line.startsWith('ask:')),
			['silent:a', 'ask:u'],
			'the titled tab is saved without a prompt; the untitled one needs the dialog',
		);
	});

});

// Hot exit ("Restore unsaved changes on launch"): the close keeps the dirty
// buffers in the backup instead of asking about them.
describe('hot exit keeps unsaved buffers', () => {
	function hotExitWindow(autoSave: boolean) {
		const kept: string[] = [];
		const w = stubWindow(files(true, false), { autoSave, persistOpenEditors: true }, {}, {
			isReady: () => true,
			keep: async () => {
				kept.push(w.tabs.filter((tab) => tab.isDirty).map((tab) => tab.id).join(','));
				return true;
			},
		});
		return { ...w, kept };
	}

	test('with auto-save off, the dirty buffer is kept and its file is not written', async () => {
		// Auto-save off means the reader decides when a file is written. Closing
		// the window is not that decision: the buffer goes to the backup, and the
		// file on disk stays as it was.
		const w = hotExitWindow(false);
		await w.exit.handleCloseRequested(closeEvent(w.log));
		assert.deepEqual(w.log.filter((line) => line.startsWith('silent:')), [], 'nothing is saved to disk');
		assert.deepEqual(w.kept, ['a'], 'the dirty buffer is in the backup');
		assert.equal(w.log.some((line) => line.startsWith('ask:')), false, 'and nothing is asked');
		assert.ok(w.log.includes('persist'));
	});

	test('with auto-save on, pending saves write their files before the backup', async () => {
		const w = hotExitWindow(true);
		await w.exit.handleCloseRequested(closeEvent(w.log));
		assert.deepEqual(w.log.filter((line) => line.startsWith('silent:')), ['silent:a']);
		assert.deepEqual(w.kept, [''], 'the backup is written after the save, with nothing left dirty');
	});
});

