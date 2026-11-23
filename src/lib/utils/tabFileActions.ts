import type { TranslationKey } from './i18n.js';

type TabFileActionId = 'copy-path' | 'open-location';

type TabFileAction = {
	id: TabFileActionId;
	labelKey: TranslationKey;
	disabled: boolean;
};

/** True when `path` names a file on disk — false for an untitled buffer. */
export function hasRealFilePath(path: string): boolean {
	return path !== '';
}

