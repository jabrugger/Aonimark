import assert from 'node:assert/strict';

import { flushSync } from 'svelte';
import { beforeAll, describe, onTestFinished, test } from 'vitest';

import { handleModalBackdropContextMenu } from '../src/lib/utils/modalContextMenu.js';
import { type KeyContext, type KeyStroke, type ViewerCommand, viewerCommandFor } from '../src/lib/utils/viewerKeymap.js';
import { PLATFORMS } from './keymapHarness.js';
import { ChoiceDialog } from '../src/lib/utils/choiceDialog.svelte.js';
import { contextMenuFor } from '../src/lib/utils/viewerContextMenu.js';

describe('viewer keymap', () => {
	/*
	 * The document-level dispatcher, called rather than read.
	 *
	 * `shortcuts.test.ts` and `shortcuts.editor.test.ts` already sweep
	 * the whole keymap chord by chord and hold it against the shortcuts panel; what
	 * is here is the handful of claims that a sweep cannot make — the ones about
	 * the CONTEXT rather than the chord, which the sweep fires with one fixed
	 * context, and the two that need a real DOM.
	 *
	 * A `.spec.ts` for the DOM: `canUsePreviewWidthShortcut` matches a selector
	 * against a real element, and a hand-made object with a `closest` method would
	 * be asserting against the test's own idea of the selector rather than the
	 * browser's. See AGENTS.md on which runner a test belongs to.
	 */

	const READING: KeyContext = {
		mode: 'app',
		osType: 'windows',
		
		overlayOpen: false,
		dialogOpen: false,
		
		
	};

	const chord = (key: string, code: string, mods: Partial<KeyStroke> = {}): KeyStroke => ({
		key,
		code,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		altKey: false,
		...mods,
	});

	test('nothing is dispatched before the app has loaded', () => {
		// `mode !== 'app'` was the handler's first line and the only branch condition
		// that could not be reached by firing a chord at it, because the harness
		// pinned `mode: 'app'` to get any answer at all.
		const modS = chord('s', 'KeyS', { ctrlKey: true });
		assert.equal(viewerCommandFor(modS, READING), 'save');
		assert.equal(viewerCommandFor(modS, { ...READING, mode: 'loading' }), null);

		// And it is the whole keymap, not just Save: a splash screen answers nothing.
		for (const platform of PLATFORMS) {
			for (const key of ['w', 'q', 'e', 'o', 't', 'n', ',', '0']) {
				assert.equal(
					viewerCommandFor(chord(key, `Key${key.toUpperCase()}`, { ctrlKey: true }), {
						...READING,
						osType: platform.osType as KeyContext['osType'],
						mode: 'loading',
					}),
					null,
					`${platform.name}: Mod+${key} while loading`,
				);
			}
		}
	});

	test('macOS leaves ⌘Q to the application menu, and the other two do not', () => {
		// The early return, asked per platform. It is scoped by `osType` rather than
		// by `platformOf`, which folds Linux into Windows and could not express it.
		const modQ = chord('q', 'KeyQ', { metaKey: true });
		assert.equal(viewerCommandFor(modQ, { ...READING, osType: 'macos' }), null);
		assert.equal(viewerCommandFor(modQ, { ...READING, osType: 'windows' }), 'app-exit');
		assert.equal(viewerCommandFor(modQ, { ...READING, osType: 'linux' }), 'app-exit');
		// `osType` is `'unknown'` until the Rust command answers. Quit is not the
		// destructive branch that has to fail closed — Ctrl+F4 is, and it does — but
		// an unknown platform must still behave like the majority of them rather
		// than like a fourth case nobody wrote.
		assert.equal(viewerCommandFor(modQ, { ...READING, osType: 'unknown' }), 'app-exit');
	});

	test('the zoom-in chord answers both spellings of “Mod plus”', () => {
		// `+` IS the shifted `=` on the layouts that have both, so this branch cannot
		// demand Shift be up. The keymap sweep only ever fires unshifted characters,
		// so it sees the `=` half and never the `+` half; this is the other half.
		assert.equal(viewerCommandFor(chord('=', 'Equal', { ctrlKey: true }), READING), 'zoom-in');
		assert.equal(viewerCommandFor(chord('+', 'Equal', { ctrlKey: true, shiftKey: true }), READING), 'zoom-in');
		// And the shifted `=` spelling that is NOT `+` stays unbound: on a layout
		// where Shift+= is something else, the app has not claimed it.
		assert.equal(viewerCommandFor(chord('=', 'Equal', { ctrlKey: true, shiftKey: true }), READING), null);
		// Alt is up in every spelling — Mod+Alt+= is not zoom.
		assert.equal(viewerCommandFor(chord('+', 'Equal', { ctrlKey: true, shiftKey: true, altKey: true }), READING), null);
	});

	test('Mod+L reaches Auto-Reload from every mode, including the preview', () => {
		// #692. The chord used to exist only as an `editorAction`, so Monaco owned
		// it and it did nothing in the preview — the exact inverse of where the
		// Auto-Reload button was drawn, while the shortcut panel advertised it in
		// all three modes regardless. The button now appears in all three; this is
		// the other surface agreeing.
		const modL = chord('l', 'KeyL', { ctrlKey: true });
		assert.equal(viewerCommandFor(modL, READING), 'toggle-live-mode');
		assert.equal(
			viewerCommandFor(modL, { ...READING}),
			'toggle-live-mode',
		);
		assert.equal(viewerCommandFor(modL, { ...READING}), 'toggle-live-mode');

		// And it is Mod+L, not the cross product Mod+Shift+L / Mod+Alt+L.
		assert.equal(viewerCommandFor(chord('l', 'KeyL', { ctrlKey: true, shiftKey: true }), READING), null);
		assert.equal(viewerCommandFor(chord('l', 'KeyL', { ctrlKey: true, altKey: true }), READING), null);
		assert.equal(viewerCommandFor(chord('l', 'KeyL'), READING), null);
	});

	test('Mod+Alt+Z reaches Zen mode from the preview', () => {
		// #800. Zen was only an `editorAction`, so the chord did nothing without
		// Monaco on screen.
		const zen = chord('z', 'KeyZ', { ctrlKey: true, altKey: true });
		assert.equal(viewerCommandFor(zen, READING), 'toggle-zen-mode');
		assert.equal(viewerCommandFor(zen, { ...READING}), 'toggle-zen-mode');

		// Option rewrites the key on a Mac; the physical key is what the chord names.
		const macZen = chord('Ω', 'KeyZ', { metaKey: true, altKey: true });
		assert.equal(viewerCommandFor(macZen, { ...READING, osType: 'macos' }), 'toggle-zen-mode');

		// Mod+Z is undo and Mod+Shift+Z redo; neither may land here.
		assert.equal(viewerCommandFor(chord('z', 'KeyZ', { ctrlKey: true }), READING), null);
		assert.equal(viewerCommandFor(chord('z', 'KeyZ', { ctrlKey: true, shiftKey: true }), READING), null);
		assert.equal(viewerCommandFor(chord('z', 'KeyZ', { ctrlKey: true, altKey: true, shiftKey: true }), READING), null);
	});

	test('AltGr typing a character is not a Mod+Alt chord', () => {
		// Windows sends AltGr as Ctrl+Alt, with the AltGraph modifier on. Polish
		// types ż with AltGr+Z, which was toggling Zen mode instead.
		const altGr = (key: string, code: string): KeyStroke => ({
			...chord(key, code, { ctrlKey: true, altKey: true }),
			getModifierState: (name: string) => name === 'AltGraph',
		});
		assert.equal(viewerCommandFor(altGr('ż', 'KeyZ'), READING), null);
		assert.equal(viewerCommandFor(altGr('[', 'BracketLeft'), { ...READING}), null);

		// A real Ctrl+Alt still is.
		const zen = { ...chord('z', 'KeyZ', { ctrlKey: true, altKey: true }), getModifierState: () => false };
		assert.equal(viewerCommandFor(zen, READING), 'toggle-zen-mode');
	});

});

describe('platform source', async () => {
	/*
	 * "What platform is this?" had two answers.
	 *
	 * `TitleBar.svelte` sniffed `navigator.userAgent` for "Macintosh"; every other
	 * consumer — the shortcut panel, the editor toolbar, the tab tooltips, the
	 * document context menu, Monaco's keybindings — read `settings.osType`, which
	 * the Rust `get_os_type` command fills in. Nothing compared the two, so nothing
	 * could notice them disagreeing.
	 *
	 * They disagree at exactly one moment, and it is the moment the title bar is
	 * first painted. `SettingsStore` sets `osType` from an `await invoke(…)` in its
	 * constructor, so the field holds its initial `'unknown'` for as long as that
	 * round trip takes — the first test below pins that window open. During it the
	 * user agent already says "Macintosh" while `settings.osType` still says
	 * `'unknown'`, which is why the title bar could draw Mac chrome above tab
	 * tooltips printing the Ctrl chords.
	 *
	 * That window is also why the obvious fix is wrong. Repointing the title bar at
	 * `settings.osType` alone would make a Mac render the `windows` class, the
	 * Windows minimise/maximise/close buttons and no `native-mac` chrome for those
	 * frames, and then rearrange itself — a visible regression, traded for an
	 * invisible one. `platformOf` consults `settings.osType` first and falls back to
	 * the synchronous browser hint only while it is unresolved, so there is one
	 * source and no flash. The rest of this file is that claim, in both directions.
	 */

	const { platformOf } = await import('../src/lib/utils/platform.js');

	function withNavigatorPlatform(value: string, body: () => void) {
		const original = Object.getOwnPropertyDescriptor(navigator, 'platform');
		Object.defineProperty(navigator, 'platform', { value, configurable: true });
		try {
			body();
		} finally {
			if (original) Object.defineProperty(navigator, 'platform', original);
			else delete (navigator as { platform?: string }).platform;
		}
	}

	// ------------------------------------------------- the window really is open

	test('settings.osType is still unknown when a component first renders', async () => {
		// The premise of everything below, asserted rather than assumed. The store is
		// constructed and read in the SAME synchronous turn a component's first
		// render happens in, and `initOSType()` cannot have resolved by then however
		// fast the backend is — an awaited `invoke` is at minimum a microtask later.
		(window as any).__TAURI_INTERNALS__ = {
			invoke: async (command: string) => (command === 'get_os_type' ? 'macos' : null),
		};
		const { SettingsStore } = await import('../src/lib/stores/settings.svelte.js');

		const store = new SettingsStore();
		try {
			assert.equal(store.osType, 'unknown', 'the field a first render would read');

			// And it does resolve, so the window is a window and not the whole life of
			// the app: a title bar that read `settings.osType` alone would be correct
			// from here on and wrong before it. That is the flash.
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.equal(store.osType, 'macos');
		} finally {
			store.dispose();
		}
	});

	// ------------------------------------------------------ platformOf, per case

	test('a resolved os type is the answer, whatever the browser would have said', () => {
		// The direction that is red against the old title bar: a Mac whose os type is
		// known reads as macOS even where the user agent does not say "Macintosh",
		// and — the case that matters for a bug report — a Windows or Linux machine
		// reads as `windows` even if something upstream lied to the browser.
		withNavigatorPlatform('Win32', () => {
			assert.equal(platformOf('macos'), 'macos');
		});
		withNavigatorPlatform('MacIntel', () => {
			assert.equal(platformOf('windows'), 'windows');
			assert.equal(platformOf('linux'), 'windows', 'Linux takes the Ctrl chords and the Windows controls');
		});
	});

	test('during the startup window the browser hint answers, so the title bar cannot flash', () => {
		// THE REGRESSION GUARD. Delete the fallback and this is the test that goes
		// red: `platformOf('unknown')` would answer `'windows'` on a Mac, and the
		// title bar would paint the Windows window controls before rearranging.
		withNavigatorPlatform('MacIntel', () => {
			assert.equal(platformOf('unknown'), 'macos');
		});
		withNavigatorPlatform('iPhone', () => {
			assert.equal(platformOf('unknown'), 'macos');
		});
		withNavigatorPlatform('Win32', () => {
			assert.equal(platformOf('unknown'), 'windows');
		});
		withNavigatorPlatform('', () => {
			assert.equal(platformOf('unknown'), 'windows', 'no hint at all is not a Mac');
		});
	});
});

describe('os type fallback', async () => {
	/*
	 * `initOSType` caught a *rejection* and answered `'unknown'`, but a successful
	 * `null` went through `as OSType` into the field. `DEFAULT_FONTS[null]` is
	 * `undefined`, and the constructor reads `.editorFont` off it on the next line
	 * — so the store threw while starting, before any setting had been applied.
	 *
	 * The shipped app cannot reach it: the Rust command always answers a string.
	 * It surfaced in #635, where the vitest move began booting the real singleton
	 * against a bridge stub that answered `null` to everything, and the fix there
	 * was to correct the two stubs. This closes the store's half.
	 */

	let osTypeAnswer: unknown = 'macos';
	const osTypeBridge = {
		invoke: async (command: string) => (command === 'get_os_type' ? osTypeAnswer : null),
	};
	(window as any).__TAURI_INTERNALS__ = osTypeBridge;
	// Installed again before the tests run: other tests in this file replace the bridge.
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = osTypeBridge;
	});

	const { DEFAULT_FONTS, SettingsStore, isOSType } = await import('../src/lib/stores/settings.svelte.js');

	function bootWith(answer: unknown) {
		osTypeAnswer = answer;
		localStorage.clear();
		const store = new SettingsStore();
		onTestFinished(() => store.dispose());
		return store;
	}

	test('the guard admits the four the backend can answer with, and nothing else', () => {
		for (const ok of ['macos', 'windows', 'linux', 'unknown']) assert.equal(isOSType(ok), true);
		for (const bad of [null, undefined, '', 'Darwin', 'macOS', 0, {}]) assert.equal(isOSType(bad), false);
	});

	test('a backend that answers null leaves the store on a usable OS type', async () => {
		// THE BUG: `as OSType` put `null` in the field, and the font defaults are
		// indexed by it. Awaiting a macrotask lets the constructor's own
		// `initOSType().then(…)` settle — that continuation is where it threw.
		const store = bootWith(null);
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();

		assert.equal(store.osType, 'unknown');
		assert.equal(store.editorFont, DEFAULT_FONTS.unknown.editorFont);
		assert.equal(store.previewFont, DEFAULT_FONTS.unknown.previewFont);
		assert.equal(store.codeFont, DEFAULT_FONTS.unknown.codeFont);
	});

	test('a string the union does not contain is treated the same way', async () => {
		// A future backend answering `'Darwin'` is the same defect wearing a string:
		// it typechecks through a cast and indexes to `undefined` just as well.
		const store = bootWith('Darwin');
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();

		assert.equal(store.osType, 'unknown');
		assert.equal(store.editorFont, DEFAULT_FONTS.unknown.editorFont);
	});

	test('a real answer is still honoured', async () => {
		const store = bootWith('macos');
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();

		assert.equal(store.osType, 'macos');
		assert.equal(store.editorFont, DEFAULT_FONTS.macos.editorFont);
	});
});

describe('modal backdrop', () => {
	test('modal backdrop consumes context-menu events outside text fields', () => {
		const backdrop = document.createElement('div');
		backdrop.innerHTML = '<div class="modal-content"><p>Rename</p><input /><textarea></textarea></div>';
		document.body.append(backdrop);
		onTestFinished(() => backdrop.remove());
		backdrop.addEventListener('contextmenu', handleModalBackdropContextMenu);
		let reachedDocument = 0;
		const count = () => reachedDocument++;
		document.addEventListener('contextmenu', count);
		onTestFinished(() => document.removeEventListener('contextmenu', count));

		const rightClick = (target: Element) => {
			const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
			target.dispatchEvent(event);
			return event.defaultPrevented;
		};

		// No native menu over the dialog, and the app's own menus never hear it.
		assert.equal(rightClick(backdrop.querySelector('p')!), true);
		assert.equal(rightClick(backdrop), true);
		assert.equal(reachedDocument, 0);

		// The prompt input keeps the webview's Cut/Copy/Paste.
		assert.equal(rightClick(backdrop.querySelector('input')!), false);
		assert.equal(rightClick(backdrop.querySelector('textarea')!), false);
		assert.equal(reachedDocument, 2);
	});
});

describe('choice dialog', () => {
	test('a second dialog settles the first instead of orphaning it', async () => {
		// One dialog, one resolver. A second question used to overwrite the first
		// caller's resolver, so that caller awaited forever — when it was the close
		// walk, the window could not be closed again.
		const dialog = new ChoiceDialog();
		const first = dialog.ask('first', { title: 'Unsaved', kind: 'warning' });
		const second = dialog.ask('second', { title: 'Unsaved', kind: 'warning' });
		assert.equal(dialog.message, 'second');
		dialog.close('discard');

		assert.equal(await Promise.race([first, Promise.resolve('never settled')]), 'cancel');
		assert.equal(await second, 'discard');
		assert.equal(dialog.show, false);
	});
});

describe('document context menu routing', () => {
	function inside(html: string, selector: string) {
		const root = document.createElement('div');
		root.innerHTML = html;
		return root.querySelector(selector)!;
	}

	test('document context menus do not open while a modal is active', () => {
		// Every case answers 'none' with a dialog up, the editor's included.
		for (const target of [inside('<p>text</p>', 'p'), inside('<div class="editor-container"><textarea></textarea></div>', 'textarea')]) {
			assert.equal(contextMenuFor(target, { modalOpen: true, inApp: true }), 'none');
		}
		assert.equal(contextMenuFor(inside('<p>text</p>', 'p'), { modalOpen: false, inApp: true }), 'document');
	});

	test('text fields keep the webview edit menu so paste stays reachable', () => {
		for (const html of ['<input>', '<textarea></textarea>', '<div contenteditable="true"><span>x</span></div>']) {
			const target = inside(html, 'input, textarea, span');
			assert.equal(contextMenuFor(target, { modalOpen: false, inApp: true }), 'native', html);
		}
	});
});
