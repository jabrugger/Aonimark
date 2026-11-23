import assert from 'node:assert/strict';

import { beforeEach, describe, test } from 'vitest';

import { createWindowSession } from '../src/lib/sessions/windowSession.svelte.js';

/** What Rust holds for this window: its snapshot and the restore breadcrumb. */
let state: { snapshot: string | null; breadcrumb: string | null };
let invoked: string[];

function stubBackend() {
	(window as any).__TAURI_INTERNALS__ = {
		metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
		invoke: async (cmd: string, args: any) => {
			invoked.push(cmd);
			switch (cmd) {
				case 'save_window_state':
					state.snapshot = args.json;
					return null;
				case 'load_window_state':
					return state.snapshot;
				case 'clear_window_state':
					state.snapshot = null;
					return null;
				case 'save_restore_progress':
					state.breadcrumb = args.json;
					return null;
				case 'load_restore_progress':
					return state.breadcrumb;
				case 'clear_restore_progress':
					state.breadcrumb = null;
					return null;
				default:
					throw new Error(`unexpected command ${cmd}`);
			}
		},
	};
}

/** A session over a one-tab window, with every callback recorded. */
function harness(overrides: { shouldRestore?: boolean; loadRestoredTab?: () => Promise<void> } = {}) {
	let tabs: { id: string; path: string }[] = [];
	const events: string[] = [];
	const session = createWindowSession({
		serializeState: () => JSON.stringify({ tabs }),
		shouldRestoreState: () => overrides.shouldRestore ?? true,
		isDisposed: () => false,
		restoreState: (json) => {
			tabs = JSON.parse(json).tabs;
		},
		restoredTabs: () => tabs,
		loadRestoredTab: async (id) => {
			events.push(`load ${id}`);
			// The breadcrumb must already be on disk while the read is under way.
			events.push(`breadcrumb ${state.breadcrumb}`);
			await overrides.loadRestoredTab?.();
		},
		dropRestoredTab: (id) => {
			tabs = tabs.filter((tab) => tab.id !== id);
			events.push(`drop ${id}`);
		},
		onError: (message) => void events.push(`error ${message}`),
		onWarning: () => {},
		onInterrupted: (path) => void events.push(`interrupted ${path}`),
	});
	return { session, events, tabs: () => tabs };
}

describe('session restore', () => {
	beforeEach(() => {
		state = { snapshot: JSON.stringify({ tabs: [{ id: 't1', path: '/notes/a.md' }] }), breadcrumb: null };
		invoked = [];
		stubBackend();
	});

	test('the saved document is read, with the breadcrumb on disk during the read and gone after', async () => {
		const { session, events, tabs } = harness();

		assert.equal(await session.restore(), true);

		assert.deepEqual(events, ['load t1', 'breadcrumb /notes/a.md']);
		assert.equal(state.breadcrumb, null);
		assert.deepEqual(tabs(), [{ id: 't1', path: '/notes/a.md' }]);
	});

	test('a launch that died reading the document skips it once and says so', async () => {
		state.breadcrumb = '/notes/a.md';
		const { session, events, tabs } = harness();

		await session.restore();

		assert.deepEqual(events, ['interrupted /notes/a.md', 'drop t1']);
		assert.deepEqual(tabs(), []);
		assert.equal(state.breadcrumb, null, 'the next launch tries again');
	});

	test('a breadcrumb for some other document does not block this one', async () => {
		state.breadcrumb = '/notes/other.md';
		const { session, events } = harness();

		await session.restore();

		assert.deepEqual(events, ['load t1', 'breadcrumb /notes/a.md']);
	});

	test('a failed read still clears the breadcrumb', async () => {
		const { session } = harness({ loadRestoredTab: () => Promise.reject(new Error('boom')) });

		await session.restore();

		assert.equal(state.breadcrumb, null);
	});

	test('with restoring turned off the saved session is discarded and nothing is read', async () => {
		const { session, events } = harness({ shouldRestore: false });

		assert.equal(await session.restore(), false);

		assert.equal(state.snapshot, null);
		assert.deepEqual(events, []);
		assert.ok(invoked.includes('clear_window_state'));
	});

	test('with no saved session nothing is read and an empty snapshot is recorded', async () => {
		state.snapshot = null;
		const { session, events } = harness();

		assert.equal(await session.restore(), false);

		assert.deepEqual(events, []);
		assert.equal(state.snapshot, JSON.stringify({ tabs: [] }));
	});
});
