<div align="center">

<img src="Screenshot 2026-06-09 133305.png" />

# Fast-edit

**A keyboard-first video trimmer for cutting long recordings down to the parts that matter.**

Mark in/out points on a timeline, stack non-overlapping segments, scrub with frame-accurate precision, and export the result — all without your hands leaving the keyboard.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-stable-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org/)

</div>

---

## Table of Contents

- [Why Fast-edit](#why-fast-edit)
- [Features](#features)
- [Screenshots](#screenshots)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Install](#install)
  - [Run in development](#run-in-development)
  - [Build a release binary](#build-a-release-binary)
- [Project structure](#project-structure)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Concepts](#concepts)
- [Settings](#settings)
- [Project files](#project-files)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why Fast-edit

Most video editors are timelines bolted onto NLE workflows: tracks, clips, effects, transitions, render queues. That's overkill when the job is **"keep these three pieces of a one-hour screen recording and throw out the rest."**

Fast-edit is built around that one job. Open a file, slap down in/out points as the playhead rolls past, fine-tune the boundaries, and export. The whole UI is a timeline, a viewport, and a list of segments — nothing else gets in the way.

- ⚡ **Native performance** — Tauri + Rust shell with hardware-accelerated `mpv` playback. No Electron, no Chromium-tab-per-window memory tax.
- ⌨️ **Keyboard-first** — Every meaningful action has a rebindable shortcut. Set in (`I`), set out (`O`), undo (`Ctrl+Z`), step a frame — all without touching the mouse.
- 🎯 **Frame-accurate** — Scrub, frame-step, and snap handles to the playhead. Boundaries are clamped so segments can never overlap or invert.
- 🧠 **Sane undo/redo** — Undoing an edit restores your segments, **not** your playback position or open dialogs. Editing past is editing, not rewinding.
- 💾 **Project files** — Save the segment list alongside the video so you can come back tomorrow and pick up exactly where you left off.

## Features

### Editing
- **Add / delete / split segments** on the timeline
- **Drag handles** to fine-tune segment boundaries, clamped at neighboring segments
- **Set Start / Set End** from the current playhead position with one key
- **Per-segment colors** so a busy timeline stays readable
- **Selection-aware controls** — most actions operate on the currently selected segment

### Playback
- **Hardware-accelerated decode** via embedded `mpv`
- **Scrubbing** on the timeline with live preview
- **Frame-step** forward and backward
- **Wheel-seek** with configurable scroll-step (jump by frames, seconds, or segments)
- **Mute toggle** and standard play/pause

### History
- **Undo / redo** with a closed, explicit set of mutations that count as Actions
- **Drag = one Action** — dragging a handle from mousedown to mouseup is a single undo step, no matter how many intermediate updates fire
- **Snapshots** store segments + selection only; playback state survives undo untouched

### Export
- **Trim and concatenate** all segments into a single output file
- **Optional hardware encoder** toggle for fast exports on supported GPUs

## Screenshots

> _Coming soon._ Drop screenshots into `assets/screenshots/` and reference them here.

```
┌──────────────────────────────────────────────────────────────┐
│  [ viewport — mpv-rendered video frame ]                     │
│                                                              │
│  ◀◀  ⏮  ⏯  ⏭  ▶▶          [ Set Start ]   [ Set End ]        │
├──────────────────────────────────────────────────────────────┤
│  timeline ▓▓▓▓░░░░▓▓▓▓▓▓▓░░░░░░░░▓▓▓▓░░░░░░▓▓▓▓▓░░  00:42    │
│  ───▲───────────────────────────────────────────────────     │
├──────────────────────────────────────────────────────────────┤
│  segments                                                    │
│  • 00:02 → 00:08   "intro"            ▮                      │
│  • 00:15 → 00:24   "the good take"    ▮ ← selected           │
│  • 00:37 → 00:41   "wrap"             ▮                      │
└──────────────────────────────────────────────────────────────┘
```

## Tech stack

| Layer | Tech | Notes |
|---|---|---|
| Shell | [Tauri 2](https://tauri.app) | Rust-backed native window, IPC, filesystem |
| UI | [React 18](https://react.dev) + [TypeScript](https://www.typescriptlang.org/) | Strict mode, function components, hooks |
| Bundler | [Vite](https://vitejs.dev) | Fast HMR for the renderer |
| Playback | [`mpv`](https://mpv.io/) | Embedded via Rust bindings, OS-native decode |
| Styling | CSS | Plain CSS, no framework |
| State | Custom `useAppState` hook | Local store + snapshot-based undo/redo |

## Getting started

### Prerequisites

You'll need:

- **Node.js** ≥ 18 and a package manager (`npm`, `pnpm`, or `yarn`)
- **Rust** (stable) — install via [rustup](https://rustup.rs)
- **System dependencies for Tauri** — follow the official guide for your OS:
  https://tauri.app/start/prerequisites/
- **`mpv`** runtime libraries on the host machine
  - **Windows:** `libmpv` DLL on PATH (or shipped next to the executable)
  - **macOS:** `brew install mpv`
  - **Linux:** `libmpv-dev` (Debian/Ubuntu) or your distro's equivalent

### Install

```bash
git clone https://github.com/jassde/Fast-edit.git
cd Fast-edit
npm install
```

### Run in development

```bash
npm run tauri dev
```

This boots the Vite dev server for the React frontend and launches the Tauri shell against it with hot-reload on save.

On Windows you can also use the included batch script:

```bat
dev.bat
```

### Build a release binary

```bash
npm run tauri build
```

Output lives in `src-tauri/target/release/bundle/` — platform-appropriate installers (`.msi` / `.dmg` / `.AppImage` / `.deb`) plus a raw executable.

## Project structure

```
Fast-edit/
├── src/                    React + TypeScript renderer
│   ├── components/         UI components (Timeline, PlaybackControls, …)
│   ├── hooks/              useAppState and friends
│   └── …
├── src-tauri/              Rust shell, IPC commands, mpv integration
│   ├── src/                Rust source
│   └── tauri.conf.json     App config, window options, bundle settings
├── public/                 Static assets served by Vite
├── svg/                    App-specific SVG assets
├── assets/                 README assets (icons, screenshots)
├── index.html              Vite entry point
├── package.json
├── vite.config.ts
├── tsconfig.json
├── CONTEXT.md              Project glossary — read this before contributing
├── CLAUDE.md               Notes for AI coding assistants
└── LICENSE                 MIT
```

## Keyboard shortcuts

Shortcuts are **rebindable** and persisted under the `video-trimmer-shortcuts` key in local storage. Defaults:

| Action | Default binding |
|---|---|
| Play / pause | `Space` |
| Set selected segment **start** to playhead | `I` |
| Set selected segment **end** to playhead | `O` |
| Add segment at playhead | `A` |
| Delete selected segment | `Delete` |
| Step one frame back / forward | `←` / `→` |
| Seek 1 second back / forward | `Shift+←` / `Shift+→` |
| Undo | `Ctrl+Z` |
| Redo | `Ctrl+Shift+Z` |
| Mute toggle | `M` |

> Bindings use a canonical `Combo` format: lowercase modifiers in fixed order `ctrl, shift, alt, meta` joined with `+`, then the key. Examples: `ctrl+z`, `ctrl+shift+z`, `i`, `' '` (space), `Delete`. A bare key with no modifiers is valid.

## Concepts

Fast-edit uses a small, deliberate vocabulary. The authoritative definitions live in [`CONTEXT.md`](CONTEXT.md); the short version:

### Segment
A contiguous time range `[start, end)` marked for export. Stored as `{ id, start, end, color }`. **Segments cannot overlap** — handle drags clamp at neighboring boundaries.

### Action
A user-initiated mutation that participates in the undo history. The set is **closed and explicit**: add segment, delete segment, edit start/end (via buttons, `I`/`O`, or a handle drag). One mousedown→mouseup drag is **one** Action regardless of how many intermediate updates fire.

The following are **not** Actions and never appear in history:
- Playhead movement (scrubbing, frame-step, wheel-seek)
- Segment selection
- Play / pause / mute
- Modal open / close
- Settings changes
- Loading a file or project (these **clear** the history instead)

### Snapshot
The unit on the undo / redo stacks: `{ segments, selectedSegmentId }`. Snapshots are intentionally **not** the full app state — undoing an edit doesn't rewind playback or close a dialog you have open.

### Combo
The canonical string format for a keyboard binding (see above).

## Settings

Accessible from the settings modal. Persisted to local storage:

- **Hardware encoder** — toggle GPU-accelerated encoding on export. Falls back to software if your hardware doesn't support the chosen codec.
- **Scroll step** — how far the wheel seeks: frames, seconds, or whole segments.
- **Scroll-panel visibility** — show or hide the side panel.
- **Keyboard bindings** — rebind any shortcut from the [Combo](#combo) table.

## Project files

A Fast-edit project saves the segment list alongside a reference to the source video. Reopening a project restores all segments and selection, ready to keep editing. **Loading a file or a project clears the undo/redo history** — undoing into a previous video would be more surprising than useful.

## Roadmap

- [ ] Proof-of-life screenshots in this README
- [ ] Multi-file projects (queue several recordings together)
- [ ] Audio waveform overlay on the timeline
- [ ] Per-segment fade in/out
- [ ] Export presets (codec, resolution, bitrate)
- [ ] CI builds for Windows, macOS, and Linux releases

## Contributing

Contributions are very welcome. Before opening a PR:

1. **Read [`CONTEXT.md`](CONTEXT.md)** — it pins down what *Segment*, *Action*, *Snapshot*, and *Combo* mean in this codebase. Keeping that vocabulary consistent keeps the model in everyone's head consistent.
2. Open an issue first for anything larger than a bug fix or small polish so we can agree on the shape before code gets written.
3. Match the existing style — TypeScript strict mode, function components, no implicit `any`.
4. If your change touches the Action set, the undo behavior, or the keyboard model, update `CONTEXT.md` in the same PR.
5. `npm run tauri dev` should run cleanly with no console errors after your change.

## License

[MIT](LICENSE) © jassde

---

<div align="center">
<sub>Built with Tauri, React, and mpv. Cuts long recordings down to the good parts.</sub>
</div>
