import { t } from '../utils/i18n.js';
import { settings } from './settings.svelte.js';
import { hasRealFilePath } from '../utils/tabFileActions.js';
import { basename, canonicalizePath, isSameFilePath } from '../utils/pathIdentity.js';
import type { RecoveredDocument } from '../sessions/unsavedRecovery.js';

/** The tab is on a path a command line named, and has yet to create the file there. */
export function createsItsFile(tab: Pick<Tab, 'path' | 'createsFile'>): boolean {
	return tab.createsFile === tab.path;
}

export interface Tab {
	id: string;
	path: string;
	/** Last segment of `path`, or the untitled name when there is no path. */
	title: string;
	/** The buffer: what the editor shows and what a save writes. */
	rawContent: string;
	/** What the file held when it was last read or written; the buffer differs from it when unsaved. */
	originalContent: string;
	/** Set when a command line named a path that does not exist yet: the file is created on first save. */
	createsFile?: string;
	readonly isDirty: boolean;
	/** The bytes did not decode cleanly, so a save would rewrite them as U+FFFD. */
	hasReplacementChars: boolean;
	encoding: string;
	/** The file's identity from the filesystem, which a path string cannot give (case, normalization). */
	pathKey?: string;
}

type TabFields = Pick<Tab, 'id' | 'path' | 'title' | 'hasReplacementChars' | 'encoding'> &
	Partial<Pick<Tab, 'rawContent' | 'pathKey'>>;

function makeTab(fields: TabFields): Tab {
	const rawContent = fields.rawContent ?? '';
	return {
		rawContent,
		originalContent: rawContent,
		get isDirty() {
			return this.rawContent !== this.originalContent;
		},
		...fields,
	};
}

class TabManager {
	tabs = $state<Tab[]>([]);
	activeTabId = $state<string | null>(null);
	get activeTab() {
		return this.tabs.find((t) => t.id === this.activeTabId);
	}

	private tab(id: string) {
		return this.tabs.find((t) => t.id === id);
	}

	/**
	 * The window's state: which file is open. Document content always lives on
	 * disk, so the snapshot never carries it: unsaved changes are handled by the
	 * close dialogs and the recovery backup, never smuggled through here. An
	 * untitled buffer has no disk backing and is resolved at close.
	 */
	serializeState(extra: Record<string, unknown> = {}): string {
		return JSON.stringify({
			version: 2,
			...extra,
			activeTabId: this.activeTabId,
			// A tab still to create its file, untouched, has nothing to restore:
			// the next launch would only fail to read it.
			tabs: this.tabs
				.filter((tab) => hasRealFilePath(tab.path) && !(createsItsFile(tab) && !tab.isDirty))
				.map((tab) => ({ id: tab.id, path: tab.path, title: tab.title })),
		});
	}

	restoreState(jsonBuffer: string) {
		try {
			const data = JSON.parse(jsonBuffer);
			if (!data || !Array.isArray(data.tabs)) return;
			const restored: Tab[] = [];
			for (const saved of data.tabs) {
				if (!saved || typeof saved.path !== 'string' || !hasRealFilePath(saved.path)) continue;
				restored.push(
					makeTab({
						id: typeof saved.id === 'string' ? saved.id : crypto.randomUUID(),
						path: saved.path,
						title: typeof saved.title === 'string' && saved.title !== '' ? saved.title : basename(saved.path) || saved.path,
						hasReplacementChars: false,
						encoding: 'UTF-8',
					}),
				);
			}

			this.tabs = restored;
			this.activeTabId = restored.some((tab) => tab.id === data.activeTabId)
				? data.activeTabId
				: restored[0]?.id ?? null;
			// Snapshots store paths as they were typed, and the restore reads each
			// file directly, so nothing else would resolve these identities.
			for (const tab of restored) {
				void canonicalizePath(tab.path).then((key) => this.setTabPathKey(tab.id, tab.path, key));
			}
		} catch (e) {
			console.error('Failed to restore tab state', e);
		}
	}

	/** A path belongs to one document: anything else on it is closed, or kept unsaved without it. */
	private claimPath(path: string, claimantId: string, pathKey?: string) {
		if (!hasRealFilePath(path)) return;
		const incoming = { path, pathKey };
		for (const other of this.tabs.filter((tab) => tab.id !== claimantId && isSameFilePath(tab, incoming))) {
			if (!other.isDirty) {
				this.closeTab(other.id);
				continue;
			}
			// The buffer no longer claims a file, and must not keep its identity
			// either. The title still names where it came from, which is the default
			// filename `saveContent` offers.
			other.path = '';
			other.pathKey = undefined;
		}
	}

	/**
	 * Opens `path` as the window's document. Opening a file that is already open
	 * returns that tab and ignores `rawContent`: it may hold unsaved edits a
	 * freshly read copy would erase.
	 */
	addTab(path: string, rawContent: string = '', pathKey?: string, activate = true): string {
		if (hasRealFilePath(path)) {
			const existing = this.tabs.find((tab) => isSameFilePath(tab, { path, pathKey }));
			if (existing) {
				if (activate) this.activeTabId = existing.id;
				return existing.id;
			}
		}

		// A window holds one document: the caller has already settled the one
		// being replaced (saved it, or been told to discard it).
		this.tabs = [];

		const id = crypto.randomUUID();
		this.tabs.push(
			makeTab({
				id,
				path,
				title: basename(path) || t('tabs.untitled', settings.language),
				rawContent,
				hasReplacementChars: false,
				encoding: 'UTF-8',
				pathKey,
			}),
		);

		if (activate) this.activeTabId = id;
		return id;
	}

	addNewTab() {
		const id = crypto.randomUUID();
		this.tabs = [
			makeTab({
				id,
				path: '',
				title: t('tabs.untitled', settings.language),
				hasReplacementChars: false,
				encoding: 'UTF-8',
			}),
		];
		this.activeTabId = id;
	}

	/** Puts a backed-up document back as the window's only one, unsaved buffer and all. */
	restoreDocument(document: RecoveredDocument) {
		const id = crypto.randomUUID();
		this.tabs = [makeTab({ id, ...document })];
		this.activeTabId = id;
		if (hasRealFilePath(document.path)) {
			void canonicalizePath(document.path).then((key) => this.setTabPathKey(id, document.path, key));
		}
	}

	closeTab(id: string) {
		const index = this.tabs.findIndex((tab) => tab.id === id);
		if (index === -1) return;
		if (this.activeTabId === id) {
			const fallback = this.tabs[index + 1] || this.tabs[index - 1];
			this.activeTabId = fallback ? fallback.id : null;
		}
		this.tabs.splice(index, 1);
	}

	setActive(id: string) {
		this.activeTabId = id;
	}

	updateTabRawContent(id: string, raw: string) {
		const tab = this.tab(id);
		if (tab) tab.rawContent = raw;
	}

	/**
	 * Replace a tab's buffer with what was just read from disk: the new text
	 * becomes both the buffer and the saved baseline, so the tab is clean.
	 */
	setTabRawContent(id: string, raw: string) {
		const tab = this.tab(id);
		if (tab) {
			tab.rawContent = raw;
			tab.originalContent = raw;
		}
	}

	/**
	 * Record whether this buffer came from a lossy decode. Set on every load,
	 * both ways: a file the user has since converted to UTF-8 must clear the
	 * flag, and Save As clears it once the buffer has a UTF-8 file of its own.
	 */
	setTabDecodedLossy(id: string, lossy: boolean) {
		const tab = this.tab(id);
		if (tab) tab.hasReplacementChars = lossy;
	}

	/**
	 * Record which encoding this buffer was decoded from, so the save writes
	 * the file back as itself. Set by the same reads that set the flag above,
	 * and for the same reason: it is a property of the buffer in hand, not a
	 * memory of how the tab was first opened — a file converted to UTF-8 since
	 * the load must stop being written as GBK.
	 *
	 * Separate from `setTabDecodedLossy` rather than an argument to it: they
	 * answer different questions ("could this be read?" and "what was it read
	 * as?"), and every caller that has one has the other, so folding them
	 * together would buy a line and cost the name.
	 */
	setTabEncoding(id: string, encoding: string) {
		const tab = this.tab(id);
		if (tab) tab.encoding = encoding;
	}

	/**
	 * Record the filesystem's answer for a tab whose path arrived through a
	 * route that could not resolve it — back/forward, a link opened in a new
	 * tab, a cross-window move, a restored window. `loadMarkdown` reads the
	 * file anyway, so it resolves the path in the same breath and reports it
	 * here, which is what turns those tabs from "unresolved, compared
	 * literally" into full participants in the one-tab-per-file rule.
	 *
	 * Guarded on the path still matching: the tab may have been navigated
	 * elsewhere while the resolution was in flight, and a key describing a file
	 * the tab no longer holds is worse than no key at all.
	 *
	 * The claim is made again here, now with the key. Those routes claim the
	 * path literally, so `C:/n/b.md` arriving beside a tab on `C:\n\b.md` (or
	 * `readme.md` beside `Readme.md` on macOS, or a symlink beside its target)
	 * passes as a different file, and two tabs would keep two auto-save timers
	 * on one file. Every one of them learns its identity through this method, so
	 * this is the one place that can settle it for all of them.
	 */
	setTabPathKey(id: string, path: string, pathKey: string) {
		const tab = this.tab(id);
		if (!tab || tab.path !== path) return;
		tab.pathKey = pathKey;
		this.claimPath(path, id, pathKey);
	}


	/** Save As, rename on disk, or an untitled tab picking up the file it loads. */
	updateTabPath(id: string, path: string, pathKey?: string) {
		const tab = this.tab(id);
		if (tab) {
			// Save As can name a file that is already open here; the write has
			// happened by the time this runs, so the other tab's buffer is
			// already stale and must stop claiming the path.
			this.claimPath(path, id, pathKey);
			tab.path = path;
			// The old key described the old name (rename) or nothing (an untitled
			// buffer), so keeping it would make this tab answer "same file" for a
			// file it no longer holds. Unset is the honest state until something
			// resolves the new path.
			tab.pathKey = pathKey;
			tab.title = basename(path) || 'Untitled';
			// The buffer is not touched here, so nothing about "changed?" changes
			// either. Clearing the dirty flag here would mark as saved a keystroke
			// that lands during a save's write: the saving callers set
			// `originalContent` to the text they wrote themselves, a rename leaves
			// the buffer as it was, and `loadMarkdown` repoints an untitled, empty,
			// already-clean tab at the file it is about to load.
		}
	}


}

export const tabManager = new TabManager();
