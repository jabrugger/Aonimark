import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { getSupportedLanguages, type LanguageCode, t, type Translation, type TranslationKey } from '../src/lib/utils/i18n.js';
import { translations } from './allTranslations.js';

describe('translation coverage', () => {
	const languages = getSupportedLanguages().map((l) => l.code) as LanguageCode[];

	// ---------------------------------------------------------------- dictionary

	function flatten(node: Translation, prefix = ''): Map<string, string> {
		const out = new Map<string, string>();
		for (const [key, value] of Object.entries(node)) {
			const path = prefix ? `${prefix}.${key}` : key;
			if (typeof value === 'string') out.set(path, value);
			else for (const [k, v] of flatten(value, path)) out.set(k, v);
		}
		return out;
	}

	const dictionaries = new Map<LanguageCode, Map<string, string>>(
		languages.map((lang) => [lang, flatten(translations[lang])]),
	);
	const english = dictionaries.get('en')!;

	test('no language defines a key English does not have', () => {
		// A translation filed one level away from where the code reads it is
		// invisible: `settings.colors.blue` can never be reached by t('colors.blue').
		// Since every reachable key must exist in English, "exists somewhere but not
		// in English" is exactly the set of unreachable translations.
		const orphans = new Map<string, string[]>();
		for (const lang of languages) {
			if (lang === 'en') continue;
			for (const key of dictionaries.get(lang)!.keys()) {
				if (english.has(key)) continue;
				orphans.set(key, [...(orphans.get(key) ?? []), lang]);
			}
		}

		assert.equal(
			orphans.size,
			0,
			`translations that no code path can reach (present in a locale, absent in English):\n${[...orphans]
				.map(([key, langs]) => `  ${key}  [${langs.length}] ${langs.join(', ')}`)
				.join('\n')}`,
		);
	});

	test('t() never echoes a key back for a reachable string', () => {
		// TitleBar called t('common.save'), which no language defines, so the button
		// read "common.save". The key type now refuses that call; this states the
		// end result through t() itself: every key English defines renders as text
		// in every language, either its own translation or the English fallback.
		for (const key of english.keys()) {
			for (const lang of languages) {
				const value = t(key as TranslationKey, lang);
				assert.notEqual(value, key, `t('${key}', '${lang}') renders the key itself`);
				assert.ok(value.length > 0, `t('${key}', '${lang}') is empty`);
			}
		}
	});

	test('per-locale completeness (reported, never enforced)', () => {
		// A worklist for translators, not a gate. Adding an English key must not
		// turn 25 locales red.
		const rows = languages
			.filter((lang) => lang !== 'en')
			.map((lang) => {
				const own = dictionaries.get(lang)!;
				const missing = [...english.keys()].filter((key) => !own.has(key));
				return { lang, missing: missing.length };
			})
			.sort((a, b) => b.missing - a.missing);

		const total = rows.reduce((sum, row) => sum + row.missing, 0);
		console.log(`\n  i18n coverage — ${english.size} English keys, 25 other locales`);
		for (const { lang, missing } of rows) {
			const pct = (((english.size - missing) / english.size) * 100).toFixed(1);
			console.log(`    ${lang.padEnd(6)} ${String(english.size - missing).padStart(3)}/${english.size}  ${pct.padStart(5)}%  ${missing} missing`);
		}
		console.log(`    ${'total'.padEnd(6)} ${total} untranslated key-slots (falling back to English)\n`);

		// No assertion, deliberately. `total` is a sum of array lengths, so the
		// `assert.ok(total >= 0)` that used to close this block was true for every
		// possible dictionary — it read as a gate while enforcing nothing. The gates
		// are the two tests above: every key the source asks for exists in English,
		// and no language defines a key English does not have. Completeness per
		// locale stays a worklist.
	});
});
