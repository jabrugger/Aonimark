# AGENTS.md

Guidelines for AI agents working on Aonimark.

Aonimark is a Tauri v2 app: a WYSIWYG Markdown editor, one document per window. Frontend: Svelte 5 + TypeScript + Vite, with Milkdown for editing. Backend: Rust (Tauri commands). It began as a fork of Markpad.

## Commands

```bash
npm run dev            # Vite dev server
npm run tauri dev      # the app, in dev mode
npm run tauri build    # installers
npm run check          # svelte-check (types)
npm run lint           # code conventions (eslint.config.js)
npm test               # scripts/*.test.ts  (node --test)
npm run test:vitest    # scripts/*.spec.ts  (vitest + jsdom)
cd src-tauri && cargo test   # Rust tests; also regenerates src/lib/bindings.ts
```

CI runs check, lint, both frontend suites and cargo test on every pull request.

## Code style

- TypeScript/Svelte: tabs, single quotes, strict types, `.js` extension on relative imports, external imports before internal ones.
- Svelte 5 runes only (`$state`, `$derived`, `$effect`, `$props`, `$bindable`), with props typed explicitly.
- Names: components PascalCase, stores `camelCase.svelte.ts`, event props `onsave`, `onnew`.
- Rust: 4 spaces, snake_case, `Result<T, String>` from Tauri commands, `#[cfg(target_os = ...)]` for platform code.
- Stores are runes-based singletons in `src/lib/stores/`.

## Architecture rules

- Call Rust through the generated bindings, never a raw `invoke`: `import { commands } from '../bindings.js'`. `cargo test` regenerates `src/lib/bindings.ts` (tauri-specta), so a mismatch is a type error.
- All file access goes through Rust commands. No Node `fs` in the app.
- One implementation of each behavior. Conventions are lint rules in `eslint.config.js` and `scripts/conventions.test.ts`.

## Tests

Tests run the real code and assert what it does. A test never reads source as text (no regex over a file, no evaluating a slice of a component); if the logic sits in a component, move it into a `.ts` or `.svelte.ts` module and test that.

- `*.spec.ts` (vitest) when the subject is a `.svelte.ts` runes module or needs a real DOM. `*.test.ts` (node) otherwise.
- Group tests by feature, not by the fix that added them. Add to the existing file; a new file is for a new feature. Name a test by the behavior it claims, and put the issue number in a comment above it.
- jsdom has no layout: it tests structure and behavior, not geometry.
- Stores built inside a test must be disposed (`onTestFinished(() => store.dispose())`), because every spec file shares one jsdom.
- Under vitest, `resolve.conditions: ['browser']` is required, and `get_os_type` must be stubbed.

## Versioning

`npm run release X.Y.Z` writes the version into `package.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` and checks they agree. Do it all in one commit. See [RELEASING.md](RELEASING.md).

Never change `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. It is set once by the maintainer, and a different key breaks auto-update for every installed copy.
