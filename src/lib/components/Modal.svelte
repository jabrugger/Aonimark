<script lang="ts">
	import type { Snippet } from 'svelte';
	import Dialog from './Dialog.svelte';
	import { t } from '../utils/i18n.js';
	import { settings } from '../stores/settings.svelte.js';
	import { handleModalBackdropContextMenu } from '../utils/modalContextMenu.js';

	let {
		show,
		title,
		message,
		kind = 'info',
		showSave = false,
		showInput = false,
		inputValue = $bindable(''),
		confirmLabel,
		children,
		onkeydown,
		onconfirm,
		onsave,
		oncancel,
	} = $props<{
		show: boolean;
		title: string;
		message: string;
		kind?: 'info' | 'warning' | 'error';
		showSave?: boolean;
		showInput?: boolean;
		inputValue?: string;
		/**
		 * Names the confirm button after what the dialog is for ("Open"),
		 * instead of the Save/Discard pair the unsaved-changes prompt uses. A
		 * named action is the one the dialog exists to offer, so it is also
		 * the primary button, which is the one focused on open.
		 */
		confirmLabel?: string;
		/** Content under the message, such as the window list of the open-file picker. */
		children?: Snippet;
		/**
		 * Sees every key before the dialog's own handling, for keys that
		 * content in `children` owns, such as arrow keys in a list. Calling
		 * `preventDefault` stops the dialog from handling that key as well.
		 */
		onkeydown?: (e: KeyboardEvent) => void;
		onconfirm: () => void;
		onsave?: () => void;
		oncancel: () => void;
	}>();

	let inputElement = $state<HTMLInputElement>();

	function handleOpen(dialogEl: HTMLDivElement) {
		if (showInput && inputElement) {
			inputElement.focus();
			inputElement.select();
			return;
		}
		const focusable = dialogEl.querySelector<HTMLElement>('button.primary');
		if (focusable) {
			focusable.focus();
		} else {
			dialogEl.focus();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		onkeydown?.(e);
		if (e.defaultPrevented) return;
		// While the user is typing in the input, plain letters are text —
		// the y/n confirm/cancel shortcuts must not fire.
		const typingInInput = showInput && e.target === inputElement;
		if (e.key === 'Enter') {
			e.preventDefault();
			if (showSave && onsave) {
				onsave();
			} else {
				onconfirm();
			}
		} else if (!typingInInput && e.key.toLowerCase() === 'y' && !e.ctrlKey && !e.altKey && !e.metaKey) {
			e.preventDefault();
			onconfirm();
		} else if (!typingInInput && e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.altKey && !e.metaKey) {
			e.preventDefault();
			oncancel();
		} else if (e.ctrlKey && e.key === 's' && showSave && onsave) {
			e.preventDefault();
			onsave();
		}
	}
</script>

<Dialog
	{show}
	width="400px"
	contentClass={kind}
	ariaLabelledby="modal-title"
	ariaDescribedby="modal-message"
	onclose={oncancel}
	onkeydown={handleKeydown}
	oncontextmenu={handleModalBackdropContextMenu}
	onopen={handleOpen}>
	<div class="modal-header">
		<h3 id="modal-title">{title}</h3>
	</div>
	<div class="modal-body">
		<p id="modal-message">{message}</p>
		{#if showInput}
			<input class="modal-input" type="text" bind:this={inputElement} bind:value={inputValue} spellcheck="false" />
		{/if}
		{@render children?.()}
	</div>
	<div class="modal-footer">
		<button class="modal-btn secondary" onclick={oncancel}>{t('settings.cancel', settings.language)}</button>
		<div class="footer-spacer"></div>
		{#if confirmLabel}
			<button class="modal-btn primary" onclick={onconfirm}>{confirmLabel}</button>
		{:else}
			<button class="modal-btn secondary" onclick={onconfirm}>
				{kind === 'warning' ? t('settings.discard', settings.language) : t('settings.save', settings.language)}
			</button>
		{/if}
		{#if showSave}
			<button class="modal-btn primary" onclick={onsave}>{t('settings.save', settings.language)}</button>
		{/if}
	</div>
</Dialog>

<style>
	.modal-header {
		padding: 20px 24px 12px 24px;
	}

	.modal-header h3 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
		color: var(--color-fg-default);
	}

	.modal-body {
		padding: 0 24px 24px 24px;
	}

	.modal-body p {
		margin: 0;
		font-size: 14px;
		line-height: 1.5;
		color: var(--color-fg-muted);
	}

	.modal-input {
		margin-top: 12px;
		width: 100%;
		box-sizing: border-box;
		padding: 6px 10px;
		font-size: 14px;
		font-family: inherit;
		color: var(--color-fg-default);
		background: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		outline: none;
	}

	.modal-input:focus {
		border-color: var(--color-accent-fg);
	}

	.modal-footer {
		padding: 16px 24px;
		background: var(--color-canvas-subtle);
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		border-top: 1px solid var(--color-border-muted);
	}

	.footer-spacer {
		flex: 1;
	}

	.modal-btn {
		padding: 6px 16px;
		border-radius: 6px;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.1s;
		border: 1px solid transparent;
		font-family: inherit;
	}

	.modal-btn.secondary {
		background: transparent;
		color: var(--color-fg-default);
		border-color: var(--color-border-default);
	}

	.modal-btn.secondary:hover {
		background: var(--color-neutral-muted);
	}

	.modal-btn.primary {
		background: var(--color-accent-fg);
		color: var(--color-btn-fg);
	}

	.modal-btn.primary:hover {
		filter: brightness(1.1);
	}
</style>
