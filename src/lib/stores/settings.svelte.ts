import { commands } from '../bindings.js';
import { getSupportedLanguages, type LanguageCode } from '../utils/i18n.js';

export type OSType = 'macos' | 'windows' | 'linux' | 'unknown';

export type { LanguageCode };

export type ThemeSetting = 'system' | 'light' | 'dark';

const DEFAULT_THEME: ThemeSetting = 'system';

/** The four the backend can answer `get_os_type` with. */
function isOSType(value: unknown): value is OSType {
	return value === 'macos' || value === 'windows' || value === 'linux' || value === 'unknown';
}

function isThemeSetting(value: unknown): value is ThemeSetting {
	return value === 'system' || value === 'light' || value === 'dark';
}

/** Anything unrecognised is the default rather than an error: a stored theme must not stop the app starting. */
export function resolveTheme(value: unknown): ThemeSetting {
	return isThemeSetting(value) ? value : DEFAULT_THEME;
}

/**
 * The codes `isSupportedLanguage` will accept out of persisted storage, taken
 * from the same catalogue the language `<select>` renders.
 *
 * This module used to carry its own `{ code, name, nativeName }` table beside
 * `getSupportedLanguages()`. Only the `code` column was ever read, so the two
 * copies of the display columns drifted unnoticed: `pt` was "Portuguese" in
 * the catalogue the dialog renders and "Portuguese (European)" in the copy
 * here, and no user ever saw the second spelling. Deriving from the catalogue
 * means a language can only be added, removed or renamed in one place.
 */
const SUPPORTED_LANGUAGE_CODES: readonly LanguageCode[] = getSupportedLanguages().map((entry) => entry.code);

export function isSupportedLanguage(value: unknown): value is LanguageCode {
	return typeof value === 'string' && (SUPPORTED_LANGUAGE_CODES as readonly string[]).includes(value);
}

/**
 * Maps a BCP-47 *primary language subtag* to one of our catalogue entries.
 *
 * Matching is on the exact primary subtag rather than a `startsWith()` prefix:
 * prefix matching silently confuses distinct languages that share leading
 * letters (`nl` Dutch vs. `nn`/`nb` Norwegian), and it also matches unrelated
 * tags such as `nog` (Nogai).
 */
const LANGUAGE_BY_PRIMARY_SUBTAG: Readonly<Record<string, LanguageCode>> = {
	cs: 'cs',
	da: 'da',
	de: 'de',
	el: 'el',
	en: 'en',
	es: 'es',
	fi: 'fi',
	fr: 'fr',
	hu: 'hu',
	id: 'id',
	it: 'it',
	ja: 'ja',
	ko: 'ko',
	nl: 'nl',
	// Our catalogue is keyed by the `no` macrolanguage, but BCP-47 tags in the
	// wild are `nb` (Bokmål) or `nn` (Nynorsk); browsers essentially never
	// report a bare `no`. Accept all three.
	nb: 'no',
	nn: 'no',
	no: 'no',
	pl: 'pl',
	ro: 'ro',
	ru: 'ru',
	sk: 'sk',
	sv: 'sv',
	tr: 'tr',
	vi: 'vi',
};

/**
 * Resolves a BCP-47 language tag to a supported catalogue code, or `null` when
 * we have no translation for it. Pure so it can be unit-tested directly.
 */
export function resolveLanguageTag(tag: string | null | undefined): LanguageCode | null {
	if (typeof tag !== 'string') return null;
	const subtags = tag.trim().toLowerCase().split(/[-_]/).filter(Boolean);
	const primary = subtags[0];
	if (!primary) return null;
	const rest = subtags.slice(1);

	if (primary === 'zh') {
		// The script subtag is authoritative when present: `zh-Hant` and
		// `zh-Hant-TW` are Traditional even without a Traditional region, and
		// `zh-Hans-HK` is Simplified despite the Hong Kong region.
		if (rest.includes('hant')) return 'zh-TW';
		if (rest.includes('hans')) return 'zh-CN';
		if (rest.some((subtag) => subtag === 'tw' || subtag === 'hk' || subtag === 'mo')) return 'zh-TW';
		return 'zh-CN';
	}
	if (primary === 'pt') {
		return rest.includes('br') ? 'pt-BR' : 'pt';
	}
	return LANGUAGE_BY_PRIMARY_SUBTAG[primary] ?? null;
}

export function detectSystemLanguage(): LanguageCode {
	if (typeof navigator === 'undefined') return 'en';
	return resolveLanguageTag(navigator.language) ?? 'en';
}

interface NumericSettingRange {
	min: number;
	max: number;
	step: number;
	default: number;
}

export const ZOOM_LEVEL_RANGE: NumericSettingRange = { min: 25, max: 500, step: 10, default: 100 };

/**
 * The zoom factor one Ctrl/Cmd+wheel event asks for (#831).
 *
 * WebKit and Chromium both deliver a trackpad pinch as ctrl+wheel events with
 * `deltaY = -100·ln(scale)`, so `exp(-deltaY / 100)` hands back the fingers'
 * own scale: a pinch zooms as far as the fingers move, not a fixed step per
 * event. The clamp caps one event near 10%, which is what a mouse notch still
 * gets where it reports a large delta (100 on Windows); a slow notch on macOS
 * reports a few pixels and zooms by that much less.
 */
export function wheelZoomFactor(deltaY: number): number {
	return Math.exp(-Math.max(-10, Math.min(10, deltaY)) / 100);
}

/**
 * Coerces anything to an in-range integer, falling back to the range default.
 *
 * "No value" (null/undefined/empty) is the default rather than the minimum:
 * `Number(null)` is 0, so clamping it blindly would turn a cleared input into
 * the smallest legal font size instead of the one the user started with.
 */
export function clampToRange(value: unknown, range: NumericSettingRange): number {
	if (value === null || value === undefined || value === '') return range.default;
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(parsed)) return range.default;
	return Math.min(range.max, Math.max(range.min, Math.round(parsed)));
}

/** Parses a persisted string. Missing/blank/garbage all fall back to the default. */
function parseStoredNumber(raw: string | null, range: NumericSettingRange): number {
	if (raw === null || raw.trim() === '') return range.default;
	return clampToRange(raw, range);
}

/** Spin-button helper: nudge by `delta` steps and clamp with the same rules. */
export function stepWithinRange(current: unknown, delta: number, range: NumericSettingRange): number {
	return clampToRange(clampToRange(current, range) + delta, range);
}

function hasStorage(): boolean {
	return typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function';
}

interface PersistedSetting<T> {
	readonly key: string;
	/** Serializes this entry's single field. `null` means "remove the key". */
	readonly read: (target: T) => string | null;
	/** Applies a stored (or remotely changed) raw value back onto that field. */
	readonly load: (target: T, raw: string | null) => void;
}

/**
 * Compare-and-set write. Returns true when localStorage actually changed.
 *
 * This is the whole anti-echo mechanism for cross-window sync, and it is why no
 * "I am currently applying a remote change" flag is involved. Such a flag
 * cannot work here: Svelte flushes effects asynchronously, so a flag raised and
 * lowered synchronously inside a `storage` handler is long gone by the time the
 * dependent effect runs — and holding it up until the next flush would also
 * swallow genuine local edits made in the same tick.
 *
 * Reading before writing needs no timing assumption at all. A value that
 * arrived *from* localStorage is by definition already equal to what is stored,
 * so the write-back is dropped at its source and the
 * `storage` -> state -> effect -> write -> `storage` loop terminates after one
 * hop. It also makes redundant writes free in the ordinary single-window case.
 */
export function writeStoredSetting(key: string, value: string | null): boolean {
	if (!hasStorage()) return false;
	const current = localStorage.getItem(key);
	if (value === null) {
		if (current === null) return false;
		localStorage.removeItem(key);
		return true;
	}
	if (current === value) return false;
	localStorage.setItem(key, value);
	return true;
}

/** Applies everything currently in localStorage onto `target`. */
function loadPersistedSettings<T>(target: T, entries: readonly PersistedSetting<T>[]): void {
	if (!hasStorage()) return;
	for (const entry of entries) {
		entry.load(target, localStorage.getItem(entry.key));
	}
}

/**
 * Wires `entries` up to localStorage. Must be called inside an effect root.
 *
 * One effect per key, instead of one effect reading every field: a change to
 * setting A then rewrites only A's key. Markpad opens several windows, each a
 * separate webview with its own store instance, all sharing one localStorage —
 * with a single all-fields effect, any change in window B rewrote all ~30 keys
 * from B's construction-time snapshot and threw away whatever window A had just
 * changed.
 *
 * The `storage` listener closes the other half: localStorage fires it in every
 * *other* same-origin document, so each window folds its siblings' changes into
 * its own state instead of drifting until the next restart.
 */
function installPersistedSettings<T>(target: T, entries: readonly PersistedSetting<T>[]): void {
	for (const entry of entries) {
		$effect(() => {
			writeStoredSetting(entry.key, entry.read(target));
		});
	}

	$effect(() => {
		if (typeof window === 'undefined') return;
		const entriesByKey = new Map(entries.map((entry) => [entry.key, entry]));
		const onStorage = (event: StorageEvent) => {
			if (event.storageArea && hasStorage() && event.storageArea !== localStorage) return;
			// A null key means the whole store was cleared; re-read everything.
			if (event.key === null) {
				loadPersistedSettings(target, entries);
				return;
			}
			const entry = entriesByKey.get(event.key);
			if (entry) entry.load(target, event.newValue);
		};
		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	});
}

export class SettingsStore {
	restoreStateOnReopen = $state(true);
	zenMode = $state(false);
	zoomLevel = $state(ZOOM_LEVEL_RANGE.default);
	theme = $state<ThemeSetting>(DEFAULT_THEME);
	osType = $state<OSType>('unknown');
	language = $state<LanguageCode>('en');
	autoSave = $state(true);
	persistOpenEditors = $state(true);

	#disposeEffects: (() => void) | null = null;
	#exactZoom: number | null = null;

	constructor() {
		if (!hasStorage()) return;
		const entries = createSettingsPersistence();
		loadPersistedSettings(this, entries);
		void this.initOSType();
		this.#disposeEffects = $effect.root(() => {
			installPersistedSettings(this, entries);
		});
	}

	dispose(): void {
		this.#disposeEffects?.();
		this.#disposeEffects = null;
	}

	toggleZenMode() {
		this.zenMode = !this.zenMode;
	}

	zoomIn() {
		this.zoomLevel = stepWithinRange(this.zoomLevel, ZOOM_LEVEL_RANGE.step, ZOOM_LEVEL_RANGE);
	}

	zoomOut() {
		this.zoomLevel = stepWithinRange(this.zoomLevel, -ZOOM_LEVEL_RANGE.step, ZOOM_LEVEL_RANGE);
	}

	/**
	 * Scales the zoom by `factor` without losing the fraction between events, so
	 * a slow pinch that asks for 1% at a time still adds up.
	 */
	zoomBy(factor: number) {
		const current =
			this.#exactZoom !== null && Math.round(this.#exactZoom) === this.zoomLevel
				? this.#exactZoom
				: clampToRange(this.zoomLevel, ZOOM_LEVEL_RANGE);
		const next = Math.min(ZOOM_LEVEL_RANGE.max, Math.max(ZOOM_LEVEL_RANGE.min, current * factor));
		this.#exactZoom = next;
		this.zoomLevel = Math.round(next);
	}

	resetZoom() {
		this.zoomLevel = ZOOM_LEVEL_RANGE.default;
	}

	async initOSType() {
		try {
			const osType = await commands.getOsType();
			this.osType = isOSType(osType) ? osType : 'unknown';
		} catch (e) {
			console.error('Failed to get OS type:', e);
			this.osType = 'unknown';
		}
	}
}

function booleanSetting(
	key: string,
	read: (target: SettingsStore) => boolean,
	load: (target: SettingsStore, value: boolean) => void,
): PersistedSetting<SettingsStore> {
	return {
		key,
		read: (target) => String(read(target)),
		load: (target, raw) => {
			if (raw !== null) load(target, raw === 'true');
		},
	};
}

/** The complete localStorage contract of {@link SettingsStore}: one entry per key, one store field per entry. */
export function createSettingsPersistence(): PersistedSetting<SettingsStore>[] {
	return [
		booleanSetting('editor.autoSaveEdits', (s) => s.autoSave, (s, v) => { s.autoSave = v; }),
		booleanSetting('editor.persistOpenEditors', (s) => s.persistOpenEditors, (s, v) => { s.persistOpenEditors = v; }),
		booleanSetting('editor.restoreStateOnReopen', (s) => s.restoreStateOnReopen, (s, v) => { s.restoreStateOnReopen = v; }),
		booleanSetting('editor.zenMode', (s) => s.zenMode, (s, v) => { s.zenMode = v; }),
		{
			key: 'zoomLevel',
			read: (s) => String(s.zoomLevel),
			load: (s, raw) => { s.zoomLevel = parseStoredNumber(raw, ZOOM_LEVEL_RANGE); },
		},
		{
			key: 'editor.language',
			read: (s) => s.language,
			load: (s, raw) => {
				if (raw === null) {
					s.language = detectSystemLanguage();
				} else if (isSupportedLanguage(raw)) {
					s.language = raw;
				}
			},
		},
		{
			// Unprefixed, because `src/app.html` reads this key in its first-paint
			// script to pick a background colour before the bundle loads.
			key: 'theme',
			read: (s) => s.theme,
			load: (s, raw) => { s.theme = resolveTheme(raw); },
		},
	];
}

export const settings = new SettingsStore();
