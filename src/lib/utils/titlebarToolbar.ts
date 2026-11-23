import { hasMarkdownLinkExtension } from './markdownLinks.js';
import { applyMove, getAdjacentMove, getReorderMove, type ToolbarMove } from './toolbarMove.js';
import type { TranslationKey } from './i18n.js';

export type TitlebarToolbarPlacement = 'bar' | 'menu';

type TitlebarToolbarAction = {
	id: string;
	labelKey: TranslationKey;
	fallbackName: string;
	sample: string;
	defaultPlacement: TitlebarToolbarPlacement;
	required?: boolean;
	// Second line in Settings: when the button shows (see
	// visibleTitlebarActionIds).
	hintKey?: TranslationKey;
};

type ConfiguredTitlebarToolbarIds = {
	visibleIds: string[];
	barIds: string[];
	menuIds: string[];
};

const TITLEBAR_TOOLBAR_ACTIONS: TitlebarToolbarAction[] = [
	{ id: 'reload', labelKey: 'tooltip.reloadFromDisk', fallbackName: 'Reload from Disk', sample: 'R', defaultPlacement: 'bar', hintKey: 'settings.toolbarDiskFileOnly' },
	{ id: 'live', labelKey: 'menu.autoReload', fallbackName: 'Auto-Reload', sample: 'L', defaultPlacement: 'bar', hintKey: 'settings.toolbarDiskFileOnly' },
	{ id: 'zen', labelKey: 'menu.zenMode', fallbackName: 'Zen Mode', sample: 'Z', defaultPlacement: 'menu' },
	{ id: 'zoom', labelKey: 'tooltip.resetZoom', fallbackName: 'Reset Zoom', sample: '%', defaultPlacement: 'menu', hintKey: 'settings.toolbarZoomedOnly' },
	{ id: 'theme', labelKey: 'menu.changeTheme', fallbackName: 'Change Theme', sample: 'A', defaultPlacement: 'menu' },
	{ id: 'settings', labelKey: 'tooltip.settings', fallbackName: 'Settings', sample: '...', defaultPlacement: 'menu', required: true },
];

export const DEFAULT_TITLEBAR_TOOLBAR_ORDER = TITLEBAR_TOOLBAR_ACTIONS.map((action) => action.id);

export const DEFAULT_TITLEBAR_TOOLBAR_PLACEMENT = TITLEBAR_TOOLBAR_ACTIONS.reduce<Record<string, TitlebarToolbarPlacement>>(
	(result, action) => {
		result[action.id] = action.defaultPlacement;
		return result;
	},
	{},
);

const knownToolbarIds = new Set(DEFAULT_TITLEBAR_TOOLBAR_ORDER);

export type ViewMode = 'preview' | 'split' | 'edit';

export function viewModeOf(tab: { isEditing: boolean; isSplit: boolean }): ViewMode {
	if (tab.isSplit) return 'split';
	return tab.isEditing ? 'edit' : 'preview';
}
const requiredToolbarIds = new Set(TITLEBAR_TOOLBAR_ACTIONS.filter((action) => action.required).map((action) => action.id));

export function normalizeTitlebarToolbarOrder(order: readonly string[] | null | undefined): string[] {
	const normalized: string[] = [];

	for (const id of order ?? []) {
		if (!knownToolbarIds.has(id) || normalized.includes(id)) continue;
		normalized.push(id);
	}

	for (const id of DEFAULT_TITLEBAR_TOOLBAR_ORDER) {
		if (!normalized.includes(id)) normalized.push(id);
	}

	return normalized;
}

export function normalizeTitlebarToolbarHidden(hidden: readonly string[] | null | undefined): string[] {
	const normalized: string[] = [];
	for (const id of hidden ?? []) {
		if (!knownToolbarIds.has(id) || requiredToolbarIds.has(id) || normalized.includes(id)) continue;
		normalized.push(id);
	}

	return normalized;
}

export function normalizeTitlebarToolbarPlacement(
	placement: Record<string, unknown> | null | undefined,
): Record<string, TitlebarToolbarPlacement> {
	const normalized = { ...DEFAULT_TITLEBAR_TOOLBAR_PLACEMENT };

	for (const [id, value] of Object.entries(placement ?? {})) {
		if (!knownToolbarIds.has(id)) continue;
		if (value !== 'bar' && value !== 'menu') continue;
		normalized[id] = value;
	}

	return normalized;
}

export function getTitlebarToolbarActions(order: readonly string[] | null | undefined): TitlebarToolbarAction[] {
	const byId = new Map(TITLEBAR_TOOLBAR_ACTIONS.map((action) => [action.id, action]));
	return normalizeTitlebarToolbarOrder(order).map((id) => byId.get(id)!).filter(Boolean);
}

export function getTitlebarToolbarReorderMove(
	order: readonly string[],
	draggedId: string,
	targetId: string,
): ToolbarMove | null {
	return getReorderMove(normalizeTitlebarToolbarOrder(order), draggedId, targetId);
}

export function getTitlebarToolbarAdjacentMove(
	order: readonly string[],
	id: string,
	direction: 'up' | 'down',
): ToolbarMove | null {
	return getAdjacentMove(normalizeTitlebarToolbarOrder(order), id, direction);
}

export function applyTitlebarToolbarMove(order: readonly string[], move: ToolbarMove): string[] {
	return applyMove(normalizeTitlebarToolbarOrder(order), move);
}

export type TitlebarActionContext = {
	hasActiveTab: boolean;
	currentFile: string;
	zoomLevel?: number;
};

/**
 * Which actions the current document offers, before the user's own order,
 * hiding and bar/menu placement are applied to them.
 *
 * This used to be a `$derived.by` inside TitleBar.svelte, where nothing could
 * call it — and one of its conditions was wrong for as long as that was true.
 * The Auto-Reload button was drawn only in the preview (`!isEditing`,
 * `!isSplit`) while its chord, Mod+L, was only an `editorAction` in
 * shortcuts.ts and therefore only on Monaco, which exists only in the other
 * two modes. The two surfaces of one feature never both applied, and the
 * shortcut panel advertised the chord in all three regardless. Editing a file
 * that another program also writes — the case auto-reload is for — got the
 * chord and no indicator.
 *
 * Its output already fed `getConfiguredTitlebarToolbarIds` below, so this is
 * the first half of a pipeline moving next to the second, not a new layer.
 */
export function visibleTitlebarActionIds(context: TitlebarActionContext): string[] {
	const list: string[] = [];

	if (context.hasActiveTab) {
		if (context.currentFile) list.push('reload');

		// An unsaved buffer has no name to read an extension off, and is
		// treated as Markdown — which is what the old inline default of `'md'`
		// said, spelled as the condition it actually is.
		const isMarkdown = context.currentFile
			? hasMarkdownLinkExtension(context.currentFile)
			: true;

		if (isMarkdown && context.currentFile) {
			// A file on disk is one an external writer can surprise.
			list.push('live');
		}
		list.push('zen');
	}

	if (context.zoomLevel && context.zoomLevel !== 100) list.push('zoom');
	list.push('theme');
	list.push('settings');

	return list;
}

export function getConfiguredTitlebarToolbarIds(
	availableIds: readonly string[],
	order: readonly string[] | null | undefined,
	hidden: readonly string[] | null | undefined,
	placement: Record<string, unknown> | null | undefined,
): ConfiguredTitlebarToolbarIds {
	const available = new Set(availableIds.filter((id) => knownToolbarIds.has(id)));
	const hiddenIds = new Set(normalizeTitlebarToolbarHidden(hidden));
	const normalizedPlacement = normalizeTitlebarToolbarPlacement(placement);
	const visibleIds = normalizeTitlebarToolbarOrder(order).filter((id) => available.has(id) && !hiddenIds.has(id));

	return {
		visibleIds,
		barIds: visibleIds.filter((id) => normalizedPlacement[id] === 'bar'),
		menuIds: visibleIds.filter((id) => normalizedPlacement[id] === 'menu'),
	};
}
