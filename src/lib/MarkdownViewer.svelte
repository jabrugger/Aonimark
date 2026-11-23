<script lang="ts">
	import { commands, events, type Appearance } from './bindings.js';
import { getCurrentWindow } from '@tauri-apps/api/window';
	import { onMount, tick, untrack } from 'svelte';
import { fade } from 'svelte/transition';
	import { open, save, ask } from '@tauri-apps/plugin-dialog';
	import Settings from './components/Settings.svelte';
	import TitleBar from './components/TitleBar.svelte';
	import WysiwygEditor from './components/WysiwygEditor.svelte';
	import Modal from './components/Modal.svelte';
	import UpdateDialog from './components/UpdateDialog.svelte';
	import { updateStore } from './stores/update.svelte.js';
	import Toast from './components/Toast.svelte';
	import { createWindowExit } from './sessions/windowExit.js';
	import { createExternalChange } from './sessions/externalChange.svelte.js';
	import { autoSaveFailureNeedsToast, isAutoSaveEligible } from './utils/autoSaveTimer.js';
	import { buildMenuModel, installAppMenu, type MenuAction } from './utils/appMenu.js';
import { hasMarkdownLinkExtension, MARKDOWN_OPEN_FILTERS } from './utils/markdownLinks.js';
import { ChoiceDialog } from './utils/choiceDialog.svelte.js';

	const appWindow = getCurrentWindow();

import { tabManager } from './stores/tabs.svelte.js';
import { viewerCommandTable } from './utils/viewerCommands.js';
import { dispatchViewerKey, type KeyContext, type ViewerCommand } from './utils/viewerKeymap.js';
import { resolveTheme, settings, wheelZoomFactor } from './stores/settings.svelte.js';
import { t } from './utils/i18n.js';
import { createWindowSession } from './sessions/windowSession.svelte.js';
import { createBoundedWriter, restoreRecords, recoverySnapshot } from './sessions/unsavedRecovery.js';
import { createDocumentSession, type LoadMarkdownOptions } from './sessions/documentSession.svelte.js';
import { followActiveFile } from './sessions/fileWatch.svelte.js';

import { followTheme } from './utils/themeEffect.svelte.js';

	let mode = $state<'loading' | 'app'>('loading');
	let isDisposed = false;
	let showSettings = $state(false);
	let isFocused = $state(true);
	// A clean document follows its file on disk.
	let liveMode = $state(true);
	let isDragging = $state(false);

	function reportUnsupportedDrop(path: string) {
		const filename = path.split(/[/\\]/).pop() || 'File';
		addToast(t('toast.unsupportedFile', settings.language).replace('{{filename}}', filename), 'error');
	}

	let toasts = $state<{ id: string; message: string; type: 'info' | 'error' | 'warning'; sticky?: boolean }[]>([]);
	function addToast(message: string, type: 'info' | 'error' | 'warning' = 'info', sticky = false): string {
		const id = crypto.randomUUID();
		toasts.push({ id, message, type, sticky });
		return id;
	}
	function removeToast(id: string) {
		toasts = toasts.filter((toast) => toast.id !== id);
	}

	// Auto-save bookkeeping (see the auto-save $effect below).
	const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// Last-seen rawContent per tab. A string compare, so any edit counts, including same-length ones.
	const lastContentRefByTab = new Map<string, string>();
	const AUTO_SAVE_DEBOUNCE_MS = 1500;

	/**
	 * Cancels a pending auto-save. Call it only on paths that commit to a save
	 * or discard outcome, never before a modal: a Cancel would leave auto-save
	 * silently off until the next keystroke. `saveContent` cancels its own timer.
	 */
	function cancelPendingAutoSave(tabId: string) {
		const timer = autoSaveTimers.get(tabId);
		if (timer) {
			clearTimeout(timer);
			autoSaveTimers.delete(tabId);
		}
	}

	let currentFile = $derived(tabManager.activeTab?.path ?? '');
	let windowTitle = $derived(tabManager.activeTab?.title ?? 'Aonimark');

	/** How tall the editor toolbar is, measured: the external-change bar sits under it. */
	let editorToolbarHeight = $state(0);

	onMount(() => {
		// Clear the forced background color from app.html
		document.documentElement.style.removeProperty('background-color');
	});

	/** What Rust paints the next window's background from, before any webview exists. */
	function saveStartupAppearance(appearance: Appearance) {
		commands.saveTheme(appearance).catch(console.error);
	}

	followTheme(() => settings.theme, saveStartupAppearance);

	const modalState = new ChoiceDialog();

	function askCustom(message: string, options: { title: string; kind: 'info' | 'warning' | 'error'; showSave?: boolean }): Promise<'save' | 'discard' | 'cancel'> {
		return modalState.ask(message, options);
	}

	// window.prompt() is a silent no-op inside the webview (wry does not
	// implement the native JS dialogs), so text input goes through our own
	// modal. Resolves with the entered string, or null on cancel.
	let promptModal = $state<{
		show: boolean;
		title: string;
		message: string;
		value: string;
		resolve: ((v: string | null) => void) | null;
	}>({ show: false, title: '', message: '', value: '', resolve: null });

	function promptCustom(message: string, options: { title: string; initial?: string }): Promise<string | null> {
		return new Promise((resolve) => {
			promptModal = {
				show: true,
				title: options.title,
				message,
				value: options.initial ?? '',
				resolve,
			};
		});
	}

	function closePrompt(value: string | null) {
		promptModal.resolve?.(value);
		promptModal.show = false;
	}

	
	function closeModal(choice: 'save' | 'cancel') {
		modalState.close(choice);
	}

	function handleModalConfirm() {
		modalState.close('discard');
	}

	
	

	const RESTORE_IN_PROGRESS_KEY = 'markpad-window-restore-in-progress';

	// Each window persists and restores its own snapshot, keyed by its label.
	// Windows are equal: whichever starts first reopens the others of the last
	// session under the labels they had.
	let recoveryReady = $state(false);
	let recoveryErrorShown = false;
	function reportRecoveryError(error: unknown) {
		console.error('Unsaved-change recovery failed', error);
		if (!recoveryErrorShown) {
			recoveryErrorShown = true;
			addToast(t('toast.recoveryFailed', settings.language), 'error');
		}
	}
	const unsavedRecovery = createBoundedWriter({
		write: (json) => commands.saveUnsavedRecovery(json),
		onError: reportRecoveryError,
		initial: '[]',
	});
	$effect(() => {
		if (!recoveryReady) return;
		if (!settings.persistOpenEditors) return void unsavedRecovery.update('[]');
		// The snapshot is built later, outside this effect, so its inputs are
		// read here: only what it keeps, so scrolling does not mark it stale.
		for (const tab of tabManager.tabs) void [tab.path, tab.isDirty, tab.rawContent, tab.originalContent, tab.encoding];
		unsavedRecovery.update(() => recoverySnapshot(tabManager.tabs));
	});

	// Startup, setting on. Without it nothing is read, written or removed.
	// Rust hands over this window's own backup and any orphan no other window
	// has taken (see `claim_unsaved_recovery`).
	async function restoreUnsavedChanges() {
		try {
			const records = await commands.claimUnsavedRecovery();
			const consumed = restoreRecords(tabManager, records, appWindow.label, reportRecoveryError);
			// Publish the new owner before removing stale window copies.
			await commands.saveUnsavedRecovery(recoverySnapshot(tabManager.tabs));
			await commands.clearUnsavedRecovery(consumed);
			for (const id of await documentSession.dirtyTabsChangedOnDisk()) noteExternalChangeConflict(id);
			recoveryReady = true;
		} catch (error) {
			// Not ready: nothing overwrites the record, and close asks as usual.
			reportRecoveryError(error);
		}
	}

	// The snapshot: which document is open, never its content.
	const windowStateJson = () => tabManager.serializeState();

	const windowSession = createWindowSession({
		restoreInProgressKey: RESTORE_IN_PROGRESS_KEY,
		serializeState: windowStateJson,
		shouldRestoreState: () => settings.restoreStateOnReopen,
		isDisposed: () => isDisposed,
		restoreState: (json) => tabManager.restoreState(json),
		restoredTabs: () => tabManager.tabs.map((tab) => ({ id: tab.id, path: tab.path })),
		loadRestoredTab: (tabId) => documentSession.readRestoredTab(tabId),
		dropRestoredTab: (tabId) => tabManager.closeTab(tabId),
		onError: (message, error) => {
			console.error(message, error);
			// eslint-disable-next-line aonimark/toasts-are-translated -- a pass-through: the sessions pass t() text, and the rest is developer detail beside String(error).
			addToast(`${message}: ${String(error)}`, 'error');
		},
		onWarning: (message, error) => console.warn(message, error),
		// The console line above says the same thing in more detail, but in a
		// packaged build nobody can open that console: the recovery mechanism
		// was diagnosing itself and writing the answer where no one could read
		// it. A document missing its content needs an explanation on screen.
		onInterrupted: ({ deferredPath }) =>
			addToast(
				deferredPath
					? t('toast.restoreInterruptedDeferred', settings.language).replace('{path}', deferredPath)
					: t('toast.restoreInterrupted', settings.language),
				'warning',
			),
	});

	// The session is recorded as it changes, so a crash or kill brings this
	// window back as it was. Tracks the window's shape only: which tabs, in
	// what order, which is active, how each is viewed, the tag and the folder.
	// Scroll and editor position are not tracked, so scrolling writes nothing;
	// they are written with the next tracked change and at every checkpoint
	// (focus loss, hide, close, quit).
	$effect(() => {
		for (const tab of tabManager.tabs) {
			void [tab.id, tab.path, tab.title];
		}
		void tabManager.activeTabId;
		// Not `serializeState`: its editor flush is only sound when no tab
		// switch is under way, and this runs on one.
		windowSession.record(untrack(windowStateJson));
	});

	$effect(() => {
		appWindow.setTitle(windowTitle).catch(() => {});
	});

	const documentSession = createDocumentSession({
		afterLoad: tick,
		onError: (message, error) => {
			console.error(message, error);
			// eslint-disable-next-line aonimark/toasts-are-translated -- a pass-through: the sessions pass t() text, and the rest is developer detail beside String(error).
			addToast(`${message}: ${String(error)}`, 'error');
		},
		onDiskChangedUnderSave: (id) => externalChange.noteExternalChangeConflict(id),
		cancelPendingAutoSave,
		// Two questions, one dialog. With the file untouched, Save means "write
		// what I typed" and the ordinary wording is right. With the disk moved
		// under the buffer, Save means "overwrite what somebody else wrote", and
		// saying "you have unsaved changes" would hide the half that matters.
		// The changed-on-disk sentence is the same one the conflict bar uses,
		// because it is the same news.
		askClose: (title, diskMoved) =>
			askCustom(
				diskMoved
					? t('externalChange.message', settings.language)
					: t('modal.youHaveUnsavedChanges', settings.language).replace('{title}', title),
				{
					title: t('modal.unsavedChanges', settings.language),
					kind: 'warning',
					showSave: true,
				},
			),
		onCloseSaveNewerEdits: () => addToast(t('toast.savedNewerEdits', settings.language), 'info'),
		onCloseAutoSaveFailed: () => addToast(t('toast.autoSaveFailed', settings.language), 'error'),
		// Not an error: the copy is the way out of a partial buffer, and it was
		// written. What the reader needs is to know where it stops.
		onPartialCopySaved: () => addToast(t('toast.partialCopySaved', settings.language), 'info'),
	});

	const externalChange = createExternalChange({
		tabManager,
		settings,
		documentSession,
		loadMarkdown,
		canCloseTab,
		readFile: (path) => commands.readFileContentChecked(path),
		addToast,
		t,
	});
	const {
		saveContent,
		saveActiveTab,
		saveSilently,
		hasExternalChangeConflict,
		noteExternalChangeConflict,
		resolveExternalChangeByReloading,
		reloadFromDisk,
		resolveExternalChangeByKeepingBuffer,
	} = externalChange;

		
	// Persisted through Rust, not localStorage: setItem is an async message
	// to the WebKit storage process that dies in transit when the last
	// window's close ends the process (reproduced in QA as "close secondary
	// first, then main → snapshot gone"). An awaited invoke keeps the close
	// handler — and the process — alive until the bytes are on disk. The
	// localStorage keys are read once for migration and removed after the
	// first successful Rust write; a downgraded build then starts
	// a fresh session instead of misreading anything.
	//
	// `remember` false: this window closed on its own while others stay, so it
	// is forgotten — even with restore off, or a later quit with it back on
	// would reopen it from a stale snapshot.
	async function persistWindowState() {
		if (settings.restoreStateOnReopen) await windowSession.persistState();
	}

	const windowExit = createWindowExit({
		tabManager,
		settings,
		appWindow,
		recovery: {
			isReady: () => recoveryReady,
			keep: () => unsavedRecovery.flush(recoverySnapshot(tabManager.tabs)),
			drop: () => unsavedRecovery.flush('[]'),
		},
		persistWindowState,
		canCloseTab,
		saveSilently,
		hasExternalChangeConflict,
		onAutoSaveFailed: () => addToast(t('toast.autoSaveFailed', settings.language), 'error'),
		settle: tick,
	});
	const {
		settleForUpdate,
		appExit,
	} = windowExit;

		
	
	
	followActiveFile(() => currentFile);

	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	async function loadMarkdown(filePath: string, options: LoadMarkdownOptions = {}) {
		return documentSession.loadMarkdown(filePath, options);
	}

	
	
	
	
	
	
	
	
	
	
		
	
	
	
	
	
			
	
	
	
			
	
	
		
	
	
	
	
		
		
	
	
	
	
	
	
	
	
	
	
	

	
	
	
	
	
	async function canCloseTab(tabId: string): Promise<boolean> {
		return documentSession.canCloseTab(tabId);
	}

	
	async function saveContentAs(): Promise<boolean> {
		return documentSession.saveContentAs();
	}

	let activeExternalChangeConflict = $derived(
		tabManager.activeTabId ? hasExternalChangeConflict(tabManager.activeTabId) : false,
	);

	
	/**
	 * Auto-save effect.
	 *
	 * Watches every tab in the tab manager. For each tab that is dirty, has a
	 * non-empty path (untitled files require an explicit Save dialog), and is
	 * currently editable (edit-mode or split-mode), arms a per-tab debounce
	 * timer that calls saveSilently(tabId) when the typing pause exceeds
	 * AUTO_SAVE_DEBOUNCE_MS.
	 *
	 * Per-tab timers (instead of a single timer keyed off the active tab) mean
	 * a dirty background tab can still be flushed without the user revisiting
	 * it — typical scenario when you switch tabs mid-edit.
	 *
	 * If `settings.autoSave` flips to false at runtime, all pending timers are
	 * cancelled and a manual Cmd+S becomes the only path again.
	 */
	$effect(() => {
		// With auto-save off, only Cmd+S and the close dialog save, so drop
		// every armed timer.
		if (!settings.autoSave) {
			untrack(() => {
				for (const t of autoSaveTimers.values()) clearTimeout(t);
				autoSaveTimers.clear();
				lastContentRefByTab.clear();
			});
			return;
		}

		// Reactive reads — every keystroke flows through updateTabRawContent,
		// which assigns a new immutable string to `tab.rawContent`. Capturing
		// the reference here triggers re-runs on any edit (including
		// same-length ones like overwrite or formatting toggles).
		const snapshot = tabManager.tabs.map((tab) => ({
			id: tab.id,
			path: tab.path,
			isDirty: tab.isDirty,
			editable: true,
			contentRef: tab.rawContent,
			// Reactive too: clearing a conflict re-arms the timer on the next
			// keystroke, so answering the bar resumes normal auto-save.
			hasPendingConflict: hasExternalChangeConflict(tab.id),
			// Reactive as well, and that is the point: "Save As" to a new file
			// clears the flag, so the tab becomes eligible again on the next
			// pass without anything having to remember to re-arm it.
			decodedLossily: tab.hasReplacementChars,
		}));

		untrack(() => {
			const seenIds = new Set<string>();
			for (const s of snapshot) {
				seenIds.add(s.id);
				const eligible = isAutoSaveEligible(s, documentSession.isLossySaveRefused);
				const prevRef = lastContentRefByTab.get(s.id);
				const refChanged = prevRef !== s.contentRef;

				if (!eligible) {
					// Tab is no longer dirty / editable / has a path — drop
					// any pending timer and forget its tick.
					const existing = autoSaveTimers.get(s.id);
					if (existing) {
						clearTimeout(existing);
						autoSaveTimers.delete(s.id);
					}
					lastContentRefByTab.delete(s.id);
					continue;
				}

				if (!refChanged && autoSaveTimers.has(s.id)) {
					// Eligible but no new edit AND a timer is already armed —
					// leave it alone so background tabs don't get their
					// debounce reset by foreground typing.
					continue;
				}

				// Either content changed, or the tab just became eligible
				// (e.g. user pressed Save As). (Re)arm the debounce.
				const existing = autoSaveTimers.get(s.id);
				if (existing) clearTimeout(existing);
				lastContentRefByTab.set(s.id, s.contentRef);
				const timer = setTimeout(() => {
					autoSaveTimers.delete(s.id);
					// `saveSilently` resolves false on failure instead of
					// rejecting, so failures are surfaced here.
					saveSilently(s.id).then(
						(ok) => {
							if (!ok) {
								console.error('Auto-save failed for tab', s.id);
								if (!autoSaveFailureNeedsToast(s.id, { isLossySaveRefused: documentSession.isLossySaveRefused, hasExternalChangeConflict })) return;
								addToast(
									t('toast.autoSaveFailed', settings.language),
									'error',
								);
							}
						},
						(e) => {
							console.error('Auto-save threw for tab', s.id, e);
							addToast(
								t('toast.autoSaveFailed', settings.language),
								'error',
							);
						},
					);
				}, AUTO_SAVE_DEBOUNCE_MS);
				autoSaveTimers.set(s.id, timer);
			}
			// Tabs that were closed: drop their timers and tick records.
			for (const id of [...autoSaveTimers.keys()]) {
				if (!seenIds.has(id)) {
					clearTimeout(autoSaveTimers.get(id)!);
					autoSaveTimers.delete(id);
				}
			}
			for (const id of [...lastContentRefByTab.keys()]) {
				if (!seenIds.has(id)) lastContentRefByTab.delete(id);
			}
		});
	});

	
		
	/** A window holds one document: replacing it asks about unsaved changes first. */
	async function replaceDocument(replace: () => unknown) {
		const current = tabManager.activeTab;
		if (current && !(await canCloseTab(current.id))) return;
		await replace();
	}

	function handleNewFile() {
		void replaceDocument(() => tabManager.addNewTab());
	}

	async function openDocument(path: string) {
		await replaceDocument(() => documentSession.openFile(path));
	}

	

	async function selectFile() {
		const selected = await open({
			multiple: false,
			filters: MARKDOWN_OPEN_FILTERS,
		});
		if (typeof selected === 'string') await openDocument(selected);
	}

	async function closeFile() {
		await appWindow.close();
	}

	async function openFileLocation() {
		if (currentFile) await commands.openFileFolder(currentFile);
	}

	function toggleLiveMode() {
		liveMode = !liveMode;
	}

	/** The URL the WYSIWYG link button asks for, through the app's own modal. */
	function requestLinkUrl(defaultText: string): Promise<string | null> {
		return promptCustom(t('menu.link', settings.language), {
			title: t('menu.link', settings.language),
			initial: defaultText.startsWith('http') ? defaultText : 'https://',
		});
	}

	
	
	
	
	
	
	
	
	
	
	
	function handleWheel(e: WheelEvent) {
		if (e.ctrlKey || e.metaKey) {
			settings.zoomBy(wheelZoomFactor(e.deltaY));
		}
	}

	
	
	
	/*
	 * `viewerKeymap.ts` decides which command a keystroke means. This maps each
	 * command to the function that runs it. Every command is preventDefaulted
	 * here. An unbound chord or macOS ⌘Q comes back null
	 * and is not prevented.
	 */
	function keyContext(): KeyContext {
		const active = document.activeElement as Node | null;
		return {
			mode,
			osType: settings.osType,
			overlayOpen: showSettings || modalState.show || promptModal.show,
			dialogOpen: modalState.show || promptModal.show,
		};
	}

	const viewerCommands = viewerCommandTable({
		settings,
		reloadFromDisk,
		closeFile,
		handleNewFile,
		selectFile,
		appExit,
		toggleLiveMode,
		saveContentAs,
		saveActiveTab,
		openSettings: () => (showSettings = true),
		openFileLocation,
	});

	function runViewerCommand(command: ViewerCommand) {
		viewerCommands[command]();
	}

	/*
	 * The macOS menu bar. The focused window installs its own, so every click
	 * lands here. Rebuilt whenever what it shows changes, and after every click:
	 * AppKit flips a check item itself, and a click that changes nothing (one
	 * the dialog guard below refuses) would otherwise leave its mark wrong.
	 */
	let menuRevision = $state(0);
	// `isFocused` starts out true; the menu waits for the real answer.
	let focusKnown = $state(false);

	$effect(() => {
		if (settings.osType !== 'macos' || !focusKnown || !isFocused) return;
		void menuRevision;
		const model = buildMenuModel({
			language: settings.language,
			liveMode,
		});
		void installAppMenu(model, runMenuAction, () => isFocused);
	});

	function runMenuAction(action: MenuAction) {
		menuRevision++;
		if ('viewer' in action && action.viewer === 'app-exit') return void appExit();
		// A dialog leaves its chords unprevented, so they reach the menu.
		const context = keyContext();
		if (context.mode !== 'app' || context.dialogOpen) return;
		if ('viewer' in action) return runViewerCommand(action.viewer);
		switch (action.app) {
			case 'check-updates':
				return updateStore.openDialog();
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		dispatchViewerKey(e, keyContext(), runViewerCommand);
	}

	
	
	
	
	
	
	
	
	
	onMount(() => {
		isDisposed = false;

		let unlisteners: (() => void)[] = [];

			commands.showWindow().catch(console.error);

			const init = async () => {
				const appWindow = getCurrentWindow();
				if (isDisposed) return;
				// Before the restore below: the macOS menu follows focus from here on.
				unlisteners.push(
					await appWindow.onFocusChanged(({ payload: focused }) => {
						isFocused = focused;
						if (!focused) windowSession.checkpoint();
					}),
				);
				isFocused = await appWindow.isFocused();
				focusKnown = true;

			await windowSession.restore();
			if (isDisposed) return;
			if (settings.persistOpenEditors) await restoreUnsavedChanges();
			if (isDisposed) return;
			if (isDisposed) return;

			const urlParams = new URLSearchParams(window.location.search);

			const fileParam = urlParams.get('file');
			if (fileParam) {
				const decodedPath = decodeURIComponent(fileParam);
				if (isDisposed) return;
				await loadMarkdown(decodedPath);
				if (isDisposed) return;
			}

			const checkpointWhenHidden = () => {
				if (document.visibilityState === 'hidden') windowSession.checkpoint();
			};
			document.addEventListener('visibilitychange', checkpointWhenHidden);
			unlisteners.push(() => document.removeEventListener('visibilitychange', checkpointWhenHidden));
			unlisteners.push(
				await events.fileChanged(appWindow).listen((event) => externalChange.handleFileChanged(event.payload, liveMode)),
			);
			unlisteners.push(
				await events.filePath(appWindow).listen((event) => {
					if (event.payload) void openDocument(event.payload);
				}),
			);

			unlisteners.push(
				await appWindow.onCloseRequested(windowExit.handleCloseRequested),
			);

			unlisteners.push(
				await appWindow.onDragDropEvent((event) => {
					if (event.payload.type === 'enter' || event.payload.type === 'over') {
						isDragging = true;
					} else if (event.payload.type === 'drop') {
						const [path] = event.payload.paths;
						if (path && hasMarkdownLinkExtension(path)) void openDocument(path);
						else if (path) reportUnsupportedDrop(path);
						isDragging = false;
					} else if (event.payload.type === 'leave') {
						isDragging = false;
					}
				}),
			);

			if (isDisposed) {
				unlisteners.forEach((unlisten) => unlisten());
				return;
			}

			// Startup-file delivery (argv / macOS Opened-before-ready stash).
			// Every window asks; Rust hands the launch's files out once, to the
			// launch window, so a detached window never re-opens them.
			try {
				const args: string[] = await commands.sendMarkdownPath();
				if (!isDisposed && args?.[0]) await openDocument(args[0]);
			} catch (error) {
				console.error('Error receiving Markdown file path:', error);
			}
			if (!tabManager.activeTab) tabManager.addNewTab();

			if (!isDisposed) mode = 'app';
		};

		init();

		return () => {
			isDisposed = true;
			unsavedRecovery.dispose();
			unlisteners.forEach((u) => u());
		};
	});
</script>

<svelte:document onkeydown={handleKeyDown} />

{#if mode === 'loading'}
	<TitleBar
		{isFocused}
		currentFile={''}
		{liveMode}
		windowTitle="Aonimark"
		zoomLevel={settings.zoomLevel}
		onnewFile={handleNewFile}
		onopenFile={selectFile}
		onsaveFile={saveContent}
		onsaveFileAs={saveContentAs}
		onreloadFromDisk={reloadFromDisk}
		onexit={appExit}
		ononpenFileLocation={openFileLocation}
		ontoggleLiveMode={toggleLiveMode}
		onresetZoom={() => settings.resetZoom()}
		theme={settings.theme}
		onSetTheme={(t: string) => (settings.theme = resolveTheme(t))}
		onopenSettings={() => (showSettings = true)} />
	<div class="loading-screen">
		<svg class="spinner" viewBox="0 0 50 50">
			<circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="4"></circle>
		</svg>
	</div>
{:else}
	<TitleBar
		{isFocused}
		{currentFile}
		{liveMode}
		{windowTitle}
		zoomLevel={settings.zoomLevel}
		onnewFile={handleNewFile}
		onopenFile={selectFile}
		onsaveFile={saveContent}
		onsaveFileAs={saveContentAs}
		onreloadFromDisk={reloadFromDisk}
		onexit={appExit}
		ononpenFileLocation={openFileLocation}
		ontoggleLiveMode={toggleLiveMode}
		onresetZoom={() => settings.resetZoom()}
		theme={settings.theme}
		onSetTheme={(t: string) => (settings.theme = resolveTheme(t))}
		onopenSettings={() => (showSettings = true)} />

	<Settings show={showSettings} theme={settings.theme} onSetTheme={(t) => (settings.theme = t)} onclose={() => (showSettings = false)} />

	<div class="content-area">
	{#if activeExternalChangeConflict}
		<div class="external-change-bar" role="status" style:top="{36 + editorToolbarHeight}px">
			<span class="external-change-text">{t('externalChange.message', settings.language)}</span>
				<button class="external-change-action" onclick={() => resolveExternalChangeByReloading(tabManager.activeTabId ?? '')}>
				{t('externalChange.reload', settings.language)}
			</button>
			<button class="external-change-action primary" onclick={() => resolveExternalChangeByKeepingBuffer(tabManager.activeTabId ?? '')}>
				{t('externalChange.keepMine', settings.language)}
			</button>
		</div>
	{/if}
	{#if tabManager.activeTab}
			<div
				class="markdown-container"
				style="--editor-zoom: {settings.zoomLevel / 100};"
				onwheel={handleWheel}
				role="presentation">
				<div class="layout-container">
					<div class="pane editor-pane">
						{#key tabManager.activeTabId}
							{@const tabId = tabManager.activeTabId}
							<WysiwygEditor
								value={tabManager.activeTab.rawContent}
								readOnly={tabManager.activeTab.isTruncated === true}
								language={settings.language}
								onchange={(markdown) => tabManager.updateTabRawContent(tabId ?? '', markdown)}
								onrequesturl={requestLinkUrl}
								bind:toolbarHeight={editorToolbarHeight} />
						{/key}
					</div>
				</div>
			</div>
	{/if}
	</div>

	<!-- Before the modals: installing runs the unsaved-tab review, whose dialogs
	     share this z-index, so they have to come later to be on top. -->
	<UpdateDialog settleForExit={settleForUpdate} />

	<Modal
		show={modalState.show}
		title={modalState.title}
		message={modalState.message}
		kind={modalState.kind}
		showSave={modalState.showSave}
		onconfirm={handleModalConfirm}
		onsave={() => closeModal('save')}
		oncancel={() => closeModal('cancel')} />

	<Modal
		show={promptModal.show}
		title={promptModal.title}
		message={promptModal.message}
		kind="info"
		showInput={true}
		bind:inputValue={promptModal.value}
		onconfirm={() => closePrompt(promptModal.value)}
		oncancel={() => closePrompt(null)} />

	<div class="toast-container">
		{#each toasts as toast (toast.id)}
			<Toast 
				message={toast.message} 
				type={toast.type} 
				sticky={toast.sticky}
				onremove={() => removeToast(toast.id)} />
		{/each}
	</div>

	{#if isDragging}
		<div class="drag-overlay" role="presentation">
			<div class="drag-zones">
				<div class="drag-zone editor-zone active">
					<div class="drag-message">
						<span>{t('dragAndDrop.open', settings.language)}</span>
					</div>
				</div>
			</div>
		</div>
	{/if}
{/if}

<style>
	:root {
		scroll-behavior: smooth !important;
		background-color: var(--color-canvas-default);
	}

	:global(body) {
		background-color: var(--color-canvas-default);
		margin: 0;
		padding: 0;
		color: var(--color-fg-default);
		overflow: hidden;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.drag-overlay {
		position: fixed;
		top: 36px;
		left: 0;
		right: 0;
		bottom: 0;
		pointer-events: none;
		z-index: 40000;
		animation: fadeIn 0.1s ease-out;
	}

	.drag-message {
		display: flex;
		flex-direction: column;
		align-items: center;
		color: #ffffff;
		font-family: var(--win-font);
		font-weight: 500;
		font-size: 13px;
		position: absolute;
		bottom: 40px;
		left: 50%;
		transform: translateX(-50%);
		white-space: nowrap;
		background: var(--color-accent-fg);
		padding: 6px 14px;
		border-radius: 20px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
		pointer-events: none;
	}

	.drag-zones {
		display: flex;
		width: 100%;
		height: 100%;
		gap: 12px;
	}

	.drag-zone {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		transition: background 0.2s, border-color 0.2s, opacity 0.2s;
		border: 2px dashed transparent;
		opacity: 0;
		position: relative;
		margin: 8px;
		border-radius: 12px;
	}

	.drag-zone.active {
		background: color-mix(in srgb, var(--color-accent-fg) 8%, transparent);
		border-color: color-mix(in srgb, var(--color-accent-fg) 30%, transparent);
		opacity: 1;
	}

	.loading-screen {
		position: fixed;
		top: 36px;
		left: 0;
		width: 100%;
		height: calc(100% - 36px);
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--color-canvas-default);
		z-index: 5000;
	}

	.spinner {
		animation: rotate 2s linear infinite;
		z-index: 2;
		width: 50px;
		height: 50px;
	}

	.spinner .path {
		stroke: var(--color-accent-fg);
		stroke-linecap: round;
		animation: dash 1.5s ease-in-out infinite;
	}

	@keyframes rotate {
		100% {
			transform: rotate(360deg);
		}
	}

	@keyframes dash {
		0% {
			stroke-dasharray: 1, 150;
			stroke-dashoffset: 0;
		}
		50% {
			stroke-dasharray: 90, 150;
			stroke-dashoffset: -35;
		}
		100% {
			stroke-dasharray: 90, 150;
			stroke-dashoffset: -124;
		}
	}
	/* Layout System */
	/* Absolute, not fixed: with no z-index it opens no stacking context, so
	   menus inside it still stack against the title bar and the tab column. */
	.layout-container {
		display: flex;
		width: 100%;
		height: 100%;
		position: absolute;
		top: 0;
		left: 0;
		padding-top: 36px;
		box-sizing: border-box;
		overflow: hidden;
	}

	/* View Mode */
	.layout-container:not(.split):not(.editing) .editor-pane {
		width: 0 !important;
		flex: 0 !important;
		opacity: 0;
	}

	@keyframes fadeIn {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	/*
	 * `.layout-container` is absolutely positioned from top: 0, so a bar in
	 * normal flow would end up underneath it. Pinned below the 36px title bar
	 * and the pane's top chrome (`style:top`), the way editors surface
	 * file-changed-on-disk notices.
	 * Absolute inside `.content-area`, so it spans the document beside a tab column.
	 */
	.external-change-bar {
		position: absolute;
		top: 36px;
		left: 0;
		right: 0;
		z-index: 40000;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 14px;
		background: color-mix(in srgb, var(--color-attention-fg, #9a6700) 14%, var(--color-canvas-overlay));
		border-bottom: 1px solid var(--color-border-default);
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
		color: var(--color-fg-default);
		font-family: var(--win-font), sans-serif;
		font-size: 13px;
	}
	.external-change-text {
		flex: 1;
		min-width: 0;
	}
	.external-change-action {
		flex: none;
		padding: 4px 10px;
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		background: var(--color-canvas-default);
		color: var(--color-fg-default);
		font-family: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.external-change-action:hover {
		background: color-mix(in srgb, var(--color-accent-fg) 8%, var(--color-canvas-default));
	}
	.external-change-action.primary {
		border-color: color-mix(in srgb, var(--color-accent-fg) 40%, transparent);
	}
	.toast-container {
		position: fixed;
		bottom: 24px;
		right: 24px;
		z-index: 50000;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		pointer-events: none;
	}
	

	/**
	 * Expanded, the button floats over the OUTLINE, which has no editor toolbar
	 * on it — so the offset that clears one has nothing to clear and pushes the
	 * button down onto the outline's first entry instead. 48px puts it back in
	 * the panel's own header band, whose buttons sit at the far end (right when
	 * the outline is on the left, left when it is on the right), leaving this
	 * end of that band empty.
	 *
	 * Collapsed it keeps the offset, because there it really is floating over
	 * the editor pane and the toolbar really is above it.
	 */
</style>
