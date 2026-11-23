import assert from 'node:assert/strict';
import { describe, test } from 'node:test';


import { createBoundedWriter, parseRecovery, recoverySnapshot, restoreRecords } from '../src/lib/sessions/unsavedRecovery.js';
import type { Tab } from '../src/lib/stores/tabs.svelte.js';
import { autoSaveFailureNeedsToast, isAutoSaveEligible, type AutoSaveTabState } from '../src/lib/utils/autoSaveTimer.js';
import { t } from '../src/lib/utils/i18n.js';
import { MARKDOWN_OPEN_FILTERS } from '../src/lib/utils/markdownLinks.js';
import { dispatchViewerKey, viewerCommandFor, type KeyContext } from '../src/lib/utils/viewerKeymap.js';
import { translations } from './allTranslations.js';
import { readSource } from './sourceTree.js';
import { MARKDOWN_LINK_EXTENSIONS } from '../src/lib/utils/markdownLinks.js';


/*
 * #168, reported by @dayeggpi: with a document that was never saved, Ctrl+S in
 * reading mode did nothing at all. `toggleEdit` only runs its save/confirm flow
 * for tabs that already have a path, so an untitled buffer switches to reading
 * mode still dirty — and then the one shortcut that could rescue it was
 * suppressed.
 *
 * Every assertion here used to read the component's source through
 * `sliceBetween(viewer, "if (mod && key === 's') {", "if (modShift && key ===
 * 't')")` — a slice whose start anchor was the branch condition itself and
 * whose end anchor was the NEXT branch, so it moved when either was rewritten
 * and said nothing about what Ctrl+S does. Lifting the dispatcher out split the
 * two halves apart, and each is now checked where it lives: which chord means
 * `'save'` is a function call, and what `'save'` does is the component's, read
 * from its command table.
 */
describe('save from reading mode', () => {
	/** Reading a saved document, the state the report was made in. */
	const READING: KeyContext = {
		mode: 'app',
		osType: 'windows',
		
		overlayOpen: false,
		dialogOpen: false,
		
		
	};

	/** Mod+S, with no other modifier. */
	const MOD_S = { key: 's', code: 'KeyS', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };

	test('Ctrl+S is not gated on the editor being visible', () => {
		// The defect was a `if (isEditing || isSplit)` around the branch. Asked as a
		// question rather than matched as text: all four combinations of the two
		// flags must answer `'save'`, so no guard over either of them can come back
		// without failing here.
		assert.equal(viewerCommandFor(MOD_S, READING), 'save');
	});

	test('the browser save dialog is always suppressed', () => {
		// Reading mode would otherwise surface the webview's own Save Page dialog.
		// The keystroke is prevented before the command runs, in every mode.
		const events: string[] = [];
		const stroke = { ...MOD_S, preventDefault: () => void events.push('prevented') };
		dispatchViewerKey(stroke, READING, (command) => void events.push(`run:${command}`));
		assert.deepEqual(events, ['prevented', 'run:save']);

		// A chord that means nothing keeps its default.
		const noEvents: string[] = [];
		const other = { ...MOD_S, key: 'j', code: 'KeyJ', ctrlKey: false, preventDefault: () => void noEvents.push('prevented') };
		dispatchViewerKey(other, READING, (command) => void noEvents.push(`run:${command}`));
		assert.deepEqual(noEvents, []);
	});
});

describe('auto-save debounce', () => {
	/** A dirty file in the editor, the state the timer exists for. */
	const EDITING: AutoSaveTabState = {
		id: 'a', path: '/notes/a.md', isDirty: true, editable: true, hasPendingConflict: false, decodedLossily: false,
	};
	const never = () => false;
	const always = () => true;

	test('the debounced auto-save is held back while a conflict is unanswered', () => {
		// Otherwise the 1.5s timer fires while the bar is still asking "reload or
		// keep mine": the user's edits survive, but the external change is gone
		// from disk before either answer can be given.
		assert.equal(isAutoSaveEligible(EDITING, never), true);
		assert.equal(isAutoSaveEligible({ ...EDITING, hasPendingConflict: true }, never), false);
	});

	test('a tab that can only be refused stops re-arming the timer', () => {
		// Auto-save re-arms on every keystroke. Without this the guard was reached
		// again every 1.5s for as long as the user kept typing.
		const lossy = { ...EDITING, decodedLossily: true };
		// The FIRST attempt still happens: it is what produces the explanation.
		assert.equal(isAutoSaveEligible(lossy, never), true);
		assert.equal(isAutoSaveEligible(lossy, always), false);
		// "Save As" to a new file clears the lossy flag, which restores it.
		assert.equal(isAutoSaveEligible(EDITING, always), true);
	});

	test('a refused save does not add a generic toast to its own explanation', () => {
		assert.equal(autoSaveFailureNeedsToast('a', { isLossySaveRefused: always, hasExternalChangeConflict: never }), false);
		assert.equal(autoSaveFailureNeedsToast('a', { isLossySaveRefused: never, hasExternalChangeConflict: always }), false);
		// A genuine write failure still says so.
		assert.equal(autoSaveFailureNeedsToast('a', { isLossySaveRefused: never, hasExternalChangeConflict: never }), true);
	});
});


describe('the Open dialog', () => {
	test('the Open dialog offers every extension Markpad treats as a document', () => {
		// Markpad opens, renders and saves `.txt` like any other note (#535); a
		// shorter list hid those files behind "All Files".
		const [markdown, all] = MARKDOWN_OPEN_FILTERS;
		assert.deepEqual([...markdown.extensions].sort(), ['markdown', 'md', 'mdown', 'mkd', 'txt']);
		assert.deepEqual(all.extensions, ['*']);
	});
});

// Config and dictionary data: tauri.conf.json is parsed, locales are imported.

/** Every value stored under `key` anywhere in a dictionary. */
function valuesOf(dictionary: unknown, key: string): unknown[] {
	if (!dictionary || typeof dictionary !== 'object') return [];
	return Object.entries(dictionary).flatMap(([k, v]) => [...(k === key ? [v] : []), ...valuesOf(v, key)]);
}

describe('file associations', () => {
	const config = JSON.parse(readSource('src-tauri/tauri.conf.json')) as {
		bundle: {
			fileAssociations: Array<{ ext: string[]; contentTypes?: string[]; mimeType?: string; name: string }>;
		};
	};

	// Every extension Markpad treats as a Markdown document is associated, except
	// `.txt`: claiming it takes the Text Document association away from Notepad
	// (#179). An extension added to either list fails here until the other follows.
	test('installer associates every Markdown extension except txt', () => {
		const extensions = config.bundle.fileAssociations.flatMap((association) => association.ext);
		assert.deepEqual(
			extensions,
			MARKDOWN_LINK_EXTENSIONS.filter((ext) => ext !== 'txt'),
		);
	});

	// macOS ignores `ext` once an association has a content type, and its
	// Markdown type (net.daringfireball.markdown, owned by the system) only tags
	// .md and .markdown. Any other extension must sit in an association with no
	// content type or MIME type, or it gets a dynamic UTI that no association
	// claims and Markpad drops out of Finder's Open With. One name keeps a single
	// Windows ProgID, which hooks.nsi registers under.
	test('macOS claims extensions outside the system Markdown type by extension', () => {
		for (const association of config.bundle.fileAssociations) {
			if (association.contentTypes) {
				assert.deepEqual(association.ext, ['md', 'markdown']);
			} else {
				assert.equal(association.mimeType, undefined);
			}
			assert.equal(association.name, 'Markdown File');
		}
	});
});

describe('encoding refusals in every language', () => {
	test('no locale still translates a hardcoded UTF-8 label', () => {
		// A dead key reads like a supported feature to whoever finds it next.
		for (const [code, dictionary] of Object.entries(translations)) {
			assert.deepEqual(valuesOf(dictionary, 'utf8'), [], `${code} still has a utf8 key`);
		}
	});

	test('every locale can say which encoding refused the save', () => {
		const having = (key: string) =>
			Object.entries(translations)
				.filter(([, dictionary]) => valuesOf(dictionary, key).length > 0)
				.map(([code]) => code);
		const languages = having('lossySaveBlocked');
		assert.ok(languages.length >= 5, 'precondition: the sibling refusal is translated');
		assert.deepEqual(having('encodingUnmappable'), languages, 'both refusals reach the same languages');
		for (const code of languages) {
			const [message] = valuesOf(translations[code as keyof typeof translations], 'encodingUnmappable');
			// The encoding is named, not implied: "some characters cannot be saved"
			// leaves the user with nothing to search for.
			assert.match(String(message), /\{\{encoding\}\}/, `${code} does not name the encoding`);
		}
	});

	test('the refusal names Save As, the only exit', () => {
		// That the session raises this message once per tab is driven in
		// documents.session.spec.ts.
		const [message] = valuesOf(translations.en, 'lossySaveBlocked');
		assert.match(String(message), /^Not saved: parts of this file could not be read in any encoding/);
		assert.match(String(message), /use "Save As" to write a copy/);
	});
});
