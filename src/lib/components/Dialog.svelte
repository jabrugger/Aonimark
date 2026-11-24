<script lang="ts">
	import type { Snippet } from 'svelte';
	import { fade, scale } from 'svelte/transition';

	let {
		show = false,
		width = '440px',
		zIndex = 30000,
		dismissible = true,
		contentClass = '',
		ariaLabelledby,
		ariaDescribedby,
		onclose,
		onkeydown,
		oncontextmenu,
		onopen,
		children,
	} = $props<{
		show?: boolean;
		width?: string;
		zIndex?: number;
		dismissible?: boolean;
		contentClass?: string;
		ariaLabelledby?: string;
		ariaDescribedby?: string;
		onclose: () => void;
		onkeydown?: (e: KeyboardEvent) => void;
		oncontextmenu?: (e: MouseEvent) => void;
		onopen?: (dialogEl: HTMLDivElement) => void;
		children: Snippet;
	}>();

	let dialogEl = $state<HTMLDivElement>();
	let previousActiveElement: HTMLElement | null = null;

	$effect(() => {
		if (show) {
			previousActiveElement = document.activeElement as HTMLElement | null;
		} else if (previousActiveElement) {
			previousActiveElement.focus();
			previousActiveElement = null;
		}
	});

	function handleKeydown(e: KeyboardEvent) {
		onkeydown?.(e);
		if (e.defaultPrevented) return;

		if (e.key === 'Tab') {
			const focusable = dialogEl?.querySelectorAll<HTMLElement>(
				'button:not([disabled]), [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
			);
			if (!focusable || focusable.length === 0) {
				e.preventDefault();
				dialogEl?.focus();
				return;
			}
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
			return;
		}

		if (dismissible && e.key === 'Escape') {
			e.preventDefault();
			onclose();
		}
	}

	function handleBackdropClick() {
		if (dismissible) onclose();
	}

	function handleIntroEnd() {
		if (!dialogEl) return;
		if (onopen) {
			onopen(dialogEl);
		} else {
			dialogEl.focus();
		}
	}
</script>

{#if show}
	<div
		class="dialog-backdrop"
		style:z-index={zIndex}
		transition:fade={{ duration: 150 }}
		onclick={handleBackdropClick}
		{oncontextmenu}
		role="presentation">
		<div
			class="dialog-content {contentClass}"
			style:width="min({width}, 92vw)"
			bind:this={dialogEl}
			transition:scale={{ duration: 200, start: 0.95 }}
			onintroend={handleIntroEnd}
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			aria-labelledby={ariaLabelledby}
			aria-describedby={ariaDescribedby}
			tabindex="-1"
			onkeydown={handleKeydown}>
			{@render children()}
		</div>
	</div>
{/if}

<style>
	.dialog-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.4);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.dialog-content {
		background: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		max-height: 90vh;
		box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3);
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		font-family: var(--win-font);
		color: var(--color-fg-default);
		outline: none;
	}
</style>
