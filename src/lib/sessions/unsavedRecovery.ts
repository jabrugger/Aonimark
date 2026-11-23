import type { Tab } from '../stores/tabs.svelte.js';

/** What a backup keeps of a document: enough to put its unsaved buffer back. */
export type RecoveredDocument = Pick<Tab, 'path' | 'title' | 'rawContent' | 'originalContent' | 'hasReplacementChars' | 'encoding'> & {
	isTruncated?: boolean;
};

const STRING_FIELDS = ['path', 'title', 'rawContent', 'originalContent', 'encoding'] as const;

/** Only what a close would otherwise ask about: a dirty buffer, or untitled text.
 * A clean file reopens from disk through the session restore. A partial read
 * carries its guard so it never restores as a complete document. */
export function recoverySnapshot(tabs: readonly Tab[]): string {
	return JSON.stringify(tabs
		.filter((tab) => tab.isDirty || (tab.path === '' && tab.rawContent !== ''))
		.map((tab): RecoveredDocument => ({
			path: tab.path,
			title: tab.title,
			rawContent: tab.rawContent,
			originalContent: tab.originalContent,
			hasReplacementChars: tab.hasReplacementChars,
			encoding: tab.encoding,
			...(tab.isTruncated ? { isTruncated: true } : {}),
		})));
}

export function parseRecovery(json: string): RecoveredDocument[] {
	const value: unknown = JSON.parse(json);
	if (!Array.isArray(value)) throw new Error('Invalid recovery snapshot');
	return value.map((entry) => {
		const valid =
			typeof entry === 'object' &&
			entry !== null &&
			STRING_FIELDS.every((field) => typeof entry[field] === 'string') &&
			typeof entry.hasReplacementChars === 'boolean' &&
			(entry.isTruncated === undefined || typeof entry.isTruncated === 'boolean');
		if (!valid) throw new Error('Invalid recovery document');
		return {
			path: entry.path,
			title: entry.title,
			rawContent: entry.rawContent,
			originalContent: entry.originalContent,
			hasReplacementChars: entry.hasReplacementChars,
			encoding: entry.encoding,
			...(entry.isTruncated ? { isTruncated: true } : {}),
		};
	});
}

type RecoveryTarget = {
	tabs: Tab[];
	restoreDocument: (document: RecoveredDocument) => void;
};

/** A window holds one document, so a backup only goes back over a clean one; two
 * unsaved buffers are never merged. The saved baseline travels too, so a save
 * still meets the external-change check. Returns whether it was restored. */
function restoreRecoveryTabs(manager: RecoveryTarget, json: string): boolean {
	// Validate the entire record before changing anything.
	const documents = parseRecovery(json);
	if (manager.tabs.some((tab) => tab.isDirty)) return false;
	const [document] = documents;
	if (document) manager.restoreDocument(document);
	return true;
}

/** Restore the given records and return the other labels consumed.
 * A corrupt record of another window is reported and left on disk. A corrupt
 * record of this window throws: the caller must not overwrite it. */
export function restoreRecords(
	manager: RecoveryTarget,
	records: readonly [string, string][],
	ownLabel: string,
	onError: (error: unknown) => void,
): string[] {
	const consumed: string[] = [];
	for (const [label, json] of records) {
		try {
			if (!restoreRecoveryTabs(manager, json)) continue;
		} catch (error) {
			if (label === ownLabel) throw error;
			onError(error);
			continue;
		}
		// This window's own record is replaced by its next write, not removed.
		if (label !== ownLabel) consumed.push(label);
	}
	return consumed;
}

/** One writer per file: a window's unsaved backup, or its restore snapshot. A
 * bounded delay, not a resetting debounce: continuous typing must still reach
 * disk. Serialized writes prevent an older IPC from resurrecting content after
 * a save, discard, or setting change. `initial` is what is on disk already, so
 * it is not written again. `update(() => json)` only marks the file stale: the
 * snapshot is built when the delayed write fires or on flush, not per keystroke. */
export function createBoundedWriter(options: {
	write: (json: string) => Promise<unknown>;
	onError: (error: unknown) => void;
	initial?: string;
}) {
	let latest = options.initial ?? '';
	let stale: (() => string) | undefined;
	let retryDue = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let writes = Promise.resolve(true);
	let disposed = false;

	function schedule(delay: number) {
		if (timer || disposed) return;
		timer = setTimeout(() => {
			timer = undefined;
			if (stale) {
				const json = stale();
				stale = undefined;
				if (json === latest && !retryDue) return;
				latest = json;
			}
			retryDue = false;
			void enqueue(latest);
		}, delay);
	}

	function enqueue(json: string): Promise<boolean> {
		writes = writes.then(async () => {
			try {
				await options.write(json);
				return true;
			} catch (error) {
				options.onError(error);
				// Retry even if the user stopped typing, including failed cleanup.
				if (json === latest) {
					retryDue = true;
					schedule(2000);
				}
				return false;
			}
		});
		return writes;
	}

	function update(json: string | (() => string)) {
		if (disposed) return;
		if (typeof json === 'function') {
			stale = json;
			return schedule(500);
		}
		stale = undefined;
		if (json === latest) return;
		latest = json;
		schedule(500);
	}

	function flush(json?: string): Promise<boolean> {
		if (timer) clearTimeout(timer);
		timer = undefined;
		latest = json ?? stale?.() ?? latest;
		stale = undefined;
		return enqueue(latest);
	}

	/** Stops writing. Resolves once a write already under way has landed, so
	 * the caller can remove the file without it coming back. */
	function dispose(): Promise<boolean> {
		disposed = true;
		if (timer) clearTimeout(timer);
		return writes;
	}

	return { update, flush, dispose };
}
