/**
 * The title bar's three popovers — the menu, the theme picker and the overflow
 * menu — and the window-level dismissal they share.
 */
export class TitleBarPopovers {
	themeMenuOpen = $state(false);
	kebabMenuOpen = $state(false);
	homeMenuOpen = $state(false);

	get anyOpen(): boolean {
		return this.themeMenuOpen || this.kebabMenuOpen || this.homeMenuOpen;
	}

	/** Closes every menu. */
	dismiss = () => {
		this.themeMenuOpen = false;
		this.kebabMenuOpen = false;
		this.homeMenuOpen = false;
	};

	/**
	 * Run inside an `$effect`: while any popover is open, a click, a context
	 * menu or the window losing focus dismisses it. The returned teardown takes
	 * the listeners off again.
	 */
	listenForDismiss(target: EventTarget): () => void {
		const types = ['click', 'contextmenu', 'blur'];
		if (this.anyOpen) for (const type of types) target.addEventListener(type, this.dismiss);
		return () => {
			for (const type of types) target.removeEventListener(type, this.dismiss);
		};
	}
}

/**
 * A popover's own clicks stay inside it: without this, picking an item in the
 * menu would reach the window listener and dismiss the popover it was made in.
 */
export function containClick(event: Event) {
	event.stopPropagation();
}
