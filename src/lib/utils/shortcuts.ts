/**
 * The keyboard shortcuts the app advertises, in one place.
 *
 * WHY THIS FILE EXISTS
 *
 * "What is the shortcut for X" used to be answered in three places that nothing
 * held together: `editorToolbar.ts` (the button tooltip), `TitleBar.svelte`
 * (fourteen hard-coded literals in markup) and the handlers themselves
 * (`editor.addAction` keybindings in `Editor.svelte`, the document-level
 * `keydown` branch in `MarkdownViewer.svelte`). Only the first was ever tested,
 * and only since #480. A shortcuts panel that carried its own list would have
 * been a fourth copy — and the one users would trust most.
 *
 * So this is the single copy the display layers read, and
 * `scripts/shortcuts.test.ts` ties it to the handlers: every chord below
 * is fired at the real code and has to run the command it is labelled with.
 * The registry is not a source of truth about behaviour — the handlers are —
 * it is a claim about them that a test refuses to let drift.
 */

/**
 * Which menu the command would live under. Four of the five labels are the
 * existing menu-bar categories, so grouping the panel cost no new translations.
 *
 * `keys` is the fifth and is not a menu. Enter, Tab, Shift+Tab and the two
 * Mod+Enter keys do different things depending on what the caret is sitting on —
 * continue a list, move to the next table cell, add a table row — and a
 * behaviour attached to a CONTEXT rather than to a command has no menu entry to
 * live under and no command name to be listed as.
 * It was invisible in the app until this group existed: #636 shipped list
 * continuation and nothing anywhere told a user it was there.
 */
import type { ViewerCommand } from './viewerKeymap.js';
import type { TranslationKey } from './i18n.js';

type ShortcutGroup = 'file' | 'view' | 'window';

/** Display order of the groups, and the i18n key that titles each one. */
export const SHORTCUT_GROUPS: ReadonlyArray<{ group: ShortcutGroup; labelKey: TranslationKey }> = [
	{ group: 'file', labelKey: 'menu.file' },
	{ group: 'view', labelKey: 'menu.view' },
	{ group: 'window', labelKey: 'menu.window' },
];

/** The platforms the app distinguishes, spelled the way `settings.osType` does. */
type ShortcutPlatform = 'macos' | 'windows' | 'linux';

export type ShortcutEntry = {
	/**
	 * Stable id. Where `editorAction` is true this IS the Monaco action id, which
	 * is also the toolbar tool id — that is what lets one row serve the panel and
	 * the toolbar tooltip at once.
	 */
	readonly id: string;
	/**
	 * An i18n key that already exists and is already translated. New user-visible
	 * strings were deliberately not minted for the command names: every one of
	 * these labels was already in the dictionary for a menu entry or a context
	 * menu, in all 26 locales.
	 */
	readonly labelKey: TranslationKey;
	/** The label on macOS, where the app menu names the command differently. */
	readonly macosLabelKey?: TranslationKey;
	/** A note on where the chord works, for a command that is not everywhere. */
	readonly hintKey?: TranslationKey;
	/**
	 * The chords, most-advertised first. Written in the spelling the CODE uses,
	 * which is not always the spelling a user reads: `Mod` renders as `Cmd` on
	 * macOS and `Ctrl` elsewhere, and `Alt` renders as `Opt` on macOS. A
	 * literal `Ctrl` stays `Ctrl` on every platform, which is what tab cycling
	 * actually binds.
	 *
	 * Consumers with room for one chord (the app menu, the toolbar tooltip) show
	 * `chords[0]`; the panel shows all of them.
	 */
	readonly chords: readonly string[];
	readonly group: ShortcutGroup;
	/**
	 * The command the document-level dispatcher means by this row's chords when
	 * the editor does not have focus.
	 *
	 * One entry means every chord in the row runs it (`file-new` binds both
	 * `Mod+T` and `Mod+N`); otherwise there is one per chord, in `chords` order.
	 *
	 * A `ViewerCommand` rather than a function name, now that the dispatcher has
	 * a module of its own: the compiler now rejects a row naming a
	 * command that does not exist, where the old free-text spellings
	 * (`showSettings=true`, `settings.previewMaxWidth=`, `toggleEdit` for a
	 * function called `toggleEditView`) were matched by prefix and could only be
	 * checked at runtime — and `tab-next` and `tab-prev` both said
	 * `tabManager.cycleTab`, so nothing could tell them apart.
	 */
	readonly documentCommands?: readonly ViewerCommand[];
	/**
	 * Platforms where the document handler deliberately stays out of the way.
	 * Only Quit uses this: on macOS the native menu owns `Cmd+Q` and the
	 * handler returns early, so the chord is real but answered somewhere else.
	 */
	readonly documentExempt?: readonly ShortcutPlatform[];
};

/**
 * Every user-visible shortcut, grouped for display.
 *
 * Each row is checked against the code that implements it. Adding a row without
 * a matching binding fails `scripts/shortcuts.test.ts`, which is the
 * whole point: the panel cannot advertise a chord the app does not answer.
 */
export const SHORTCUTS: readonly ShortcutEntry[] = [
	// ---------------------------------------------------------------- file
	{
		id: 'file-new',
		labelKey: 'menu.newFile',
		// Both are bound. `Mod+T` first because that is what the tab strip's `+`
		// button and the app menu have always printed.
		chords: ['Mod+T', 'Mod+N'],
		group: 'file',
		documentCommands: ['new-file'],
	},
	{
		id: 'file-open',
		labelKey: 'menu.openFile',
		chords: ['Mod+O'],
		group: 'file',
		documentCommands: ['open-file'],
	},
	{
		id: 'file-save',
		labelKey: 'menu.save',
		chords: ['Mod+S'],
		group: 'file',
		documentCommands: ['save'],
	},
	{
		id: 'file-save-as',
		labelKey: 'menu.saveAs',
		// The chord the app menu has always printed. It is bound for the first
		// time here: until now the save branch matched `cmdOrCtrl && key === 's'`
		// with no Shift guard, so the advertised keystroke ran a plain Save.
		chords: ['Mod+Shift+S'],
		group: 'file',
		documentCommands: ['save-as'],
	},
	{
		id: 'file-reload',
		labelKey: 'menu.reloadFromDisk',
		chords: ['F5'],
		group: 'file',
		documentCommands: ['reload-from-disk'],
	},
	{
		id: 'file-close',
		labelKey: 'menu.closeFile',
		chords: ['Mod+W'],
		group: 'file',
		documentCommands: ['close-file'],
	},
	{
		id: 'file-reveal',
		labelKey: 'menu.openFileLocation',
		chords: ['Mod+Shift+R'],
		group: 'file',
		documentCommands: ['reveal-file'],
	},
	{
		id: 'app-exit',
		labelKey: 'menu.exit',
		// The macOS app menu says "Quit Markpad"; Windows and Linux say "Exit".
		macosLabelKey: 'menu.quit',
		chords: ['Mod+Q'],
		group: 'file',
		documentCommands: ['app-exit'],
		// On macOS the document handler returns before this branch; the native
		// menu's Quit answers it.
		documentExempt: ['macos'],
	},

	// ---------------------------------------------------------------- view
	{
		id: 'view-toggle-live',
		labelKey: 'menu.autoReload',
		chords: ['Mod+L'],
		group: 'view',
		// Both halves, like Mod+E: Monaco's own Ctrl+L is `expandLineSelection`,
		// so the editor action is what stops the chord selecting a line, and the
		// document command is what makes it work in the preview, where there is
		// no Monaco to register anything on.
		documentCommands: ['toggle-live-mode'],
	},
	{
		id: 'toggle-zen-mode',
		labelKey: 'menu.zenMode',
		// Z for zen, at the third address this command has had. Mod+Shift+Z was
		// redo's only binding on macOS; Mod+Shift+D was free but sat in the same
		// Mod+Shift row the six formatting commands live in, and moving it out
		// leaves that row to the formatting verbs. See the note at the keybinding
		// in Editor.svelte.
		chords: ['Mod+Alt+Z'],
		group: 'view',
		documentCommands: ['toggle-zen-mode'],
	},
	{
		id: 'app-settings',
		labelKey: 'menu.settings',
		chords: ['Mod+,'],
		group: 'view',
		documentCommands: ['open-settings'],
	},
	{ id: 'view-zoom-in', labelKey: 'menu.zoomIn', chords: ['Mod+='], group: 'view', documentCommands: ['zoom-in'] },
	{ id: 'view-zoom-out', labelKey: 'menu.zoomOut', chords: ['Mod+-'], group: 'view', documentCommands: ['zoom-out'] },
	{ id: 'view-zoom-reset', labelKey: 'menu.resetZoom', chords: ['Mod+0'], group: 'view', documentCommands: ['zoom-reset'] },

	// -------------------------------------------------------------- window
];

/**
 * The modifier word each platform spells `Mod` with.
 *
 * Takes the raw `settings.osType` rather than `ShortcutPlatform`, because that
 * store field also carries `'unknown'` while the Tauri call that resolves it is
 * still in flight. Every caller that has an os type and needs a modifier goes
 * through here, so `=== 'macos' ? 'Cmd' : 'Ctrl'` is written once.
 */
export function modifierFor(platform: string): 'Cmd' | 'Ctrl' {
	return platform === 'macos' ? 'Cmd' : 'Ctrl';
}

/**
 * Should this click on a document link open a tab rather than navigate this one?
 *
 * THE CHORD IS THE PLATFORM'S. This is a gesture people bring with them from a
 * browser rather than learn here: ⌘-click on macOS, Ctrl-click everywhere else.
 * Reading both modifiers on both platforms — fine for a wheel-zoom, where
 * either answer is the same answer — is wrong in each direction here. On macOS
 * Ctrl-click IS the secondary click, so one gesture would open a context menu
 * and a tab; on Windows and Linux Meta is the Super key, which belongs to the
 * window manager. Asked through `modifierFor` so that "which modifier is this
 * platform's" keeps one answer, including for the `'unknown'` os type the store
 * carries until Tauri replies.
 *
 * THE CHORD MEANS "THE OTHER ONE", not "new tab". With `preferNewTab` off it
 * opens a tab; with it on it navigates in place. That is what the modifier does
 * in a browser and in Obsidian, and it is the difference between a preference
 * that changes the default and one that takes the other behaviour away — the
 * in-place path is the only thing that writes a tab's file history, which is
 * what Back and Forward read.
 */
export function opensInNewTab(
	platform: string,
	event: { readonly metaKey: boolean; readonly ctrlKey: boolean },
	preferNewTab: boolean,
): boolean {
	const chord = modifierFor(platform) === 'Cmd' ? event.metaKey : event.ctrlKey;
	return chord !== preferNewTab;
}

/**
 * The words each platform prints on the keys the two platforms name
 * differently, keyed by that platform's `Mod` word.
 *
 * `Cmd` IS macOS here, and nothing else produces these two values: they come
 * from `modifierFor` above, which is the one place the os type is read. So a
 * caller holding a modifier has already told this table which platform it is
 * rendering for, even though it never passes a platform.
 *
 * `Ctrl` and `Shift` are absent on purpose — a Mac keyboard prints `control`
 * and `shift`, so those words need no translation. `Alt` is here because it
 * needs one: Apple keyboards print `⌥ option` and the word "Alt" appears on no
 * modern Mac keyboard.
 */
const PLATFORM_KEY_WORDS = {
	Cmd: { Mod: 'Cmd', Alt: 'Opt' },
	Ctrl: { Mod: 'Ctrl', Alt: 'Alt' },
} as const;

/**
 * A chord template as a user should read it on `modifier`'s platform.
 *
 * The keys whose NAME differs across platforms are substituted — `Mod` and
 * `Alt`, per `PLATFORM_KEY_WORDS`. Everything else — `Ctrl`, `Shift`, `F5`,
 * the key itself — is already the literal the key carries on both.
 *
 * `Alt` used to be in that second list, and that was wrong: the panel advertised
 * `Alt+Left` to a Mac user, who has no key called Alt to press. Adding a modifier
 * that macOS renames without adding it here fails
 * `scripts/shortcuts.test.ts`.
 */
export function formatChord(chord: string, modifier: 'Cmd' | 'Ctrl'): string {
	const words: Record<string, string> = PLATFORM_KEY_WORDS[modifier];
	return chord.replace(/\b(?:Mod|Alt)\b/g, (token) => words[token]);
}

const byId = new Map(SHORTCUTS.map((entry) => [entry.id, entry]));

/**
 * The single chord a one-line consumer shows for `id`, or `undefined` when the
 * command has no shortcut. This is what the app menu and the toolbar tooltip
 * call, so neither of them holds a literal any more.
 */
export function shortcutLabel(id: string, modifier: 'Cmd' | 'Ctrl'): string | undefined {
	const entry = byId.get(id);
	return entry ? formatChord(entry.chords[0], modifier) : undefined;
}

type ShortcutSection = {
	group: ShortcutGroup;
	labelKey: TranslationKey;
	entries: ReadonlyArray<{ id: string; labelKey: TranslationKey; hintKey?: TranslationKey; chords: string[] }>;
};

/** The whole registry, grouped and rendered for `platform` — what the panel draws. */
export function shortcutSections(platform: ShortcutPlatform): ShortcutSection[] {
	const modifier = modifierFor(platform);
	return SHORTCUT_GROUPS.map(({ group, labelKey }) => ({
		group,
		labelKey,
		entries: SHORTCUTS.filter((entry) => entry.group === group).map((entry) => ({
			id: entry.id,
			labelKey: (platform === 'macos' && entry.macosLabelKey) || entry.labelKey,
			hintKey: entry.hintKey,
			chords: entry.chords.map((chord) => formatChord(chord, modifier)),
		})),
	}));
}
