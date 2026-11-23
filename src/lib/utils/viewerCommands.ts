import type { ViewerCommand } from './viewerKeymap.js';

/**
 * What the viewer hands the command table: the settings and tabs it mutates,
 * and the component's own functions for everything else. Read at run time, so
 * `tabManager.activeTabId` is the active tab when the key is pressed.
 */
export type ViewerCommandHost = {
	settings: {
		toggleZenMode(): void;
		zoomIn(): void;
		zoomOut(): void;
		resetZoom(): void;
	};
	reloadFromDisk(): unknown;
	closeFile(): unknown;
	handleNewFile(): unknown;
	selectFile(): unknown;
	appExit(): unknown;
	toggleLiveMode(): unknown;
	saveContentAs(): unknown;
	saveActiveTab(): unknown;
	openSettings(): void;
	openFileLocation(): unknown;
};

/**
 * `viewerKeymap.ts` decides which command a keystroke means. This maps each
 * command to what runs it. A `Record` over the union, so a command with no
 * entry does not compile.
 */
export function viewerCommandTable(host: ViewerCommandHost): Record<ViewerCommand, () => void> {
	const { settings } = host;
	return {
		'reload-from-disk': () => void host.reloadFromDisk(),
		'close-file': () => void host.closeFile(),
		'new-file': () => void host.handleNewFile(),
		'open-file': () => void host.selectFile(),
		'app-exit': () => void host.appExit(),
		'toggle-live-mode': () => void host.toggleLiveMode(),
		'toggle-zen-mode': () => settings.toggleZenMode(),
		'save-as': () => void host.saveContentAs(),
		// Save from any mode; see `saveActiveTab`.
		save: () => void host.saveActiveTab(),
		'zoom-in': () => settings.zoomIn(),
		'zoom-out': () => settings.zoomOut(),
		'zoom-reset': () => settings.resetZoom(),
		'open-settings': () => host.openSettings(),
		'reveal-file': () => void host.openFileLocation(),
	};
}
