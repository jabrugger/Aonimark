import type { Appearance } from '../bindings.js';
import type { ThemeSetting } from '../stores/settings.svelte.js';

/**
 * Applies the theme setting to the document whenever it changes, and tells
 * Rust the appearance to paint the next window's background from. Call during
 * component init. Persistence belongs to the settings store; this is only the
 * part that cannot: applying the theme to the document.
 */
export function followTheme(getTheme: () => ThemeSetting, saveStartupAppearance: (appearance: Appearance) => void): void {
	$effect(() => {
		const theme = getTheme();
		if (theme === 'system') {
			delete document.documentElement.dataset.theme;
		} else {
			document.documentElement.dataset.theme = theme;
		}
		saveStartupAppearance(theme);
	});
}
