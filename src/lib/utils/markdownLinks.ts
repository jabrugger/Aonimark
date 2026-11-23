/** The extensions the app opens as a document. */
export const MARKDOWN_LINK_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd', 'txt'];

/** The Open dialog's filters. */
export const MARKDOWN_OPEN_FILTERS = [
	{ name: 'Markdown', extensions: MARKDOWN_LINK_EXTENSIONS },
	{ name: 'All Files', extensions: ['*'] },
];

const EXTENSION = new RegExp(`\\.(?:${MARKDOWN_LINK_EXTENSIONS.join('|')})$`, 'i');

export function hasMarkdownLinkExtension(path: string): boolean {
	return EXTENSION.test(path);
}
