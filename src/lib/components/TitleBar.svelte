<script lang="ts">
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { commands } from '../bindings.js';
	import { openUrl } from '@tauri-apps/plugin-opener';
	import { fly } from 'svelte/transition';
	import iconUrl from '../../assets/icon.png';
	import { tabManager } from '../stores/tabs.svelte.js';
	import { settings } from '../stores/settings.svelte.js';
	import { t } from '../utils/i18n.js';
	import { titlebarActionIds } from '../utils/titlebarToolbar.js';
	import { shortcutLabel } from '../utils/shortcuts.js';
	import { TitleBarPlatform } from '../stores/titleBarPlatform.svelte.js';
	import { getVersion } from '@tauri-apps/api/app';
import { TitleBarPopovers, containClick } from '../stores/titleBarPopovers.svelte.js';

	let currentLanguage = $derived(settings.language);

	let {
		isFocused,
		currentFile,
		liveMode,

		windowTitle,
		onnewFile,
		onopenFile,
		onsaveFile,
		onsaveFileAs,
		onreloadFromDisk,
		onexit,
		ononpenFileLocation,
		ontoggleLiveMode,

		zoomLevel,
		onresetZoom,
		theme = 'system',
		onSetTheme,
		onopenSettings,
	} = $props<{
		isFocused: boolean;
		currentFile: string;
		liveMode: boolean;

		windowTitle: string;
		onnewFile?: () => void;
		onopenFile?: () => void;
		onsaveFile?: () => void;
		onsaveFileAs?: () => void;
		onreloadFromDisk?: () => void;
		onexit?: () => void;
		ononpenFileLocation: () => void;
		ontoggleLiveMode: () => void;

		zoomLevel?: number;
		onresetZoom?: () => void;


		theme?: string;
		onSetTheme?: (theme: string) => void;
		onopenSettings?: () => void;
	}>();

	const appWindow = getCurrentWindow();

	let innerWidth = $state(1000);
	let isCollapsed = $derived(innerWidth <= 450 || settings.zenMode);

	const titleBarPlatform = new TitleBarPlatform();
	let isMac = $derived(titleBarPlatform.isMac);
	let modifier = $derived(titleBarPlatform.modifier);

	let isWin11 = $state(false);
	const popovers = new TitleBarPopovers();

	
	$effect(() => {
		commands.isWin11()
			.then((res) => {
				isWin11 = res as boolean;
			})
			.catch(() => {
				isWin11 = false;
			});
	});

	// Windows and Linux only: on macOS the top of the screen is the menu bar, so
	// a maximized window's tabs never sit on the screen edge (#823).
	let isMaximized = $state(false);
	$effect(() => {
		if (isMac) return;
		const sync = () => appWindow.isMaximized().then((v) => (isMaximized = v)).catch(() => {});
		sync();
		const unlisten = appWindow.onResized(sync);
		return () => {
			unlisten.then((f) => f());
		};
	});

	let tooltip = $state({
		visible: false,
		text: '',
		shortcut: '',
		x: 0,
		y: 0,
		align: 'center' as 'left' | 'center' | 'right',
	});

	function showTooltip(e: MouseEvent, text: string, shortcut: string | undefined = '', force: boolean = false) {
		if (!force && (popovers.kebabMenuOpen || popovers.homeMenuOpen)) return;
		const target = e.currentTarget as HTMLElement;
		const rect = target.getBoundingClientRect();
		const windowWidth = window.innerWidth;
		const edgeThreshold = 100;

		tooltip.text = text;
		// A COMPLETE chord, from the registry — not a suffix this function
		// prefixes with the modifier. Composing it here is what made the
		// Reload-from-Disk tooltip read "Ctrl+F5" for a binding that is plain F5.
		tooltip.shortcut = shortcut ?? '';

		if (rect.left < edgeThreshold) {
			tooltip.align = 'left';
			tooltip.x = rect.left;
		} else if (rect.right > windowWidth - edgeThreshold) {
			tooltip.align = 'right';
			tooltip.x = rect.right;
		} else {
			tooltip.align = 'center';
			tooltip.x = rect.left + rect.width / 2;
		}

		tooltip.y = rect.bottom + 8;
		tooltip.visible = true;
	}

	function hideTooltip() {
		tooltip.visible = false;
	}

	let zoomTimeout: ReturnType<typeof setTimeout>;
	let isInitialZoomLoad = true;

	$effect(() => {
		if (zoomLevel !== undefined) {
			if (isInitialZoomLoad) {
				isInitialZoomLoad = false;
				return;
			}

			const kebabBtn = document.querySelector('.kebab-btn') as HTMLElement;
			if (kebabBtn && !popovers.kebabMenuOpen && !popovers.homeMenuOpen && !popovers.themeMenuOpen) {
				const rect = kebabBtn.getBoundingClientRect();
				tooltip.text = `${zoomLevel}%`;
				tooltip.shortcut = '';
				tooltip.align = 'right';
				tooltip.x = rect.right;
				tooltip.y = rect.bottom + 8;
				tooltip.visible = true;

				clearTimeout(zoomTimeout);
				zoomTimeout = setTimeout(() => {
					if (tooltip.text === `${zoomLevel}%`) {
						tooltip.visible = false;
					}
				}, 1500);
			}
		}
	});

	let actionIds = $derived(
		titlebarActionIds({
			hasActiveTab: Boolean(tabManager.activeTab),
			currentFile,
			zoomLevel,
		}),
	);

	let appVersion = $state('');
	$effect(() => {
		getVersion()
			.then((v) => {
				appVersion = v;
			})
			.catch(console.error);
	});

	function handleSetTheme(t: string) {
		if (onSetTheme) onSetTheme(t);
		popovers.themeMenuOpen = false;
	}

	$effect(() => popovers.listenForDismiss(window));
</script>

<svelte:window bind:innerWidth />

<div class="custom-title-bar {!isMac ? 'windows' : ''} {isMac ? 'native-mac' : ''}" class:maximized={isMaximized}>
	{#if !isMac && !isWin11}
		<div class="window-top-border"></div>
	{/if}
	<div class="window-controls-left" data-tauri-drag-region>
		<div class="home-menu-container" role="presentation">
			<button
				class="icon-home-btn {popovers.homeMenuOpen ? 'active' : ''}"
				onclick={(e) => {
					e.stopPropagation();
					popovers.homeMenuOpen = !popovers.homeMenuOpen;
					if (popovers.homeMenuOpen) {
						popovers.themeMenuOpen = false;
						popovers.kebabMenuOpen = false;
						hideTooltip();
					}
				}}
				aria-label={t('tooltip.menu', currentLanguage)}
			onmouseenter={(e) => {
							if (!popovers.homeMenuOpen) showTooltip(e, t('tooltip.menu', currentLanguage));
						}}
				onmousedown={(e) => e.preventDefault()}
				onmouseleave={hideTooltip}>
				<img
					src={iconUrl}
					alt="icon"
					class="window-icon"
					style:filter={theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'none' : 'invert(0.7)'} />
			</button>
			{#if popovers.homeMenuOpen}
				<div
					class="home-dropdown-menu"
					role="menu"
					tabindex="-1"
					transition:fly={{ y: 5, duration: 150 }}
					onclick={containClick}
					onkeydown={(e) => {
						if (e.key === 'Escape') popovers.homeMenuOpen = false;
					}}>
					<button
				class="home-menu-item"
				onclick={() => {
					popovers.homeMenuOpen = false;
					onnewFile?.();
				}}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
					><path d="M14 2H6a2 2 0 0 0-2 2v16h16V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line
						x1="9"
						y1="15"
						x2="15"
						y2="15"></line
					></svg>
				{t('menu.newFile', currentLanguage)}
				<span class="menu-shortcut">{shortcutLabel('file-new', modifier)}</span>
			</button>
			<button
				class="home-menu-item"
				onclick={() => {
					popovers.homeMenuOpen = false;
					onopenFile?.();
				}}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
					><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><polyline points="15 13 18 13 18 10"></polyline><line
						x1="14"
						y1="14"
						x2="18"
						y2="10"></line
					></svg>
				{t('menu.openFile', currentLanguage)}
				<span class="menu-shortcut">{shortcutLabel('file-open', modifier)}</span>
			</button>
					{#if currentFile !== '' || tabManager.activeTab}
						<button
						class="home-menu-item"
						onclick={() => {
							popovers.homeMenuOpen = false;
							onsaveFile?.();
						}}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline
								points="7 3 7 8 15 8"></polyline
							></svg>
						{t('menu.save', currentLanguage)}
						<span class="menu-shortcut">{shortcutLabel('file-save', modifier)}</span>
					</button>
					<button
						class="home-menu-item"
						onclick={() => {
							popovers.homeMenuOpen = false;
							onsaveFileAs?.();
						}}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline
								points="7 3 7 8 15 8"></polyline
							></svg>
						{t('menu.saveAs', currentLanguage)}
						<span class="menu-shortcut">{shortcutLabel('file-save-as', modifier)}</span>
					</button>
					{#if currentFile !== ''}
						<button
							class="home-menu-item"
							onclick={() => {
								popovers.homeMenuOpen = false;
								onreloadFromDisk?.();
							}}>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
								><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15A9 9 0 1 1 18 5.64L23 10"></path></svg>
							{t('menu.reloadFromDisk', currentLanguage)}
							<span class="menu-shortcut">{shortcutLabel('file-reload', modifier)}</span>
						</button>
					{/if}
					{/if}
					<div class="home-menu-divider"></div>
					<div class="home-menu-divider"></div>
					<button
					class="home-menu-item"
					onclick={() => {
						popovers.homeMenuOpen = false;
						onexit?.();
					}}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
						><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
					{t('menu.exit', currentLanguage)}
					<span class="menu-shortcut">{shortcutLabel('app-exit', modifier)}</span>
				</button>
					<div class="home-menu-divider"></div>
					<button
						class="home-menu-footer"
						onclick={() => {
							popovers.homeMenuOpen = false;
							openUrl('https://github.com/jabrugger/Markpad-Neo')
								.catch(() => window.open('https://github.com/jabrugger/Markpad-Neo', '_blank'));
						}}>
						v{appVersion}
					</button>
				</div>
			{/if}
		</div>
	</div>
		<div class="window-title-container" data-tauri-drag-region>
			<div class="window-title {isFocused ? 'focused' : 'unfocused'}" data-tauri-drag-region>
				<span class="title-text" data-tauri-drag-region>
					{windowTitle}
				</span>
			</div>
		</div>

	<div class="title-actions-container {isCollapsed ? 'collapsed' : ''}" data-tauri-drag-region>
		{#snippet kebabButton()}
			<button
				class="kebab-btn {popovers.kebabMenuOpen ? 'active' : ''}"
				onclick={(e) => {
					e.stopPropagation();
					popovers.kebabMenuOpen = !popovers.kebabMenuOpen;
					if (popovers.kebabMenuOpen) {
						popovers.themeMenuOpen = false;
						hideTooltip();
					}
				}}
				onmouseenter={(e) => {
							if (!popovers.kebabMenuOpen) showTooltip(e, t('tooltip.more', currentLanguage));
						}}
				onmousedown={(e) => e.preventDefault()}
				onmouseleave={hideTooltip}
				aria-label={t('tooltip.moreActions', currentLanguage)}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="1"></circle>
					<circle cx="12" cy="5" r="1"></circle>
					<circle cx="12" cy="19" r="1"></circle>
				</svg>
			</button>
		{/snippet}

	{#snippet actionItems(ids: string[])}
			{#each ids as id (id)}
				{#if id === 'settings'}
					<button
						class="title-action-btn"
						onclick={() => {
							hideTooltip();
							popovers.kebabMenuOpen = false;
							onopenSettings?.();
						}}
						aria-label={t('tooltip.settings', currentLanguage)}
											onmouseenter={(e) => showTooltip(e, t('tooltip.settings', currentLanguage))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}
						transition:fly={{ x: 10, duration: 200 }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="3"></circle>
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
						</svg>
						<span class="action-label">{t('menu.settings', currentLanguage)}</span>
					</button>
				{:else if id === 'zoom'}
					<button
						class="menu-zoom-item"
						onclick={() => {
							hideTooltip();
							onresetZoom?.();
						}}
						onmousedown={(e) => e.preventDefault()}
						transition:fly={{ y: -10, duration: 150 }}
						aria-label={t('tooltip.resetZoom', currentLanguage)}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="11" cy="11" r="8"></circle>
							<line x1="21" y1="21" x2="16.65" y2="16.65"></line>
							<line x1="11" y1="8" x2="11" y2="14"></line>
							<line x1="8" y1="11" x2="14" y2="11"></line>
						</svg>
						<span class="zoom-value">{zoomLevel}%</span>
						<span class="menu-shortcut">{t('tooltip.reset', currentLanguage)}</span>
					</button>
				{:else if id === 'zen'}
					<button
						class="title-action-btn {settings.zenMode ? 'active' : ''}"
						onclick={() => settings.toggleZenMode()}
						aria-label={t('tooltip.toggleZenMode', currentLanguage)}
											onmouseenter={(e) => showTooltip(e, t('tooltip.zenMode', currentLanguage))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}
						transition:fly={{ x: 10, duration: 200 }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							{#if settings.zenMode}
								<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path>
							{:else}
								<circle cx="12" cy="12" r="10"></circle>
								<circle cx="12" cy="12" r="3"></circle>
							{/if}
						</svg>
						<span class="action-label">{t('menu.zenMode', currentLanguage)}</span>
						<span class="menu-shortcut">{shortcutLabel('toggle-zen-mode', modifier)}</span>
					</button>
				{:else if id === 'open_loc'}
					<button
						class="title-action-btn"
						onclick={ononpenFileLocation}
						aria-label={t('tooltip.openFileLocation', currentLanguage)}
											onmouseenter={(e) => showTooltip(e, t('tooltip.openFileLocation', currentLanguage))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}
						transition:fly={{ x: 10, duration: 200 }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><polyline points="15 13 18 13 18 10"></polyline><line
								x1="14"
								y1="14"
								x2="18"
								y2="10"></line
							></svg>
						<span class="action-label">{t('menu.openFileLocation', currentLanguage)}</span>
					</button>
				{:else if id === 'reload'}
					<button
						class="title-action-btn"
						onclick={() => {
							hideTooltip();
							popovers.kebabMenuOpen = false;
							onreloadFromDisk?.();
						}}
						aria-label={t('tooltip.reloadFromDisk', currentLanguage)}
											onmouseenter={(e) => showTooltip(e, t('tooltip.reloadFromDisk', currentLanguage), shortcutLabel('file-reload', modifier))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}
						transition:fly={{ x: 10, duration: 200 }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15A9 9 0 1 1 18 5.64L23 10"></path></svg>
						<span class="action-label">{t('menu.reloadFromDisk', currentLanguage)}</span>
						<span class="menu-shortcut">{shortcutLabel('file-reload', modifier)}</span>
					</button>
				{:else if id === 'live'}
					<button
						class="title-action-btn {liveMode ? 'active' : ''}"
						onclick={ontoggleLiveMode}
						aria-label={t('tooltip.toggleAutoReload', currentLanguage)}
											onmouseenter={(e) => showTooltip(e, t('tooltip.autoReload', currentLanguage))}
						onmousedown={(e) => e.preventDefault()}
						onmouseleave={hideTooltip}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path
								d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path
							></svg>
						<span class="action-label">{t('menu.autoReload', currentLanguage)}</span>
					</button>
				{:else if id === 'theme'}
					<div class="theme-dropdown-container">
						<button
							class="title-action-btn {popovers.themeMenuOpen ? 'active' : ''}"
							onclick={(e) => {
								e.stopPropagation();
								popovers.themeMenuOpen = !popovers.themeMenuOpen;
								if (popovers.themeMenuOpen) hideTooltip();
							}}
							aria-label={t('tooltip.changeTheme', currentLanguage)}
														onmouseenter={(e) => {
														if (!popovers.themeMenuOpen) showTooltip(e, t('tooltip.changeTheme', currentLanguage));
												}}
							onmousedown={(e) => e.preventDefault()}
							onmouseleave={hideTooltip}
							transition:fly={{ x: 10, duration: 200 }}>
							{#if theme === 'light'}
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
									><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line
										x1="4.22"
										y1="4.22"
										x2="5.64"
										y2="5.64"></line
									><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line
										x1="4.22"
										y1="19.78"
										x2="5.64"
										y2="18.36"></line
									><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
							{:else if theme === 'dark'}
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
									><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
							{:else}
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
									><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
							{/if}
							<span class="action-label">{t('menu.changeTheme', currentLanguage)}</span>
						</button>
						{#if popovers.themeMenuOpen}
							<div
								class="theme-menu"
								role="menu"
								tabindex="-1"
								transition:fly={{ y: 5, duration: 150 }}
								onclick={(e) => e.stopPropagation()}
								onkeydown={(e) => {
									if (e.key === 'Escape') popovers.themeMenuOpen = false;
								}}>
								<button class="theme-option {theme === 'system' ? 'selected' : ''}" onclick={() => handleSetTheme('system')}> {t('theme.followSystem', currentLanguage)} </button>
								<button class="theme-option {theme === 'light' ? 'selected' : ''}" onclick={() => handleSetTheme('light')}> {t('theme.defaultLight', currentLanguage)} </button>
								<button class="theme-option {theme === 'dark' ? 'selected' : ''}" onclick={() => handleSetTheme('dark')}> {t('theme.defaultDark', currentLanguage)} </button>
							</div>
						{/if}
					</div>
				{/if}
			{/each}
		{/snippet}

		{#snippet actionMenu(ids: string[])}
			{#if ids.length > 0}
				{@render kebabButton()}
				{#if popovers.kebabMenuOpen}
					<div
						class="title-actions show-dropdown"
						data-tauri-drag-region
						role="menu"
						tabindex="-1"
						transition:fly={{ y: 5, duration: 150 }}
						onclick={(e) => e.stopPropagation()}
						onkeydown={(e) => {
							if (e.key === 'Escape') popovers.kebabMenuOpen = false;
						}}>
						{@render actionItems(ids)}
					</div>
				{/if}
			{/if}
		{/snippet}

		{#if isCollapsed}
			{@render actionMenu([...actionIds.barIds, ...actionIds.menuIds])}
		{:else}
			<div class="title-actions inline" data-tauri-drag-region>
				{@render actionItems(actionIds.barIds)}
			</div>

			{@render actionMenu(actionIds.menuIds)}
		{/if}
	</div>

	<div class="window-controls-right" data-tauri-drag-region>
		{#if !isMac}
			<button class="control-btn" onclick={() => appWindow.minimize()} aria-label={t('common.minimize', currentLanguage)}>
				<svg width="12" height="12" viewBox="0 0 12 12"><rect fill="currentColor" width="10" height="1" x="1" y="6" /></svg>
			</button>
			<button
				class="control-btn maximize-btn"
				onclick={() => appWindow.toggleMaximize()}
				aria-label={t(isMaximized ? 'common.restore' : 'common.maximize', currentLanguage)}>
				{#if isMaximized}
					<!-- Windows' restore glyph: an 8px square, with a second one 2px up and right behind it. -->
					<svg width="12" height="12" viewBox="0 0 12 12"
						><g fill="none" stroke="currentColor" stroke-width="1"
							><rect width="7" height="7" x="1.5" y="3.5" /><path d="M3.5 3V1.5h7v7H9" /></g
						></svg>
				{:else}
					<svg width="12" height="12" viewBox="0 0 12 12"><rect fill="none" stroke="currentColor" stroke-width="1" width="9" height="9" x="1.5" y="1.5" /></svg>
				{/if}
			</button>
			<button
				class="control-btn close-btn"
				onclick={() => appWindow.close()}
				aria-label={t('common.close', currentLanguage)}>
				<svg width="12" height="12" viewBox="0 0 12 12"><path fill="currentColor" d="M11 1.7L10.3 1 6 5.3 1.7 1 1 1.7 5.3 6 1 10.3 1.7 11 6 6.7 10.3 11 11 10.3 6.7 6z" /></svg>
			</button>
		{/if}
	</div>
</div>

<div class="custom-tooltip {tooltip.visible ? 'visible' : ''} align-{tooltip.align}" style="left: {tooltip.x}px; top: {tooltip.y}px;">
	<span class="tooltip-text">{tooltip.text}</span>
	{#if tooltip.shortcut}
		<span class="tooltip-shortcut">{tooltip.shortcut}</span>
	{/if}
</div>

<style>
	.custom-title-bar {
		height: 36px;
		background-color: var(--color-canvas-default);
		display: flex;
		justify-content: space-between;
		align-items: center;
		user-select: none;
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 9999;
		font-family: var(--win-font);
		border-bottom: 1px solid transparent;
		transition: border-color 0.2s;
	}

	.window-top-border {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 1px;
		background-color: var(--color-window-border-top);
		z-index: 10002;
		pointer-events: none;
	}


	/*
	 * What the window tag covers, drawn once for the whole strip.
	 *
	 * A window tag is a property of the window: `TabManager.windowTag` is one
	 * nullable record and no tab carries membership of it. Every tab in the
	 * window is under the tag, including the one opened a second from now.
	 * A per-tab underline would say the opposite — that belonging is something
	 * each tab has or lacks — and would then need a per-tab truth to read,
	 * which does not exist and would have to be invented and kept in sync. One
	 * line under the strip cannot disagree with the data, and a new tab lands
	 * on it by construction rather than by remembering to mark it.
	 *
	 * The bottom edge is free: `.tab.active` in Tab.svelte marks the active tab
	 * with `background-color`, so nothing else in the strip is using this
	 * channel and the two readings do not compete.
	 *
	 * Above `.new-tab-btn` (21) in TabList, which would otherwise cover the
	 * end of the line.
	 */

	.window-controls-left {
		display: flex;
		align-items: center;
		padding-left: 10px;
		gap: 12px;
		position: relative;
		z-index: 10000;
	}

	.custom-title-bar.native-mac .window-controls-left {
		padding-left: 78px;
	}

	.title-actions-container {
		display: flex;
		align-items: center;
		position: relative;
		margin-right: 8px;
		margin-left: auto;
		gap: 4px;
		z-index: 10000;
	}

	.kebab-btn {
		display: flex;
		width: 28px;
		height: 28px;
		justify-content: center;
		align-items: center;
		background: transparent;
		border: none;
		color: var(--color-fg-muted);
		border-radius: 4px;
		cursor: pointer;
		transition: all 0.1s;
	}

	.kebab-btn:hover,
	.kebab-btn.active {
		background: var(--color-canvas-subtle);
		color: var(--color-fg-default);
	}

	.title-actions {
		display: flex !important;
		flex-direction: row !important;
		align-items: center !important;
		gap: 4px !important;
	}

	.title-actions.show-dropdown {
		display: flex !important;
		flex-direction: column !important;
		align-items: stretch !important;
		gap: 1px !important;
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 4px;
		background-color: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		padding: 4px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
		z-index: 10006;
		width: 200px;
	}

	.theme-dropdown-container {
		display: block;
		width: 100%;
	}

	.title-actions.show-dropdown .title-action-btn {
		width: 100%;
		justify-content: flex-start;
		align-items: center;
		padding: 6px 12px;
		height: auto;
		font-size: 13px;
		color: var(--color-fg-default);
		font-family: var(--win-font);
		gap: 8px;
	}

	.title-actions.show-dropdown .title-action-btn svg {
		width: 14px;
		min-width: 14px;
		height: 14px;
		flex-shrink: 0;
		display: block;
		margin: 0;
		color: var(--color-fg-muted);
	}

	.title-actions.show-dropdown .title-action-btn.active {
		color: var(--color-accent-fg);
	}

	.title-actions.show-dropdown .title-action-btn.active svg {
		color: var(--color-accent-fg);
	}

	.title-actions.show-dropdown .action-label {
		display: block;
		margin-left: 0;
		font-size: 13px;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
	}

	.action-label {
		display: none;
	}

	.title-action-btn {
		width: 28px;
		height: 28px;
		display: flex;
		justify-content: center;
		align-items: center;
		background: transparent;
		border: none;
		color: var(--color-fg-muted);
		border-radius: 4px;
		cursor: pointer;
		transition: all 0.1s;
	}

	.title-actions.show-dropdown .menu-zoom-item {
		width: 100%;
		display: flex;
		justify-content: flex-start;
		align-items: center;
		padding: 6px 12px;
		height: auto;
		font-size: 13px;
		color: var(--color-fg-default);
		font-family: var(--win-font);
		gap: 8px;
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.title-actions.show-dropdown .menu-zoom-item:hover {
		background: var(--color-canvas-subtle);
	}

	.title-actions.show-dropdown .menu-zoom-item svg {
		width: 14px;
		min-width: 14px;
		height: 14px;
		flex-shrink: 0;
		display: block;
		margin: 0;
		color: var(--color-fg-muted);
	}

	:global(.title-actions.show-dropdown .menu-zoom-item .zoom-value) {
		width: 32px;
		text-align: left;
		color: var(--color-fg-default);
		display: inline-block;
	}

	.title-action-btn.active {
		color: var(--color-accent-fg);
		background: var(--color-canvas-subtle);
	}

	.title-action-btn:hover {
		background: var(--color-canvas-subtle);
		color: var(--color-fg-default);
	}

	.title-action-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.title-action-btn:disabled:hover {
		background: transparent;
		color: var(--color-fg-muted);
	}

	.window-icon {
		width: 16px;
		height: 16px;
		opacity: 0.8;
	}

	@media (prefers-color-scheme: light) {
		.window-icon {
			filter: grayscale(1) brightness(0.2);
			opacity: 0.6;
		}
	}

	.icon-home-btn {
		background: transparent;
		border: none;
		padding: 4px;
		margin: -4px;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: background 0.1s;
	}

	.icon-home-btn:hover,
	.icon-home-btn.active {
		background: var(--color-canvas-subtle);
	}

	/*
	 * The title takes the space between the left controls and the action
	 * cluster rather than being positioned over the whole bar. Centred on the
	 * window, it sat under the toolbar buttons once the window was narrower
	 * than the title plus both clusters, and the buttons are above it (#884).
	 */
	.window-title-container {
		flex: 1;
		min-width: 0;
		display: flex;
		justify-content: center;
		align-items: center;
	}

	.window-title {
		font-size: 12px;
		transition: opacity 0.2s;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		display: block;
		max-width: 100%;
	}

	.title-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: block;
	}

	.window-title.focused {
		opacity: 0.8;
		color: var(--color-fg-default);
	}

	.window-title.unfocused {
		opacity: 0.4;
		color: var(--color-fg-default);
	}

	.window-controls-right {
		display: flex;
		height: 100%;
		position: relative;
		z-index: 10000;
	}

	.control-btn {
		width: 46px;
		height: 32px;
		display: flex;
		justify-content: center;
		align-items: center;
		background: transparent;
		border: none;
		color: var(--color-fg-default);
		opacity: 0.8;
		cursor: default;
		transition: all 0.1s;
	}

	.control-btn:hover {
		background: var(--color-canvas-subtle);
		opacity: 1;
	}

	.close-btn:hover {
		background: #e81123 !important;
	}

	.custom-tooltip {
		position: fixed;
		background: var(--color-canvas-overlay);
		color: var(--color-fg-default);
		padding: 4px 8px;
		border-radius: 6px;
		font-size: 11px;
		font-family: var(--win-font), 'Segoe UI', sans-serif;
		pointer-events: none;
		z-index: 10005;
		transform: translateX(-50%) translateY(-4px);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		border: 1px solid var(--color-border-default);
		display: flex;
		flex-direction: column;
		align-items: center;
		white-space: nowrap;
		gap: 2px;
		opacity: 0;
		transition:
			opacity 0.15s ease,
			transform 0.15s ease,
			width 0.2s cubic-bezier(0.2, 0, 0.2, 1),
			height 0.2s cubic-bezier(0.2, 0, 0.2, 1);
	}

	.custom-tooltip.align-center {
		transform: translateX(-50%) translateY(-4px);
	}
	.custom-tooltip.align-left {
		transform: translateX(0) translateY(-4px);
		align-items: flex-start;
	}
	.custom-tooltip.align-right {
		transform: translateX(-100%) translateY(-4px);
		align-items: flex-end;
	}

	.custom-tooltip.visible {
		opacity: 1;
	}
	.custom-tooltip.visible.align-center {
		transform: translateX(-50%) translateY(0);
	}
	.custom-tooltip.visible.align-left {
		transform: translateX(0) translateY(0);
	}
	.custom-tooltip.visible.align-right {
		transform: translateX(-100%) translateY(0);
	}

	.tooltip-shortcut {
		color: var(--color-fg-muted);
		font-size: 10px;
		font-family: inherit;
	}

	.theme-dropdown-container {
		position: relative;
	}

	.theme-menu {
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 4px;
		background-color: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
		padding: 4px;
		display: flex;
		flex-direction: column;
		width: 120px;
		z-index: 10005;
		gap: 1px;
	}

	.theme-menu-divider {
		height: 1px;
		background-color: var(--color-border-default);
		margin: 4px 0;
		transform: scaleY(0.5);
	}

	.theme-option {
		background: transparent;
		border: none;
		text-align: left;
		padding: 6px 12px;
		font-size: 12px;
		color: var(--color-fg-default);
		cursor: pointer;
		border-radius: 4px;
		font-family: var(--win-font);
	}

	.theme-option:hover {
		background-color: var(--color-canvas-subtle);
	}

	.theme-option.selected {
		color: var(--color-accent-fg);
		font-weight: 600;
	}

	.menu-shortcut {
		display: none;
		margin-left: auto;
		font-size: 11px;
		color: var(--color-fg-muted);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.home-menu-item .menu-shortcut,
	.title-actions.show-dropdown .menu-shortcut {
		display: block;
	}

	.home-menu-container {
		position: relative;
		display: flex;
		align-items: center;
		height: 100%;
	}

	.home-dropdown-menu {
		position: absolute;
		top: 100%;
		left: 0;
		margin-top: 4px;
		background-color: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
		padding: 4px;
		display: flex;
		flex-direction: column;
		width: 200px;
		z-index: 10006;
		gap: 1px;
	}

	.home-menu-item {
		display: flex;
		align-items: center;
		background: transparent;
		border: none;
		text-align: left;
		padding: 6px 12px;
		font-size: 13px;
		color: var(--color-fg-default);
		cursor: pointer;
		border-radius: 4px;
		font-family: var(--win-font);
		gap: 8px;
		white-space: nowrap;
	}

	.home-menu-item:hover {
		background-color: var(--color-canvas-subtle);
	}

	.home-menu-item svg {
		color: var(--color-fg-muted);
	}

	.home-menu-divider {
		height: 1px;
		background-color: var(--color-border-default);
		margin: 4px 0;
	}

	.home-menu-footer {
		display: block;
		width: 100%;
		text-align: center;
		padding: 6px 12px;
		font-size: 11px;
		color: var(--color-fg-subtle);
		background-color: transparent;
		text-decoration: none;
		border-radius: 4px;
		font-family: var(--win-font);
		margin-top: 2px;
		border: none;
		cursor: pointer;
	}

	.home-menu-footer:hover {
		color: var(--color-fg-default);
	}
</style>
