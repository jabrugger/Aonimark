import { createSubscriber } from 'svelte/reactivity';

export type LanguageCode =
	| 'en' // English
	| 'ja' // Japanese
	| 'zh-CN' // Chinese (Simplified)
	| 'zh-TW' // Chinese (Traditional)
	| 'ko' // Korean
	| 'ru' // Russian
	| 'es' // Spanish
	| 'fr' // French
	| 'de' // German
	| 'pt-BR' // Portuguese (Brazil)
	| 'it' // Italian
	| 'pl' // Polish
	| 'nl' // Dutch
	| 'sv' // Swedish
	| 'vi' // Vietnamese
	| 'pt' // Portuguese (European)
	| 'ro' // Romanian
	| 'hu' // Hungarian
	| 'cs' // Czech
	| 'sk' // Slovak
	| 'el' // Greek
	| 'fi' // Finnish
	| 'da' // Danish
	| 'no' // Norwegian
	| 'id' // Indonesian
	| 'tr'; // Turkish

export interface Translation {
    [key: string]: string | Translation;
}

export function getSupportedLanguages() {
	return [
		{ code: 'cs' as LanguageCode, name: 'Czech', nativeName: 'Čeština' },
		{ code: 'da' as LanguageCode, name: 'Danish', nativeName: 'Dansk' },
		{ code: 'nl' as LanguageCode, name: 'Dutch', nativeName: 'Nederlands' },
		{ code: 'en' as LanguageCode, name: 'English', nativeName: 'English' },
		{ code: 'fi' as LanguageCode, name: 'Finnish', nativeName: 'Suomi' },
		{ code: 'fr' as LanguageCode, name: 'French', nativeName: 'Français' },
		{ code: 'de' as LanguageCode, name: 'German', nativeName: 'Deutsch' },
		{ code: 'el' as LanguageCode, name: 'Greek', nativeName: 'Ελληνικά' },
		{ code: 'hu' as LanguageCode, name: 'Hungarian', nativeName: 'Magyar' },
		{ code: 'id' as LanguageCode, name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
		{ code: 'it' as LanguageCode, name: 'Italian', nativeName: 'Italiano' },
		{ code: 'ja' as LanguageCode, name: 'Japanese', nativeName: '日本語' },
		{ code: 'ko' as LanguageCode, name: 'Korean', nativeName: '한국어' },
		{ code: 'no' as LanguageCode, name: 'Norwegian', nativeName: 'Norsk' },
		{ code: 'pl' as LanguageCode, name: 'Polish', nativeName: 'Polski' },
		{ code: 'pt' as LanguageCode, name: 'Portuguese', nativeName: 'Português' },
		{ code: 'pt-BR' as LanguageCode, name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)' },
		{ code: 'ro' as LanguageCode, name: 'Romanian', nativeName: 'Română' },
		{ code: 'ru' as LanguageCode, name: 'Russian', nativeName: 'Русский' },
		{ code: 'sk' as LanguageCode, name: 'Slovak', nativeName: 'Slovenčina' },
		{ code: 'es' as LanguageCode, name: 'Spanish', nativeName: 'Español' },
		{ code: 'sv' as LanguageCode, name: 'Swedish', nativeName: 'Svenska' },
		{ code: 'tr' as LanguageCode, name: 'Turkish', nativeName: 'Türkçe' },
		{ code: 'vi' as LanguageCode, name: 'Vietnamese', nativeName: 'Tiếng Việt' },
		{ code: 'zh-CN' as LanguageCode, name: 'Chinese (Simplified)', nativeName: '简体中文' },
		{ code: 'zh-TW' as LanguageCode, name: 'Chinese (Traditional)', nativeName: '繁體中文' }
	];
}

// Only English ships in the startup bundle; every other language is its own
// chunk under `src/lib/locales/`, fetched on first use. `+layout.ts` awaits the
// saved language before the first render, so a window never paints in English
// first. A language switched to later renders in English for the moment its
// chunk takes to arrive, and `t()` re-runs its callers when it lands.
const en = {
    settings: {
        title: 'Settings',
        autoSave: 'Auto-save edits',
        persistOpenEditors: 'Restore unsaved changes on launch',
        persistOpenEditorsHint: 'Quitting won\'t ask to save. Tabs with unsaved changes come back next time.',
        restoreStateOnReopen: 'Restore windows on launch',
        restoreStateOnReopenHint: 'Reopens your last windows and tabs. File contents are read from disk.',
        theme: 'Theme',
        language: 'Language',
        cancel: 'Cancel',
        save: 'Save',
        discard: 'Discard',
        themeDefaultLight: 'Default Light',
        themeDefaultDark: 'Default Dark',
        themeFollowSystem: 'Follow System',
    },
    menu: {
        toggleFullScreen: 'Toggle Full Screen',
        about: 'About Aonimark',
        services: 'Services',
        hideApp: 'Hide Aonimark',
        quit: 'Quit Aonimark',
        undo: 'Undo',
        redo: 'Redo',
        zoomWindow: 'Zoom',
        file: 'File',
        edit: 'Edit',
        view: 'View',
        newFile: 'New File',
        openFile: 'Open File',
        save: 'Save',
        saveAs: 'Save As',
        reloadFromDisk: 'Reload from Disk',
        closeFile: 'Close File',
        window: 'Window',
        cut: 'Cut',
        copy: 'Copy',
        paste: 'Paste',
        selectAll: 'Select All',
        zoomIn: 'Zoom In',
        zoomOut: 'Zoom Out',
        resetZoom: 'Reset Zoom',
        settings: 'Settings',
        checkForUpdates: 'Check for updates…',
        github: 'GitHub',
        exit: 'Exit',
        zenMode: 'Zen Mode',
        openFileLocation: 'Open File Location',
        autoReload: 'Auto-Reload',
        editor: 'Editor',
        changeTheme: 'Change Theme',
        bold: 'Bold',
        italic: 'Italic',
        strikethrough: 'Strikethrough',
        insertTable: 'Insert Table',
        inlineCode: 'Inline Code',
        codeBlock: 'Code Block',
        quote: 'Quote',
        heading1: 'Heading 1',
        heading2: 'Heading 2',
        heading3: 'Heading 3',
        horizontalRule: 'Horizontal Rule',
        bulletList: 'Bullet List',
        numberedList: 'Numbered List',
        link: 'Link',
    },
    toast: {
        recoveryFailed: 'Could not keep unsaved changes.',
        reloadedFromDisk: 'Reloaded from disk',
        unsupportedFile: 'Unsupported file type: {{filename}}',
        autoSaveFailed: 'Auto-save failed — unsaved changes still in memory',
        savedNewerEdits: 'Saved — staying in edit mode because you have newer edits',
        lossySaveBlocked: 'Not saved: parts of this file could not be read in any encoding and became "�" when it was opened. Saving would destroy the original — use "Save As" to write a copy',
        encodingUnmappable: 'Not saved: {{encoding}} cannot represent every character this document now contains (an emoji, most likely). Use "Save As" to write a copy as UTF-8',
        restoreInterruptedDeferred: 'Aonimark did not finish opening {path} last time, so it was skipped. Open it yourself to try again'
    },
    externalChange: {
        message: 'This file changed on disk while you had unsaved changes.',
        reload: 'Reload from disk',
        keepMine: 'Keep my version',
    },
    modal: {
        unsavedChanges: 'Unsaved Changes',
        youHaveUnsavedChanges: 'You have unsaved changes in "{title}". Do you want to save them before closing?',
    },
    update: {
        checkingHeader: 'Checking for updates…',
        checkingBody: 'Looking for the latest version of Aonimark…',
        upToDateHeader: 'You\'re up to date',
        upToDateBody: 'You\'re using the latest version of Aonimark (v{{version}}).',
        upToDateBodyNoVersion: 'You\'re using the latest version of Aonimark.',
        availableHeader: 'Update available',
        availableBody: 'Aonimark v{{latest}} is available. You\'re on v{{current}}.',
        releaseNotes: 'Release notes',
        packageManagedHeader: 'Updates come from your package manager',
        packageManagedBody: 'This copy of Aonimark was installed by a package manager, so it cannot replace itself. Get the newest version the same way you installed this one, or download a package from the releases page.',
        downloadingHeader: 'Downloading update…',
        downloadingBody: 'Downloading Aonimark v{{version}}…',
        downloadingProgress: '{{downloaded}} MB of {{total}} MB ({{pct}}%)',
        downloadingProgressUnknown: '{{downloaded}} MB downloaded',
        downloadingHint: 'Aonimark will restart automatically when the update is ready.',
        errorCheckHeader: 'Update check failed',
        errorCheckBody: 'Could not check for updates.',
        errorDownloadHeader: 'Update download failed',
        errorDownloadBody: 'Could not download or install the update.',
        errorInstallHeader: 'Restart failed',
        errorInstallBody: 'The update was downloaded but Aonimark could not restart automatically. Please quit and reopen Aonimark to finish installing.',
        cancel: 'Cancel',
        ok: 'OK',
        downloadInstall: 'Download & Install',
        closeOtherWindows: 'Close these windows first, or move their tabs here with Merge All Windows Here.',
        reopensTabs: 'After the update, Aonimark reopens the tabs in this window.',
        close: 'Close',
        retry: 'Retry'
    },
    tooltip: {
        menu: 'Menu',
        more: 'More',
        moreActions: 'More Actions',
        settings: 'Settings',
        resetZoom: 'Reset Zoom',
        reset: 'Reset',
        zenMode: 'Zen mode',
        toggleZenMode: 'Toggle Zen Mode',
        openFileLocation: 'Open file location',
        reloadFromDisk: 'Reload from Disk',
        toggleAutoReload: 'Toggle Auto-Reload',
        autoReload: 'Auto-Reload',
        changeTheme: 'Change Theme',
    },
    dragAndDrop: {
        open: 'Drop to Open'
    },
    theme: {
        followSystem: 'Follow System',
        defaultLight: 'Default Light',
        defaultDark: 'Default Dark'
    },
    tabs: {
        untitled: 'Untitled',
    },
    common: {
        close: 'Close',
        minimize: 'Minimize',
        maximize: 'Maximize',
        restore: 'Restore',
    },
    find: {
        placeholder: 'Find',
        next: 'Next match',
        previous: 'Previous match',
        close: 'Close',
        matchCount: '{{current}} of {{total}}',
        noMatches: 'No results',
        caseSensitive: 'Match case',
        wholeWord: 'Match whole word',
        replacePlaceholder: 'Replace with',
        replace: 'Replace',
        replaceAll: 'Replace all',
        toggleReplace: 'Show or hide replace'
    }
} satisfies Translation;

/** Every dotted path to a string in the English table: the keys `t()` accepts. */
type KeyPaths<T, Prefix extends string = ''> = {
    [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : KeyPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];
export type TranslationKey = KeyPaths<typeof en>;
type Suffix<K, Prefix extends string> = K extends `${Prefix}.${infer Rest}` ? Rest : never;
/** The keys under one section, for a caller that adds the `section.` prefix itself. */
export type TranslationKeyIn<Section extends string> = Suffix<TranslationKey, Section>;

type PartialTable<T> = { [K in keyof T]?: T[K] extends string ? string : PartialTable<T[K]> };

/** The labels of the editor's context menu (viewerContextMenu.ts `editorContextMenuItems`). */
type EditorMenuLabel = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'commandPalette' | 'changeAllOccurrences';

/**
 * The shape a locale file `satisfies`. A language may leave keys untranslated
 * (`t()` falls back to English) but may not file a key English does not have.
 */
export type LocaleTable = PartialTable<typeof en>;

const dictionaries = new Map<LanguageCode, Translation>([['en', en]]);
let localeLoaded = () => {};
const dependOnLocaleLoads = createSubscriber((update) => {
    localeLoaded = update;
    return () => {
        localeLoaded = () => {};
    };
});

export async function loadLocale(lang: LanguageCode): Promise<Translation> {
    let dictionary = dictionaries.get(lang);
    if (!dictionary) {
        dictionary = (await import(`../locales/${lang}.ts`)).default as Translation;
        dictionaries.set(lang, dictionary);
        localeLoaded();
    }
    return dictionary;
}

// `lang` is deliberately required. When it defaulted to 'en', a call site that
// forgot to pass the language compiled, ran, and showed English in all 26
// languages — silently, including on aria-labels a screen reader reads out.
// The default is the bug; the compiler is the check. Do not restore it.
export function t(key: TranslationKey, lang: LanguageCode): string {
    const keys = key.split('.');
    
    const getValue = (dict: any) => {
        let res = dict;
        for (const k of keys) {
            if (res && typeof res === 'object' && k in res) res = res[k];
            else return undefined;
        }
        return typeof res === 'string' ? res : undefined;
    };

    const dictionary = dictionaries.get(lang);
    if (!dictionary) {
        dependOnLocaleLoads();
        void loadLocale(lang);
    }

    let result = getValue(dictionary);
    if (result !== undefined) return result;
    
    if (lang !== 'en') {
        result = getValue(en);
        if (result !== undefined) return result;
    }
    
    return key;
}
