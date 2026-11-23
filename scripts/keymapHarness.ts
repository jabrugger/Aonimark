import assert from 'node:assert/strict';

import { viewerCommandFor, type KeyContext, type ViewerCommand } from '../src/lib/utils/viewerKeymap.js';
import { viewerCommandTable, type ViewerCommandHost } from '../src/lib/utils/viewerCommands.js';

/*
 * RUNNING the app's keyboard layer, so tests can ask what a chord DOES.
 *
 * The document-level dispatcher, `viewerCommandFor` in
 * `src/lib/utils/viewerKeymap.ts`, is imported and called. A chord is spelled
 * the way the registry spells it once translated by `toChordLabel`: modifiers in
 * the order Ctrl, Shift, Alt, Meta, then the key name.
 *
 * WHAT IT DOES NOT ESTABLISH
 *
 * - That the webview delivers these chords at runtime. What is pinned here is
 *   the keymap the app declares.
 * - Layout-dependent `key` values. The synthetic events carry the UNSHIFTED
 *   character (`key: ','`, not `'<'`), because that is the only value that is
 *   the same on every keyboard layout.
 */

export type Chord = string;

const MODIFIER_ORDER = ['Ctrl', 'Shift', 'Alt', 'Meta'] as const;

export function label(parts: {
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
	metaKey: boolean;
	keyName: string;
}): string {
	const mods = [
		parts.ctrlKey && 'Ctrl',
		parts.shiftKey && 'Shift',
		parts.altKey && 'Alt',
		parts.metaKey && 'Meta',
	].filter(Boolean) as Array<(typeof MODIFIER_ORDER)[number]>;
	return [...MODIFIER_ORDER.filter((m) => mods.includes(m)), parts.keyName].join('+');
}

export const PLATFORMS = [
	{ name: 'macOS', osType: 'macos', mac: true },
	{ name: 'Windows', osType: 'windows', mac: false },
	{ name: 'Linux', osType: 'linux', mac: false },
] as const;

/**
 * The keys the document-level handler is fired with.
 *
 * `key` is the unshifted character and `code` the physical key, which is what a
 * US layout reports and what every layout reports for letters and digits.
 * `keyName` is how a chord on that key is written in a label.
 */
const FUZZ_KEYS: Array<{ keyName: string; key: string; code: string }> = [
	...'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => ({ keyName: c.toUpperCase(), key: c, code: `Key${c.toUpperCase()}` })),
	...'0123456789'.split('').map((c) => ({ keyName: c, key: c, code: `Digit${c}` })),
	{ keyName: 'Tab', key: 'Tab', code: 'Tab' },
	{ keyName: 'PageUp', key: 'PageUp', code: 'PageUp' },
	{ keyName: 'PageDown', key: 'PageDown', code: 'PageDown' },
	{ keyName: 'LeftArrow', key: 'ArrowLeft', code: 'ArrowLeft' },
	{ keyName: 'RightArrow', key: 'ArrowRight', code: 'ArrowRight' },
	{ keyName: 'F4', key: 'F4', code: 'F4' },
	{ keyName: 'F5', key: 'F5', code: 'F5' },
	{ keyName: '\\', key: '\\', code: 'Backslash' },
	{ keyName: 'OEM_102', key: '\\', code: 'IntlBackslash' },
	{ keyName: '[', key: '[', code: 'BracketLeft' },
	{ keyName: ']', key: ']', code: 'BracketRight' },
	{ keyName: '.', key: '.', code: 'Period' },
	{ keyName: ',', key: ',', code: 'Comma' },
	{ keyName: '-', key: '-', code: 'Minus' },
	{ keyName: '=', key: '=', code: 'Equal' },
];

/** The state every caller of `documentKeymap` is asking about: a dialog-free app window. */
function appContext(osType: string): KeyContext {
	return {
		mode: 'app',
		osType: osType as KeyContext['osType'],
		overlayOpen: false,
		dialogOpen: false,
	};
}

/**
 * Which command the document-level dispatcher means by each chord.
 *
 * `viewerCommandFor` is a plain function of the keystroke and a small context,
 * so it is called as it is: a dependency it grows is a compile error at this
 * call site rather than a stand-in that answers every question.
 */
export function documentKeymap(osType: string): Map<Chord, ViewerCommand> {
	const context = appContext(osType);
	const map = new Map<Chord, ViewerCommand>();

	for (const primary of [
		{ ctrlKey: false, metaKey: false },
		{ ctrlKey: true, metaKey: false },
		{ ctrlKey: false, metaKey: true },
	]) {
		for (const shiftKey of [false, true]) {
			for (const altKey of [false, true]) {
				for (const entry of FUZZ_KEYS) {
					const command = viewerCommandFor(
						{ ...primary, shiftKey, altKey, key: entry.key, code: entry.code, target: null },
						context,
					);
					if (command) map.set(label({ ...primary, shiftKey, altKey, keyName: entry.keyName }), command);
				}
			}
		}
	}
	assert.ok(
		map.size > 15,
		`the document dispatcher answered ${map.size} chords; the harness is not running the real function`,
	);
	return map;
}

/**
 * What each `ViewerCommand` reaching the keyboard does, as the names of the
 * host members it touched: `'appExit'` for a call, `'settings.showTabs='` for a
 * write.
 *
 * Runs the real `viewerCommandTable` (`viewerCommands.ts`) against a recording
 * host: any member the table asks for exists and is logged, so a command that
 * reached for something the host type never had shows up by name.
 */
export function viewerCommandCalls(): Record<ViewerCommand, string[]> {
	let calls: string[] = [];
	const recording = (prefix: string, fields: Record<string, unknown>) =>
		new Proxy(fields, {
			get(target, prop) {
				const name = prefix + String(prop);
				calls.push(name);
				if (prop in target) return target[prop as string];
				return () => {
					calls.push(`${name}()`);
					return Promise.resolve();
				};
			},
			set(target, prop, value) {
				calls.push(`${prefix}${String(prop)}=`);
				target[prop as string] = value;
				return true;
			},
		});
	const host = recording('', {
		settings: recording('settings.', { previewFullWidth: true, previewMaxWidth: 880, showTabs: true }),
		tabManager: recording('tabManager.', { activeTabId: 'tab-1' }),
	}) as unknown as ViewerCommandHost;
	const table = viewerCommandTable(host);

	const reachable = new Set<ViewerCommand>();
	for (const platform of PLATFORMS) for (const command of documentKeymap(platform.osType).values()) reachable.add(command);
	const result = {} as Record<ViewerCommand, string[]>;
	for (const command of reachable) {
		calls = [];
		table[command]();
		// A call shows up twice, as the read and then the call; keep the call.
		result[command] = calls.filter((name) => !calls.includes(`${name}()`)).map((name) => name.replace(/\(\)$/, ''));
	}
	return result;
}

/** The key names the registry spells differently from a chord label. */
const KEY_NAMES: Record<string, string> = {
	Left: 'LeftArrow',
	Right: 'RightArrow',
};

/**
 * A registry chord as the harness spells the same chord.
 *
 * The registry is written for a reader (`Mod+Shift+E`); a label puts the
 * modifiers in a fixed order (`Shift+Meta+E` on macOS, `Ctrl+Shift+E`
 * elsewhere). Translating in this direction keeps the registry human-facing,
 * and a mistake here makes assertions FAIL rather than pass, because the
 * comparison is against chords the real code produced.
 */
export function toMonacoLabel(chord: string, mac: boolean): Chord {
	return chord
		.split(' ')
		.map((single) => {
			const parts = single.split('+');
			const key = parts.pop()!;
			const mods = new Set(parts);
			const ctrl = mods.has('Ctrl') || (mods.has('Mod') && !mac);
			// A literal `Meta` stays Meta on every platform, the same way a literal
			// `Ctrl` does.
			const meta = mods.has('Meta') || (mods.has('Mod') && mac);
			return [ctrl && 'Ctrl', mods.has('Shift') && 'Shift', mods.has('Alt') && 'Alt', meta && 'Meta', KEY_NAMES[key] ?? key]
				.filter(Boolean)
				.join('+');
		})
		.join(' ');
}
