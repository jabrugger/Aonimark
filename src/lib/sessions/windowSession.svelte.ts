import { commands } from '../bindings.js';
import { createBoundedWriter } from './unsavedRecovery.js';

type RestoredTab = {
	id: string;
	path: string;
};

type WindowSessionOptions = {
	serializeState: () => string;
	shouldRestoreState: () => boolean;
	isDisposed: () => boolean;
	restoreState: (json: string) => void;
	restoredTabs: () => RestoredTab[];
	/** Read a restored tab the way an open reads it. Never throws. */
	loadRestoredTab: (tabId: string) => Promise<void>;
	dropRestoredTab: (tabId: string) => void;
	onError: (message: string, error: unknown) => void;
	onWarning: (message: string, error?: unknown) => void;
	/**
	 * Called at startup when the previous launch died while reading `path`. The
	 * document is left closed rather than read again, so a file that kills the
	 * renderer cannot keep the app from starting.
	 */
	onInterrupted: (path: string) => void;
};

/**
 * Remembers which document the window had open, and reopens it at the next
 * launch. A breadcrumb names the document while it is being read: if it is
 * still there at startup, that read never finished, and the document is
 * skipped once instead of being read into the same crash.
 */
export function createWindowSession(options: WindowSessionOptions) {
	/**
	 * The snapshot is written as the window changes, not only at close, so a
	 * crash or kill brings the window back. Through a bounded, serialized
	 * writer: the last state wins, and a write still in flight cannot land after
	 * the window is forgotten.
	 */
	const snapshots = createBoundedWriter({
		write: (json) => commands.saveWindowState(json),
		// A background write that fails retries on its own; only the one a
		// close waits for is put in front of the user, by `persistState`.
		onError: (error) => options.onWarning('Failed to save window state', error),
	});
	// Off until this window's own restore has run, so its empty starting state
	// never replaces the snapshot it is about to read.
	let recording = false;

	/** Record the window's state within the writer's bounded delay. */
	function record(json: string) {
		if (recording && options.shouldRestoreState()) snapshots.update(json);
	}

	/** Record the state at a moment no tab switch is under way: focus loss or hide. */
	function checkpoint() {
		if (recording && options.shouldRestoreState()) snapshots.update(options.serializeState());
	}

	async function discardPersistedState() {
		try {
			await commands.clearWindowState();
		} catch (error) {
			options.onError('Failed to clear window state', error);
		}
	}

	/**
	 * The breadcrumb goes through Rust, like the snapshot: it exists to survive
	 * an abnormal termination, which is the event that loses messages still in
	 * flight to the webview's own storage.
	 */
	async function setBreadcrumb(path: string | null) {
		try {
			if (path) await commands.saveRestoreProgress(path);
			else await commands.clearRestoreProgress();
		} catch (error) {
			options.onWarning('Failed to record session restore progress', error);
		}
	}

	async function persistState() {
		if (!(await snapshots.flush(options.serializeState()))) {
			options.onError('Failed to save window state on close', 'the write was refused');
		}
	}

	/** Restores this window's snapshot. True when it had one. */
	async function restore(): Promise<boolean> {
		if (options.isDisposed()) return false;
		if (!options.shouldRestoreState()) {
			// Turning the setting off ends the session: the list of what was open
			// must not stay on disk for the user who switched it off to stop that.
			await discardPersistedState();
			await setBreadcrumb(null);
			recording = true;
			return false;
		}

		const interrupted = await commands.loadRestoreProgress().catch(() => null);
		const savedData = await commands.loadWindowState().catch(() => null);
		if (savedData) {
			try {
				options.restoreState(savedData);
				const [tab] = options.restoredTabs();
				if (tab && interrupted === tab.path) {
					options.onWarning(`Session restore was interrupted while reading ${tab.path}; skipping it`);
					options.onInterrupted(tab.path);
					options.dropRestoredTab(tab.id);
				} else if (tab) {
					// Awaited: the breadcrumb has to be on disk before the read it
					// describes starts, or the launch that read kills leaves nothing.
					await setBreadcrumb(tab.path);
					if (!options.isDisposed()) await options.loadRestoredTab(tab.id);
				}
			} catch (error) {
				options.onError('Failed to restore session', error);
			}
		}
		// Reached however the read ended; only a process that dies mid-read skips it.
		await setBreadcrumb(null);
		if (options.isDisposed()) return Boolean(savedData);
		// The snapshot is written from here on, an empty one included.
		recording = true;
		await persistState();
		return Boolean(savedData);
	}

	return { discardPersistedState, persistState, record, checkpoint, restore };
}
