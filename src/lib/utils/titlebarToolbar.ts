import { hasMarkdownLinkExtension } from './markdownLinks.js';

type TitlebarActionContext = {
	hasActiveTab: boolean;
	currentFile: string;
	zoomLevel?: number;
};

/** The actions that sit in the title bar itself; the rest live in its menu. */
const BAR_ACTION_IDS = new Set(['reload', 'live']);

/**
 * The title bar actions that apply right now, split by where they sit.
 *
 * Reload and auto-reload only mean something for a file on disk, which an
 * external writer can change; the zoom reset only when zoom is not 100%.
 */
export function titlebarActionIds(context: TitlebarActionContext): { barIds: string[]; menuIds: string[] } {
	const ids: string[] = [];

	if (context.hasActiveTab) {
		if (context.currentFile) ids.push('reload');
		// An unsaved buffer has no name to read an extension off, and is treated as Markdown.
		const isMarkdown = context.currentFile ? hasMarkdownLinkExtension(context.currentFile) : true;
		if (isMarkdown && context.currentFile) ids.push('live');
		ids.push('zen');
	}

	if (context.zoomLevel && context.zoomLevel !== 100) ids.push('zoom');
	ids.push('theme', 'settings');

	return {
		barIds: ids.filter((id) => BAR_ACTION_IDS.has(id)),
		menuIds: ids.filter((id) => !BAR_ACTION_IDS.has(id)),
	};
}
