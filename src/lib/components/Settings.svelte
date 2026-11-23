<script lang="ts">
	import { openUrl } from '@tauri-apps/plugin-opener';
	import { getVersion } from '@tauri-apps/api/app';
	import { fade, scale } from 'svelte/transition';
	import { settings, resolveTheme, type ThemeSetting } from '../stores/settings.svelte.js';
	import { updateStore } from '../stores/update.svelte.js';
	import { t, getSupportedLanguages, type LanguageCode } from '../utils/i18n.js';

	let {
		show = false,
		theme = 'system',
		onSetTheme,
		onclose,
	} = $props<{ show?: boolean; theme?: ThemeSetting; onSetTheme?: (t: ThemeSetting) => void; onclose: () => void }>();

	const REPOSITORY_URL = 'https://github.com/jabrugger/Markpad-Neo';

	let modal = $state<HTMLDivElement>();
	let appVersion = $state('');

	$effect(() => {
		if (!show) return;
		getVersion().then((v) => (appVersion = v)).catch(console.error);
		const previous = document.activeElement as HTMLElement | null;
		modal?.querySelector<HTMLElement>('select, input, button')?.focus();
		return () => previous?.focus();
	});

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
			return;
		}
		if (e.key !== 'Tab' || !modal) return;
		const focusable = modal.querySelectorAll<HTMLElement>('button, input, select');
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}
</script>

{#if show}
	<div class="settings-backdrop" transition:fade={{ duration: 150 }} role="presentation">
		<div
			class="settings-modal"
			bind:this={modal}
			transition:scale={{ duration: 200, start: 0.95 }}
			role="dialog"
			aria-modal="true"
			aria-labelledby="settings-title"
			tabindex="-1"
			{onkeydown}>
			<div class="settings-header">
				<h1 id="settings-title">{t('settings.title', settings.language)}</h1>
				<button class="close-btn" onclick={onclose} aria-label={t('common.close', settings.language)}>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
						<line x1="18" y1="6" x2="6" y2="18"></line>
						<line x1="6" y1="6" x2="18" y2="18"></line>
					</svg>
				</button>
			</div>

			<div class="settings-body">
				<div class="setting-item">
					<label for="setting-language">{t('settings.language', settings.language)}</label>
					<select id="setting-language" value={settings.language} onchange={(e) => (settings.language = e.currentTarget.value as LanguageCode)}>
						{#each getSupportedLanguages() as lang (lang.code)}
							<option value={lang.code}>{lang.nativeName}</option>
						{/each}
					</select>
				</div>

				<div class="setting-item">
					<label for="setting-theme">{t('settings.theme', settings.language)}</label>
					<select id="setting-theme" value={theme} onchange={(e) => onSetTheme?.(resolveTheme(e.currentTarget.value))}>
						<option value="system">{t('settings.themeFollowSystem', settings.language)}</option>
						<option value="light">{t('settings.themeDefaultLight', settings.language)}</option>
						<option value="dark">{t('settings.themeDefaultDark', settings.language)}</option>
					</select>
				</div>

				<div class="setting-item">
					<label for="setting-auto-save">{t('settings.autoSave', settings.language)}</label>
					<input id="setting-auto-save" type="checkbox" bind:checked={settings.autoSave} />
				</div>

				<div class="setting-item" title={t('settings.restoreStateOnReopenHint', settings.language)}>
					<label for="setting-restore">{t('settings.restoreStateOnReopen', settings.language)}</label>
					<input id="setting-restore" type="checkbox" bind:checked={settings.restoreStateOnReopen} />
				</div>

				<div class="setting-item" title={t('settings.persistOpenEditorsHint', settings.language)}>
					<label for="setting-recovery">{t('settings.persistOpenEditors', settings.language)}</label>
					<input id="setting-recovery" type="checkbox" bind:checked={settings.persistOpenEditors} />
				</div>
			</div>

			<div class="settings-footer">
				<button class="footer-btn" onclick={() => updateStore.openDialog()}>
					{t('menu.checkForUpdates', settings.language)}
				</button>
				<button class="footer-btn" onclick={() => openUrl(REPOSITORY_URL).catch(() => window.open(REPOSITORY_URL, '_blank'))}>
					{t('menu.github', settings.language)}{appVersion ? ` · v${appVersion}` : ''}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.settings-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.4);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 10000;
	}

	.settings-modal {
		background: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3);
		box-sizing: border-box;
		width: min(440px, 90vw);
		max-height: 90vh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		font-family: var(--win-font);
		color: var(--color-fg-default);
	}

	.settings-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid var(--color-border-default);
	}

	.settings-header h1 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}

	.close-btn,
	.footer-btn {
		background: transparent;
		border: none;
		color: var(--color-fg-muted);
		cursor: pointer;
		border-radius: 4px;
	}

	.close-btn {
		display: flex;
		padding: 4px;
	}

	.footer-btn {
		padding: 6px 10px;
		font: inherit;
		font-size: 12px;
	}

	.close-btn:hover,
	.footer-btn:hover {
		background: var(--color-neutral-muted);
		color: var(--color-fg-default);
	}

	.settings-body {
		padding: 8px 16px;
		overflow-y: auto;
	}

	.setting-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 10px 0;
		font-size: 13px;
	}

	.setting-item select {
		min-width: 160px;
		padding: 4px 8px;
		background: var(--color-canvas-subtle);
		color: var(--color-fg-default);
		border: 1px solid var(--color-border-default);
		border-radius: 4px;
		font: inherit;
	}

	.settings-footer {
		display: flex;
		justify-content: space-between;
		padding: 8px 12px;
		border-top: 1px solid var(--color-border-default);
	}
</style>
