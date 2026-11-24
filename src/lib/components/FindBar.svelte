<script lang="ts">
	import { t, type LanguageCode } from '../utils/i18n.js';

	let {
		query = $bindable(''),
		replacement = $bindable(''),
		matchCase = $bindable(false),
		wholeWord = $bindable(false),
		showReplace = $bindable(false),
		status,
		language,
		onchange,
		onnext,
		onprevious,
		onreplace,
		onreplaceall,
		onclose,
	} = $props<{
		query: string;
		replacement: string;
		matchCase: boolean;
		wholeWord: boolean;
		showReplace: boolean;
		status: { total: number; current: number };
		language: LanguageCode;
		onchange: () => void;
		onnext: () => void;
		onprevious: () => void;
		onreplace: () => void;
		onreplaceall: () => void;
		onclose: () => void;
	}>();

	let findInput = $state<HTMLInputElement>();

	let counter = $derived(
		query === ''
			? ''
			: status.total === 0
				? t('find.noMatches', language)
				: t('find.matchCount', language)
						.replace('{{current}}', String(status.current))
						.replace('{{total}}', String(status.total)),
	);

	export function focus() {
		findInput?.focus();
		findInput?.select();
	}

	function handleFindKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			(e.shiftKey ? onprevious : onnext)();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		}
	}

	function handleReplaceKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			onreplace();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		}
	}

	function toggleMatchCase() {
		matchCase = !matchCase;
		onchange();
	}

	function toggleWholeWord() {
		wholeWord = !wholeWord;
		onchange();
	}
</script>

<div class="find-bar">
	<div class="row">
		<button
			type="button"
			class="icon chevron"
			class:expanded={showReplace}
			aria-label={t('find.toggleReplace', language)}
			title={t('find.toggleReplace', language)}
			aria-expanded={showReplace}
			onclick={() => (showReplace = !showReplace)}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
				<path d="M9 18l6-6-6-6" />
			</svg>
		</button>
		<input
			class="field"
			bind:this={findInput}
			value={query}
			placeholder={t('find.placeholder', language)}
			aria-label={t('find.placeholder', language)}
			spellcheck="false"
			oninput={(e) => {
				query = e.currentTarget.value;
				onchange();
			}}
			onkeydown={handleFindKeydown} />
		<span class="counter">{counter}</span>
		<button
			type="button"
			class="icon"
			aria-label={t('find.previous', language)}
			title={t('find.previous', language)}
			disabled={status.total === 0}
			onclick={onprevious}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
				<path d="M12 19V5M5 12l7-7 7 7" />
			</svg>
		</button>
		<button
			type="button"
			class="icon"
			aria-label={t('find.next', language)}
			title={t('find.next', language)}
			disabled={status.total === 0}
			onclick={onnext}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
				<path d="M12 5v14M19 12l-7 7-7-7" />
			</svg>
		</button>
		<button
			type="button"
			class="icon toggle"
			class:active={matchCase}
			aria-label={t('find.caseSensitive', language)}
			title={t('find.caseSensitive', language)}
			aria-pressed={matchCase}
			onclick={toggleMatchCase}>Aa</button>
		<button
			type="button"
			class="icon toggle"
			class:active={wholeWord}
			aria-label={t('find.wholeWord', language)}
			title={t('find.wholeWord', language)}
			aria-pressed={wholeWord}
			onclick={toggleWholeWord}><span class="underline">ab</span></button>
		<button
			type="button"
			class="icon"
			aria-label={t('find.close', language)}
			title={t('find.close', language)}
			onclick={onclose}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
				<path d="M18 6L6 18M6 6l12 12" />
			</svg>
		</button>
	</div>

	{#if showReplace}
		<div class="row replace-row">
			<input
				class="field"
				value={replacement}
				placeholder={t('find.replacePlaceholder', language)}
				aria-label={t('find.replacePlaceholder', language)}
				spellcheck="false"
				oninput={(e) => (replacement = e.currentTarget.value)}
				onkeydown={handleReplaceKeydown} />
			<button
				type="button"
				class="text"
				aria-label={t('find.replace', language)}
				title={t('find.replace', language)}
				disabled={status.total === 0 || query === ''}
				onclick={onreplace}>{t('find.replace', language)}</button>
			<button
				type="button"
				class="text"
				aria-label={t('find.replaceAll', language)}
				title={t('find.replaceAll', language)}
				disabled={status.total === 0 || query === ''}
				onclick={onreplaceall}>{t('find.replaceAll', language)}</button>
		</div>
	{/if}
</div>

<style>
	.find-bar {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex-shrink: 0;
		padding: 4px 8px;
		font-size: 13px;
		border-bottom: 1px solid var(--color-border-muted);
	}

	.row {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.replace-row {
		margin-left: 30px;
	}

	button {
		box-sizing: border-box;
		user-select: none;
		cursor: pointer;
	}

	.icon {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 26px;
		height: 26px;
		padding: 0;
		background: transparent;
		border: none;
		border-radius: 4px;
		color: var(--color-fg-default);
	}

	.icon:hover:not(:disabled) {
		background: var(--color-neutral-muted);
	}

	.icon:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.icon svg {
		width: 16px;
		height: 16px;
	}

	.chevron svg {
		transition: transform 0.1s;
	}

	.chevron.expanded svg {
		transform: rotate(90deg);
	}

	.toggle {
		font-size: 12px;
	}

	.toggle.active {
		border: 1px solid var(--color-accent-fg);
	}

	.underline {
		text-decoration: underline;
	}

	.field {
		box-sizing: border-box;
		flex-shrink: 1;
		height: 26px;
		width: 220px;
		max-width: 100%;
		padding: 0 6px;
		border: 1px solid var(--color-border-default);
		border-radius: 4px;
		background: var(--color-canvas-default);
		color: var(--color-fg-default);
		font-size: 13px;
		outline: none;
	}

	.field:focus {
		border-color: var(--color-accent-fg);
	}

	.counter {
		flex-shrink: 0;
		min-width: 64px;
		text-align: center;
		white-space: nowrap;
		color: var(--color-fg-muted);
		font-size: 12px;
	}

	.text {
		height: 26px;
		padding: 0 8px;
		background: transparent;
		border: 1px solid var(--color-border-default);
		border-radius: 4px;
		color: var(--color-fg-default);
		font-size: 12px;
	}

	.text:hover:not(:disabled) {
		background: var(--color-neutral-muted);
	}

	.text:disabled {
		opacity: 0.4;
		cursor: default;
	}
</style>
