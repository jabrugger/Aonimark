<div align="center">
  <img src="src-tauri/icons/128x128.png" width="128" alt="Aonimark icon" />
  <h1>Aonimark</h1>
  <p><b>The WordPad of Markdown.</b></p>

  [![GitHub Release](https://img.shields.io/github/v/release/jabrugger/Aonimark?style=flat-square)](https://github.com/jabrugger/Aonimark/releases/latest)

  <p>A small, fast Markdown editor for Windows, macOS and Linux. You write in a rich editor; the file on disk stays plain Markdown.</p>
</div>

<br />

## What it does

- One document per window, edited in place (WYSIWYG, built on [Milkdown](https://milkdown.dev)).
- Standard Markdown only: CommonMark plus GitHub tables, strikethrough and task lists.
- One toolbar, light and dark themes, zoom and a Zen mode.
- Auto-save, reload when the file changes on disk, and recovery of unsaved changes and of your last session.
- Opens `.md`, `.markdown`, `.mdown`, `.mkd` and `.txt`, in several text encodings.
- 26 interface languages. No telemetry. Free and open source.

It is deliberately not a Word: there are no diagrams, maths, tabs, folders or export. Those are tracked as issues for later.

## Download

Installers for Windows, macOS and Linux are on the [releases page](https://github.com/jabrugger/Aonimark/releases/latest).

## Build from source

You need Node.js 24 and a Rust toolchain.

```bash
npm ci
npm run tauri dev      # run the app
npm run tauri build    # build the installers
```

Checks: `npm run check`, `npm run lint`, `npm test`, `npm run test:vitest`, and `cargo test` in `src-tauri`.

## Issues and contributing

Report bugs and ideas on the [issue tracker](https://github.com/jabrugger/Aonimark/issues). See [AGENTS.md](AGENTS.md) for the coding guidelines and [RELEASING.md](RELEASING.md) for how releases are made.

Aonimark began as a fork of [Markpad](https://github.com/sftwrdotdev/Markpad) and keeps its MIT license.
