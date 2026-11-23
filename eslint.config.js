// Aonimark's code conventions, as lint rules (`npm run lint`).
//
// This config turns on no style preset. Every rule below is a convention the
// app depends on that no type can express: a second copy of a fixed behaviour,
// a call that must go through one wrapper, a defect shape that must not come
// back. Each message says why.
//
// The rules are `no-restricted-syntax` selectors, but not the built-in rule. In
// a flat config a later block REPLACES an earlier block's options for the same
// rule, so two conventions covering MarkdownViewer.svelte would silently drop
// one of them. `convention()` builds one rule per convention instead, so each
// keeps its own files, its own exceptions and its own name in the report.
// Selectors run on the TypeScript AST and, in `.svelte` files, on the template
// AST of svelte-eslint-parser (`SvelteMustacheTag`, `SvelteLiteral`, ...), so
// comments and prose never match.
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

/**
 * @typedef {object} Convention
 * @property {string[]} [files] globs, default every source file under src/
 * @property {string[]} [ignores] files the convention allows
 * @property {Record<string, string>} [ban] selector -> message, reported on every match
 * @property {Record<string, [number, string]>} [atMost] selector -> [n, message], reported past the nth match in a file
 * @property {{ call: string, earlier: string, message: string }} [requireEarlier]
 *   every call of `call` needs a call of `earlier` before it in the same function
 *   (callbacks passed as arguments count as part of the function around them)
 * @property {import('eslint').Rule.RuleModule} [custom] a rule of its own, for what a selector cannot say
 */

/**
 * @param {Convention} c
 * @returns {import('eslint').Rule.RuleModule}
 */
function convention(c) {
	return {
		meta: { type: 'problem', schema: [] },
		create(context) {
			/** @type {Record<string, (node: any) => void>} */
			const visitors = {};
			for (const [selector, message] of Object.entries(c.ban ?? {})) {
				visitors[selector] = (node) => context.report({ node, message });
			}
			for (const [selector, [n, message]] of Object.entries(c.atMost ?? {})) {
				let seen = 0;
				visitors[selector] = (node) => {
					if (++seen > n) context.report({ node, message });
				};
			}
			if (c.requireEarlier) {
				const { call, earlier, message } = c.requireEarlier;
				/** @type {(node: any, name: string) => boolean} */
				const named = (node, name) => node.callee.name === name || node.callee.property?.name === name;
				/** @type {(node: any) => boolean} */
				const isFunction = (node) => /Function/.test(node.type) && node.parent.type !== 'CallExpression';
				/** @type {number[]} */
				const earlierStarts = [];
				visitors.CallExpression = (/** @type {any} */ node) => {
					if (named(node, earlier)) earlierStarts.push(node.range[0]);
					if (!named(node, call)) return;
					const fn = context.sourceCode.getAncestors(node).findLast(isFunction);
					const from = fn?.range?.[0] ?? 0;
					if (!earlierStarts.some((start) => start >= from && start < node.range[0])) {
						context.report({ node, message });
					}
				};
			}
			return visitors;
		},
	};
}

/** `aria-valuemin={X_RANGE.min}` next to `aria-valuemax={X_RANGE.max}`, the same X_RANGE. */
/** @type {import('eslint').Rule.RuleModule} */
const ariaRange = {
	meta: { type: 'problem', schema: [] },
	create(context) {
		/** @type {(attr: any, end: string) => string | null} */
		const range = (attr, end) => {
			const [value] = attr?.value ?? [];
			const e = attr?.value.length === 1 && value.type === 'SvelteMustacheTag' ? value.expression : null;
			return e?.type === 'MemberExpression' && e.property.name === end && /_RANGE$/.test(e.object.name ?? '')
				? e.object.name
				: null;
		};
		return {
			/** @param {any} node */
			SvelteStartTag(node) {
				/** @type {(name: string) => any} */
				const attr = (name) => node.attributes.find((/** @type {any} */ a) => a.type === 'SvelteAttribute' && a.key.name === name);
				const min = attr('aria-valuemin');
				const max = attr('aria-valuemax');
				if (!min && !max) return;
				const name = range(min, 'min');
				if (!name || range(max, 'max') !== name) {
					context.report({
						node,
						message:
							"aria-valuemin/max is the bound assistive tech reports; advertise the setting's own *_RANGE.min/.max " +
							'(the one the store clamps against), not numbers of its own, so the two cannot drift.',
					});
				}
			},
		};
	},
};

const VIEWER = 'src/lib/MarkdownViewer.svelte';
const BINDINGS = 'src/lib/bindings.ts';
const SANITIZER_FILES = ['src/lib/utils/richContent.ts', 'src/lib/utils/sanitize.ts'];
const callOf = (/** @type {string} */ name) => `CallExpression[callee.name='${name}'], CallExpression[callee.property.name='${name}']`;
const command = (/** @type {string} */ name) => `CallExpression[callee.object.name='commands'][callee.property.name='${name}']`;

/** @type {Record<string, Convention>} */
const CONVENTIONS = {
	// ------------------------------------------------------------ Tauri boundary
	'tauri-through-bindings': {
		ignores: [BINDINGS, 'src/lib/windowEvents.ts'],
		ban: {
			"ImportDeclaration[source.value=/^@tauri-apps\\/api\\/(core|event)$/] > ImportSpecifier[imported.name=/^(invoke|listen|once|emit|emitTo)$/]":
				'Call Rust through the generated `commands.*` and listen to Rust events through `events.*` (src/lib/bindings.ts): ' +
				'a raw invoke/listen names the command or event by a string tsc cannot check. Events between windows go through src/lib/windowEvents.ts.',
		},
	},

	// ------------------------------------------------------------------ documents
	'live-mode-toggle-does-not-reload': {
		files: [VIEWER],
		ban: {
			"FunctionDeclaration[id.name='toggleLiveMode'] CallExpression[callee.name='loadMarkdown']":
				'Turning Live Mode on is not a request to discard the buffer; reloading here skips canCloseTab.',
		},
	},
	'open-dialog-uses-the-extension-list': {
		ignores: [BINDINGS],
		ban: {
			"Property[key.name='extensions'] > ArrayExpression:has(> Literal[value='md'])":
				'A literal extension list drifts from the one Aonimark treats as documents; use MARKDOWN_OPEN_FILTERS (utils/markdownLinks.ts).',
		},
	},
	'save-content-cancels-auto-save-itself': {
		ban: {
			[`ExpressionStatement:has(> :matches(${callOf('cancelPendingAutoSave')})) + :matches(ExpressionStatement, VariableDeclaration, ReturnStatement):has(${callOf('saveContent')})`]:
				'saveContent already cancels the pending auto-save; pairing a manual cancel with it moves the duty back to the call sites, where the next one forgets it.',
		},
	},
	'only-the-revert-commands-discard-a-buffer': {
		ignores: ['src/lib/sessions/externalChange.svelte.ts'],
		ban: {
			"Property[key.name='discardUnsavedBuffer'][value.value=true]":
				'Only the two revert commands (Reload on the conflict bar, Reload from disk) may say the user chose to lose work.',
		},
	},




	// --------------------------------------------------------------------- editor
	'settings-os-type-is-written-by-the-store': {
		ignores: ['src/lib/stores/settings.svelte.ts'],
		ban: {
			"AssignmentExpression[left.object.name='settings'][left.property.name='osType']":
				'settings.osType is filled in by the store from get_os_type; ask platformOf() instead of writing it.',
		},
	},


	// ------------------------------------------------- single implementations
	'one-language-catalogue': {
		ignores: ['src/lib/utils/i18n.ts'],
		ban: {
			"Property[key.name='nativeName']":
				'The language catalogue is getSupportedLanguages() in utils/i18n.ts; a second table drifted from it.',
			"TSTypeAliasDeclaration[id.name='LanguageCode']":
				'LanguageCode is declared once (utils/i18n.ts); two unions type-check against each other only while they agree.',
		},
	},
	'local-storage-writes-through-the-store': {
		ignores: ['src/lib/stores/settings.svelte.ts'],
		ban: {
			"CallExpression[callee.object.name='localStorage'][callee.property.name='setItem']":
				'A bare setItem is the write no other window hears and no range validates; use writeStoredSetting (stores/settings.svelte.ts).',
		},
	},
	'one-platform-probe': {
		ignores: ['src/lib/utils/platform.ts'],
		ban: {
			"MemberExpression[object.name='navigator'][property.name=/^(userAgent|platform)$/]":
				'platformOf (utils/platform.ts) is the one platform answer; a second probe disagreed with settings.osType at startup.',
		},
	},
	'one-modifier-decision': {
		ignores: ['src/lib/utils/shortcuts.ts', 'src/lib/utils/platform.ts'],
		ban: {
			"ConditionalExpression[test.operator='==='][test.right.value='macos'], ConditionalExpression[consequent.value='Cmd'][alternate.value='Ctrl']":
				'Use modifierFor() / platformOf(): a hand-written Cmd-or-Ctrl copy cannot pick up what the helper learns.',
		},
	},
	'translations-are-one-literal': {
		ignores: [BINDINGS],
		ban: {
			"CallExpression[callee.object.name='Object'][callee.property.name='assign'], AssignmentExpression > MemberExpression.left Identifier[name='translations']":
				'The dictionary is one literal; a merged second table made duplicate keys win silently. Add keys to the table itself.',
		},
	},
	'aria-range': { custom: ariaRange },

	// -------------------------------------------------------------------- settings
	'font-preferences-are-quoted': {
		files: [VIEWER, 'src/lib/utils/editorOptions.ts'],
		ban: {
			"SvelteLiteral[value=/(font-family|--code-font):\\s*$/] + SvelteMustacheTag[expression.object.name='settings']":
				'A font preference reaches CSS through fontFamilyValue (utils/fontFamily.ts), quoted.',
			"Property[key.name='fontFamily'] > MemberExpression.value[object.name='settings']":
				'A font preference reaches Monaco through fontFamilyValue (utils/fontFamily.ts), quoted.',
		},
	},
	't-requires-a-language': {
		files: ['src/lib/utils/i18n.ts'],
		ban: {
			"FunctionDeclaration[id.name='t'] > AssignmentPattern.params":
				'A default language made 9 call sites show English in all 26 languages; keep `lang` required.',
		},
	},
	'toasts-are-translated': {
		ban: {
			"CallExpression[callee.name='addToast'] > Literal:first-child, CallExpression[callee.name='addToast'] > :matches(TemplateLiteral, BinaryExpression):first-child:not(:has(CallExpression[callee.name='t']))":
				'Toast text that never goes through t() reads English in all 26 languages.',
		},
	},
	'one-startup-theme-writer': {
		ignores: [VIEWER],
		ban: {
			[command('saveTheme')]: 'save_theme has one caller (MarkdownViewer.svelte), so nothing can send it a raw theme name.',
		},
	},
	'viewer-keeps-no-theme': {
		files: [VIEWER],
		ban: {
			"VariableDeclarator[id.name='theme'][init.callee.name='$state']":
				'The viewer keeps no theme of its own beside the settings store.',
		},
		atMost: {
			[command('saveTheme')]: [1, 'save_theme has one caller, so nothing can send it a raw theme name.'],
		},
	},

	// ------------------------------------------------------------------ shortcuts
	'toolbar-chords-from-the-registry': {
		files: ['src/lib/utils/editorToolbar.ts'],
		ban: {
			"TemplateLiteral:has(> TemplateElement[value.raw=/^\\+/])":
				'A chord literal in the toolbar; it belongs in shortcuts.ts, read back with shortcutLabel().',
		},
	},
	'menu-chords-from-the-registry': {
		files: ['src/lib/components/TitleBar.svelte'],
		ban: {
			"SvelteElement[name.name='span']:has(SvelteAttribute[key.name='class'] > SvelteLiteral[value=/(^|\\s)menu-shortcut(\\s|$)/]) > :matches(SvelteText[value=/\\S/], SvelteMustacheTag:not(:has(CallExpression[callee.name=/^(shortcutLabel|t)$/])))":
				'Every menu shortcut comes from shortcutLabel(); a hand-written chord is wrong on one platform.',
		},
	},
	'no-hand-written-chords': {
		ignores: ['src/lib/utils/shortcuts.ts'],
		ban: {
			[[
				'Literal',
				'TemplateElement',
				'SvelteText',
				'SvelteLiteral',
			]
				.map((type) => `${type}[${type === 'TemplateElement' ? 'value.raw' : 'value'}=/\\b(Ctrl|Cmd|Command|Meta|Super)\\+((Shift|Alt|Option|Ctrl|Cmd)\\+)*[A-Za-z0-9\\\\\\[\\]\`.=-]/]`)
				.join(', ')]:
				'A keyboard chord written by hand; it belongs in src/lib/utils/shortcuts.ts, read back with shortcutLabel(id, modifierFor(settings.osType)) so macOS reads Cmd.',
		},
	},


	// ---------------------------------------------------------------- test suite
	'tests-read-through-source-tree': {
		files: ['scripts/**/*.ts'],
		ignores: ['scripts/sourceTree.ts'],
		ban: {
			"CallExpression[callee.name=/^(readFileSync|readdirSync)$/], CallExpression[callee.property.name=/^(readFileSync|readdirSync)$/]":
				'Read with readSource / walkSourceFiles (scripts/sourceTree.ts): they decide the line ending and path separator once, so a Windows checkout does not go red (#452).',
		},
	},
};

const SOURCE = ['src/**/*.{ts,js,svelte}'];

export default [
	{ ignores: ['.svelte-kit/**', 'build/**', 'node_modules/**', 'src-tauri/**', 'static/**'] },
	...svelte.configs.base,
	{
		files: ['**/*.ts', '**/*.js', '**/*.mjs'],
		languageOptions: { parser: tseslint.parser },
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: { parserOptions: { parser: tseslint.parser } },
	},
	{
		linterOptions: { reportUnusedDisableDirectives: 'error' },
		plugins: {
			aonimark: {
				rules: Object.fromEntries(
					Object.entries(CONVENTIONS).map(([name, c]) => [name, c.custom ?? convention(c)]),
				),
			},
		},
	},
	...Object.entries(CONVENTIONS).map(([name, c]) => ({
		files: c.files ?? SOURCE,
		ignores: c.ignores ?? [],
		rules: { [`aonimark/${name}`]: 'error' },
	})),
];
