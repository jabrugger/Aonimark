import { commands } from '../bindings.js';

import { reviewDirtyTabs } from './closeReview.js';

type ExitTab = { id: string; path: string; isDirty: boolean };

export type WindowExitOptions = {
	tabManager: {
		readonly tabs: ExitTab[];
		closeTab: (id: string) => void;
		setActive: (id: string) => void;
	};
	settings: {
		readonly autoSave: boolean;
		readonly restoreStateOnReopen: boolean;
		readonly persistOpenEditors: boolean;
	};
	appWindow: { readonly label: string; close: () => Promise<void>; destroy: () => Promise<void> };
	/** The unsaved-change backup: whether it was restored, and its two writes. */
	recovery: {
		isReady: () => boolean;
		/** Write the current buffers. False when the backup could not be written. */
		keep: () => Promise<boolean>;
		/** Write an empty backup, so a discarded buffer stays gone. */
		drop: () => Promise<boolean>;
	};
	persistWindowState: () => Promise<void>;
	canCloseTab: (id: string) => Promise<boolean>;
	saveSilently: (id: string) => Promise<boolean>;
	hasExternalChangeConflict: (id: string) => boolean;
	onAutoSaveFailed: () => void;
	/** Let an activation paint before a dialog covers it — `tick()` in the app. */
	settle: () => Promise<void>;
};

/**
 * Every way a window ends: the red button, quit, the in-app update, the last
 * tab's ×, and a merge into another window. Each one resolves unsaved tabs,
 * saves a pinned tag's files and writes the window snapshot, in that order.
 */
export function createWindowExit(options: WindowExitOptions) {
	const { tabManager, settings, appWindow } = options;

	// True while the window-close walk is showing per-tab dialogs; the native
	// red button is not blocked by the dialog overlay, so this keeps a second
	// close request from starting a competing walk.
	let closeWalkActive = false;

	/**
	 * Hot exit: keep unsaved buffers instead of asking. Pending auto-saves write
	 * their files first; a refused or failed save stays dirty and is kept. False
	 * when the backup cannot be written or `applies` says no, and the caller asks
	 * as usual. `applies` runs inside the walk guard, so a second close is refused meanwhile.
	 */
	async function keepUnsavedForExit(applies = async () => true): Promise<boolean> {
		if (!options.recovery.isReady()) return false;
		closeWalkActive = true;
		try {
			if (!(await applies())) return false;
			if (settings.autoSave) {
				for (const tab of tabManager.tabs.filter((t) => t.isDirty && t.path !== '')) await options.saveSilently(tab.id);
			}
			if (!(await options.recovery.keep())) return false;
		} finally {
			closeWalkActive = false;
		}
		await options.persistWindowState();
		return true;
	}

	/**
	 * The save/discard close, used when "Restore unsaved changes on launch" is off, when
	 * closing one of several windows, or when the backup cannot be written
	 * (`keepUnsavedForExit` runs first otherwise).
	 * Resolve this window's unsaved tabs, then write the restore snapshot: the
	 * work that has to happen before the window goes away. False when the reader
	 * cancelled, and nothing has been written.
	 *
	 * The close button and the in-app update both run it. An update ends the
	 * process without closing a window — the Windows updater exits inside
	 * `downloadAndInstall`, `relaunch()` requests an exit elsewhere — so
	 * CloseRequested never fires, and both jobs used to go down with it (#761).
	 */
	async function settleForExit(): Promise<boolean> {
		// Unsaved content and session restore are separate concerns: dirty tabs
		// are resolved FIRST through the per-tab dialogs, then the restore
		// snapshot records window state only (open files, active tab, edit mode,
		// split, scroll) — it never carries document content.
		const dirtyTabs = tabManager.tabs.filter((t) => t.isDirty);
		if (dirtyTabs.length > 0) {
			closeWalkActive = true;
			// The walk's dialogs are in-app modals inside THIS window: with
			// multiple windows, another window may be covering it and the review
			// would be invisible. Bring the reviewing window to the front first.
			commands.showWindow().catch(console.error);
			try {
				// Auto-save without confirmation: silently save every dirty tab
				// that has a real path. Untitled tabs need a Save dialog, so the
				// walk below handles them. A failed silent save is surfaced and its
				// tab also goes to the walk. `saveContent` cancels each tab's pending
				// timer itself, so no writer here can be raced by its own debounce.
				// A tab whose file changed underneath is refused rather than
				// overwritten, and the walk asks the changed-on-disk question.
				if (settings.autoSave) {
					for (const tab of dirtyTabs.filter((t) => t.path !== '')) {
						const ok = await options.saveSilently(tab.id);
						if (!ok && options.hasExternalChangeConflict(tab.id)) continue;
						if (!ok) {
							options.onAutoSaveFailed();
							break;
						}
					}
				}

				// Close review (issue #189): walk the remaining dirty tabs one at a
				// time — activate each and run the same localized unsaved-changes
				// dialog a single tab close shows. Cancel stops the walk and keeps
				// the window open. Strict tab-strip order (left to right) so the
				// sequence is predictable; numbered untitled titles let the dialog
				// name each tab. Re-find every round — a save can leave a tab dirty
				// again (TOCTOU) and tabs can change while a dialog is up.
				const resolved = await reviewDirtyTabs({
					nextDirtyTab: () => tabManager.tabs.find((t) => t.isDirty),
					setActive: (id) => tabManager.setActive(id),
					settle: options.settle,
					canCloseTab: options.canCloseTab,
					closeTab: (id) => tabManager.closeTab(id),
					// Resolved tabs (saved, or reverted by Don't Save) stay open for
					// the window-state snapshot when restore is enabled; untitled
					// tabs have nothing to restore, and with restore off the red
					// button closes tabs one by one.
					shouldCloseAfterResolving: (tab) => !settings.restoreStateOnReopen || tab.path === '',
				});
				if (!resolved) {
					return false;
				}
			} finally {
				closeWalkActive = false;
			}
		}

		// Session is clean now; record the window state for restore. Awaited:
		// the caller holds the exit until the Rust write returns, so the process
		// cannot exit under the snapshot.
		await options.persistWindowState();
		return true;
	}

	/**
	 * The update's settle. No re-triggered close follows it: the process exits,
	 * or the install fails and the window stays. Either way the review's list
	 * has been saved, and kept it would outlive a failed install into the next
	 * last-tab close, merge or Close Tag.
	 */
	async function settleForUpdate(): Promise<boolean> {
		if (settings.persistOpenEditors && (await keepUnsavedForExit())) return true;
		return settleForExit();
	}

	/** `appWindow.onCloseRequested`'s handler. */
	async function handleCloseRequested(event: { preventDefault: () => void }) {
		// The red button is a native control, so it is NOT blocked
		// by the in-app dialog overlay: a second click while the
		// walk below is showing a dialog would re-enter this handler
		// and start a competing walk whose setActive calls fight the
		// first one — the highlighted tab stops matching the dialog.
		// One walk at a time.
		if (closeWalkActive) {
			event.preventDefault();
			return;
		}

		// Hot exit on quit or when the app exits with this window: the
		// backup is written, nothing to ask, close proceeds. Closing one
		// of several windows asks below. Decided before `hadDirtyTabs`:
		// the buffers stay dirty, and a re-triggered close would only
		// find them again. If unsure, ask.
		if (settings.persistOpenEditors && (await keepUnsavedForExit())) return;

		// With tabs to review the close is held open while their
		// dialogs are up, then re-triggered: the handler re-enters,
		// finds nothing dirty, and the close proceeds.
		const hadDirtyTabs = tabManager.tabs.some((t) => t.isDirty);
		if (hadDirtyTabs) event.preventDefault();
		if (!(await settleForExit())) return;
		// Resolved: drop the backup, so a discarded buffer stays gone.
		if (options.recovery.isReady()) await options.recovery.drop();
		if (hadDirtyTabs) appWindow.close();
	}

	/** Quit is the red button: the close handler reviews unsaved changes and writes the session. */
	async function appExit() {
		await appWindow.close();
	}

	return {
		isCloseWalkActive: () => closeWalkActive,
		keepUnsavedForExit,
		settleForExit,
		settleForUpdate,
		handleCloseRequested,
		appExit,
	};
}
