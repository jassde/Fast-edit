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
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [One-Time Setup](#one-time-setup)
  - [Run in Development](#run-in-development)
  - [Build a Release Binary](#build-a-release-binary)
  - [Running Tests](#running-tests)
- [Architecture Overview](#architecture-overview)
  - [Communication Flow](#communication-flow)
  - [Multi-Window System](#multi-window-system)
  - [How libmpv Rendering Works](#how-libmpv-rendering-works)
- [Project Structure](#project-structure)
  - [Frontend (`src/`)](#frontend-src)
  - [Rust Backend (`src-tauri/src/`)](#rust-backend-src-taurisrc)
  - [ffmpeg Module (`src-tauri/src/ffmpeg/`)](#ffmpeg-module-src-taurisrcffmpeg)
- [Frontend Deep Dive](#frontend-deep-dive)
  - [Entry Point and Routing](#entry-point-and-routing)
  - [State Management](#state-management)
  - [Hooks](#hooks)
  - [Components](#components)
  - [CSS and Theming](#css-and-theming)
- [Backend Deep Dive](#backend-deep-dive)
  - [Startup Sequence](#startup-sequence)
  - [Tauri Commands (IPC)](#tauri-commands-ipc)
  - [ffmpeg Integration](#ffmpeg-integration)
  - [Hardware Encoder Support](#hardware-encoder-support)
  - [Video Downloader (mangofetch)](#video-downloader-mangofetch)
  - [Project Save/Load](#project-saveload)
  - [Configurable Data Root](#configurable-data-root)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Scroll-Wheel Seeking](#scroll-wheel-seeking)
- [Timeline and Segments](#timeline-and-segments)
  - [Segment Rules](#segment-rules)
  - [NLE-Style Timeline](#nle-style-timeline)
  - [Filmstrip Thumbnails](#filmstrip-thumbnails)
  - [Zoom](#zoom)
- [Export System](#export-system)
  - [Export Modes](#export-modes)
  - [Codec and Container Matrix](#codec-and-container-matrix)
  - [ffmpeg Argument Shapes](#ffmpeg-argument-shapes)
- [Undo/Redo System](#undoredo-system)
- [Settings and Persistence](#settings-and-persistence)
- [Project Files (.vtproj.json)](#project-files-vtprojjson)
- [Accent Colors](#accent-colors)
- [Known Gotchas](#known-gotchas)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why Fast-edit

Most video editors are timelines bolted onto NLE workflows: tracks, clips, effects, transitions, render queues. That's overkill when the job is **"keep these three pieces of a one-hour screen recording and throw out the rest."**

Fast-edit is built around that one job. Open a file, slap down in/out points as the playhead rolls past, fine-tune the boundaries, and export. The whole UI is a timeline, a viewport, and a list of segments — nothing else gets in the way.

- **Native performance** — Tauri + Rust shell with hardware-accelerated `mpv` playback. No Electron, no Chromium-tab-per-window memory tax.
- **Keyboard-first** — Every meaningful action has a rebindable shortcut. Set in (`I`), set out (`O`), undo (`Ctrl+Z`), step a frame — all without touching the mouse.
- **Frame-accurate** — Scrub, frame-step, and snap handles to the playhead. Boundaries are clamped so segments can never overlap or invert.
- **Sane undo/redo** — Undoing an edit restores your segments, **not** your playback position or open dialogs.
- **Project files** — Save the segment list alongside the video so you can come back tomorrow and pick up exactly where you left off.
- **Built-in downloader** — Download videos from YouTube and other sites directly into the app via [mangofetch](https://crates.io/crates/mangofetch), with quality selection and cookie support.

---

## Features

### Editing
- **Split segments** on the timeline at the playhead position — the selected segment is divided into two at the current time
- **Drag handles** to fine-tune segment boundaries, clamped at neighboring segments so overlaps are impossible
- **Set Start / Set End** from the current playhead position with a single key press (`I` / `O`)
- **Per-segment colors** drawn from an 8-color palette, automatically cycling to keep busy timelines readable
- **Selection-aware controls** — most actions (set start, set end, delete, split) operate on the currently selected segment

### Playback
- **Hardware-accelerated decode** via embedded `mpv` (`vo: gpu-next`, `hwdec: auto-safe`)
- **Scrubbing** on the timeline with live video preview via `hr-seek: yes`
- **Frame-step** forward and backward (exact single-frame stepping)
- **Scroll-wheel seeking** with configurable steps — wheel = N frames, Shift+wheel = N seconds
- **Mute toggle** and standard play/pause transport controls

### Export
- **Separate mode** — each segment becomes its own output file
- **Merge mode** — all segments are concatenated into a single output file
- **Stream copy** (fast, keyframe-aligned) or **re-encode** (frame-accurate) with codec/CRF/container selection
- **Hardware encoding** — NVENC, QSV, and AMF with auto-detection priority NVENC > QSV > AMF
- **Container override** — export to source format, MP4, MKV, or WebM regardless of input container
- **Customizable filename patterns** — `{original}_{n}` expands to the source filename plus a segment number
- **Real-time progress** via Tauri events with percent tracking

### History
- **3-deep undo / redo** stacks for segment edits
- **Drag = one undo step** — dragging a handle from mousedown to mouseup is a single history entry regardless of intermediate updates
- **Snapshots** store segments + selection only; playback state survives undo untouched

### Video Downloader
- **Built-in downloader window** powered by [mangofetch](https://crates.io/crates/mangofetch) (a Rust CLI that wraps yt-dlp)
- **Quality selection** — best, 1080p, 720p, 480p, 360p, or audio-only
- **Auto-install** — if mangofetch isn't found, the app will `cargo install mangofetch` automatically (requires Rust toolchain)
- **Background self-update** — runs `mangofetch update` on startup to keep yt-dlp and dependencies current
- **Temp folder management** — open the download folder in Explorer, or clear all temp files with one click

---

## Tech Stack

| Layer | Technology | Role |
|---|---|---|
| Shell | [Tauri 2](https://tauri.app) | Rust-backed native window, IPC, filesystem access, dialog APIs |
| UI | [React 18](https://react.dev) + [TypeScript 5](https://www.typescriptlang.org/) | Strict mode, function components, hooks-only architecture |
| Bundler | [Vite 6](https://vitejs.dev) | Fast HMR for the renderer process, production build |
| Playback | [mpv](https://mpv.io/) via [`tauri-plugin-libmpv`](https://github.com/nini22P/tauri-plugin-libmpv) | In-process FFI to `libmpv-2.dll`, GPU-accelerated decode |
| Export | [ffmpeg](https://ffmpeg.org/) | Subprocess-based segment extraction, re-encoding, and concatenation |
| Downloader | [mangofetch](https://crates.io/crates/mangofetch) | yt-dlp wrapper for video/audio downloading |
| Styling | Plain CSS | Custom dark theme with OKLCH accent color palette, no framework |
| Icons | [Lucide React](https://lucide.dev/) | Lightweight SVG icon set for toolbar buttons |
| State | Custom `useAppState` hook | Local React state + snapshot-based undo/redo, persisted to localStorage |

---

## Getting Started

### Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js** >= 18 | Any package manager (`npm`, `pnpm`, `yarn`) works |
| **Rust** (stable) | Install via [rustup.rs](https://rustup.rs) |
| **Tauri system deps** | Follow the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/) for your OS |
| **ffmpeg** | Must be available on disk — see [ffmpeg Integration](#ffmpeg-integration) below |
| **mangofetch** *(optional)* | For the built-in video downloader; auto-installed if Rust toolchain is present |

### One-Time Setup

After cloning the repo, two setup steps are required before the first build:

```bash
# 1. Install Node dependencies
npm install

# 2. Download libmpv DLLs into src-tauri/lib/
#    Downloads libmpv-2.dll (~96 MB) and libmpv-wrapper.dll
#    These are gitignored — you MUST run this after a fresh clone.
npx tauri-plugin-libmpv-api setup-lib
```

**ffmpeg:** The project expects `ffmpeg.exe` to be discoverable at build time. The path resolution checks:
1. `<resource_dir>/ffmpeg/bin/ffmpeg.exe` (production bundle)
2. Walking up from the running executable to find `ffmpeg/bin/ffmpeg.exe` or `ffmpeg/ffmpeg.exe`

In development, placing `ffmpeg/bin/ffmpeg.exe` at the project root (which is already the case in this repo) satisfies the lookup.

### Run in Development

```bash
# Full dev mode — boots Vite dev server + Tauri shell with hot reload
npm run tauri dev

# Frontend only (no Rust backend, for rapid CSS/component iteration)
npm run dev
```

The Vite dev server runs on `http://localhost:1420`. The Tauri shell loads this URL as the WebView content.

### Build a Release Binary

```bash
npm run tauri build
```

Output is written to `src-tauri/target/release/bundle/` — platform-appropriate installers (`.msi`, NSIS) plus a raw executable. The build bundles `src-tauri/lib/**/*` (the libmpv DLLs) as resources.

> **Note:** `ffmpeg.exe` is **not** currently bundled via `tauri.conf.json` resources. For distribution, either add an `ffmpeg` resource entry to the config or document that ffmpeg must be installed alongside the binary.

### Running Tests

```bash
# Rust unit tests (ffmpeg arg builder, progress parser, filename expansion, project round-trip)
cd src-tauri && cargo test

# TypeScript type-checking (no runtime test runner configured)
npm run build
```

No lint command is currently configured.

---

## Architecture Overview

### Communication Flow

```
React (WebView, transparent)  <-->  Tauri IPC  <-->  Rust Backend
                                                     |-- tauri-plugin-libmpv --> libmpv-2.dll (in-process FFI)
                                                     |-- ffmpeg.rs           --> ffmpeg.exe   (subprocess)
                                                     +-- mangofetch.rs       --> mangofetch   (subprocess)
                                                 ^
           mpv renders into the host window      |  behind the WebView, constrained
           to the #video-panel rect via setVideoMarginRatio
```

There is **no Rust mpv code in this repo**. The Tauri plugin (`tauri-plugin-libmpv`) owns the entire mpv lifecycle: initialization, property observation, and command dispatch. The frontend talks to mpv directly via the plugin's TypeScript API (`init`, `command`, `setProperty`, `observeProperties`, `setVideoMarginRatio`).

### Multi-Window System

Fast-edit uses Tauri's `WebviewWindow` to open secondary windows from the same JS bundle. Each window is routed by `window.location.hash` in `main.tsx`:

| Hash | Window | Purpose |
|---|---|---|
| *(none)* | Main window | Video player, timeline, controls, export |
| `#downloader` | Downloader window | Video download UI powered by mangofetch |
| `#scroll-panel` | Scroll Panel | Always-on-top floating panel with scroll-step sliders |

All windows share the same Vite bundle and the same `localStorage` (same origin). CSS scoping prevents style leaks between windows — the `downloader-window` and `scroll-panel-window` classes are added to `<html>` at mount time for this purpose.

### How libmpv Rendering Works

The main Tauri window is `transparent: true`. mpv renders **behind** the WebView using in-process FFI to `libmpv-2.dll`. The render rectangle is constrained to the `#video-panel` DOM element via `setVideoMarginRatio({ left, right, top, bottom })`, which the `useMpv` hook recalculates on every `ResizeObserver` callback.

This means:
- The video panel div must have `background: transparent` — any opaque background would hide the mpv output
- Every other UI region (toolbar, controls, timeline, modals) sets its own opaque background
- If you add new UI chrome, it needs a background color or video will show through

This is chosen over the alternative `--wid` HWND embedding approach because the transparent-overlay path needs no Win32 child-window code and `setVideoMarginRatio` cleanly handles the panel-rect plumbing.

---

## Project Structure

```
Fast-edit/
+-- src/                          React + TypeScript frontend
|   +-- main.tsx                  Entry point — hash-based routing for multi-window
|   +-- App.tsx                   Root component: sidebar, video panel, controls, timeline
|   +-- App.css                   Global styles, accent color palette, dark theme
|   +-- constants.ts              Timeline dimensions, scroll-step bounds, color palette
|   +-- types.ts                  Shared TypeScript types (Segment, Codec, ExportParams, ...)
|   +-- utils.ts                  Helpers (formatTime, clamp, expandFilename, ...)
|   +-- components/
|   |   +-- Timeline.tsx          Ruler, segments, playhead, drag handles, filmstrip
|   |   +-- PlaybackControls.tsx  Transport + segment edit + zoom slider
|   |   +-- ExportModal.tsx       Output dir picker, codec/container/quality form, progress
|   |   +-- SettingsModal.tsx     Scroll-step, HW encoder, accent color, data root
|   |   +-- ShortcutsModal.tsx    Rebindable keyboard shortcut editor
|   |   +-- ScrollPanelApp.tsx    Floating scroll-step slider window
|   +-- hooks/
|   |   +-- useAppState.ts        Central state: segments, playhead, undo/redo, settings
|   |   +-- useMpv.ts             libmpv plugin lifecycle, property observation, resize
|   |   +-- useKeyboard.ts        Global keydown handler, reads bindings from useShortcuts
|   |   +-- useShortcuts.ts       User-rebindable key bindings, persisted to localStorage
|   |   +-- useWheelSeek.ts       Global scroll-wheel seeking (non-passive listener)
|   |   +-- useFileDrop.ts        Tauri drag-drop handler, filtered by video extension
|   +-- downloader/
|       +-- Downloader.tsx        Video download UI (URL, quality, progress, temp management)
|       +-- downloader.css        Downloader-specific styles (scoped to .downloader-window)
+-- src-tauri/                    Rust backend
|   +-- src/
|   |   +-- main.rs               Minimal entry point, calls edit_lib::run()
|   |   +-- lib.rs                Plugin registration, startup, command handler table
|   |   +-- paths.rs              Configurable Fast-edit root dir, state persistence
|   |   +-- project.rs            .vtproj.json save/load, version validation
|   |   +-- mangofetch.rs         mangofetch subprocess: install, update, download
|   |   +-- ffmpeg/
|   |       +-- mod.rs            ffmpeg path resolution, export orchestration, thumbnails
|   |       +-- args.rs           ffmpeg argument construction, HW encoder resolution
|   |       +-- process.rs        Subprocess execution, progress parsing, HW probe
|   |       +-- temp.rs           Filename expansion, TempCleanup RAII guard
|   |       +-- types.rs          Rust types: ExportParams, Codec, Container, HwEncoder, ...
|   +-- tauri.conf.json           App metadata, window config, CSP, bundle resources
|   +-- capabilities/
|   |   +-- default.json          IPC permissions: libmpv, dialog, opener, webview-create
|   +-- Cargo.toml                Rust dependencies
|   +-- lib/                      libmpv DLLs (gitignored, populated by setup-lib)
+-- ffmpeg/                       ffmpeg binaries (not bundled in tauri.conf.json)
|   +-- bin/ffmpeg.exe
+-- index.html                    Vite entry point
+-- package.json
+-- vite.config.ts
+-- tsconfig.json
+-- tsconfig.node.json
+-- CLAUDE.md                     Notes for AI coding assistants
```

### Frontend (`src/`)

The frontend is a React 18 application using function components and hooks exclusively. There is no state management library — all state lives in the `useAppState` hook and is passed down via props. The styling is plain CSS with CSS custom properties for theming.

### Rust Backend (`src-tauri/src/`)

The backend is a Tauri 2 application that registers three Tauri plugins (`tauri-plugin-libmpv`, `tauri-plugin-dialog`, `tauri-plugin-opener`) and exposes 16 IPC commands. It manages three pieces of shared state via `Mutex<T>`:

| State | Type | Contents |
|---|---|---|
| `FfmpegState` | `ffmpeg::FfmpegState` | Resolved ffmpeg path + probed HW encoder support |
| `AppPaths` | `paths::AppPaths` | Configurable Fast-edit root directory |
| `MangofetchState` | `mangofetch::MangofetchState` | mangofetch binary path + temp download directory |

### ffmpeg Module (`src-tauri/src/ffmpeg/`)

The ffmpeg module is split into four files for clarity:

| File | Responsibility |
|---|---|
| `mod.rs` | Path resolution (`find_ffmpeg`), export orchestration (`run_export`), thumbnail extraction, Tauri command handlers |
| `args.rs` | Argument construction for segment extraction and merge operations, HW encoder resolution logic |
| `process.rs` | Subprocess spawning with `CREATE_NO_WINDOW`, stderr progress parsing (`time=` regex), HW support probing |
| `temp.rs` | Filename pattern expansion (`{original}`, `{n}`), `TempCleanup` RAII guard for merge temp files |
| `types.rs` | All Rust types: `ExportParams`, `Codec`, `Container`, `HwEncoder`, `HwSupport`, `ExportMode`, `CodecMode` |

---

## Frontend Deep Dive

### Entry Point and Routing

`main.tsx` reads `window.location.hash` to determine which component to render:

```tsx
const hash = window.location.hash.replace("#", "");

function rootComponent() {
  if (hash === "downloader")    return <Downloader />
  if (hash === "scroll-panel")  return <ScrollPanelApp />
  return <App />
}
```

Before React mounts, `main.tsx` also:
1. Adds a CSS scope class to `<html>` (`downloader-window` or `scroll-panel-window`) so window-specific styles don't leak
2. Reads the persisted accent color from `localStorage` and sets `data-accent` on `<html>` to avoid a color flash on first paint

### State Management

All application state lives in the `useAppState` hook (`hooks/useAppState.ts`). This hook returns a `[state, actions]` tuple:

**State includes:**
- `segments: Segment[]` — the marked time ranges
- `selectedSegmentId: string | null` — which segment is selected
- `playheadPosition: number` — current time in seconds
- `duration: number` — video duration (from mpv)
- `fps: number` — container frame rate (from mpv, used for wheel-step calculation)
- `isPlaying: boolean`, `isMuted: boolean`
- `filePath: string` — currently loaded video file
- `showExportModal`, `showSettingsModal` — modal visibility flags
- `framesPerScrollTick`, `secondsPerShiftScrollTick` — configurable scroll-wheel step sizes
- `hwEncoder: HwEncoder` — user's hardware encoder preference
- `accentColor: AccentColor` — chosen UI accent color
- `showScrollPanel: boolean` — whether the floating scroll-step panel is open
- `mpvError: string | null` — error message from mpv initialization

**Undo/redo:** The hook maintains two stacks (`undoStack`, `redoStack`) with a maximum depth of 3. Each entry is a `Snapshot` containing `{ segments, selectedSegmentId }`. Snapshots are pushed before any mutation that constitutes an "Action" (add, delete, split, set start/end, drag handle). The `beginDrag()` / `endDrag()` pattern ensures an entire handle drag is recorded as one history entry.

**Persistence:** User settings (scroll-step values, HW encoder, accent color, scroll panel visibility) are persisted to `localStorage` under the key `video-trimmer-settings`. Settings load synchronously at module initialization time.

### Hooks

| Hook | File | Purpose |
|---|---|---|
| `useAppState` | `hooks/useAppState.ts` | Central state, undo/redo, settings persistence |
| `useMpv` | `hooks/useMpv.ts` | libmpv plugin lifecycle: `init()`, property observation (`time-pos`, `duration`, `pause`, `eof-reached`, `mute`, `container-fps`), `ResizeObserver` for video panel, `loadfile` on path change |
| `useKeyboard` | `hooks/useKeyboard.ts` | Global `keydown` listener, maps keys to actions via `useShortcuts`. Uses refs to avoid re-registering on every render |
| `useShortcuts` | `hooks/useShortcuts.ts` | Rebindable shortcut bindings (8 actions). Defaults: Space, Arrow Left/Right, I, O, Delete, Ctrl+Z, Ctrl+Shift+Z. Persisted to `localStorage` under `video-trimmer-shortcuts` |
| `useWheelSeek` | `hooks/useWheelSeek.ts` | Global `wheel` listener (non-passive, to allow `preventDefault`). Wheel = frame-step, Shift+wheel = second-step. Suppressed when modals are open or focus is on form controls |
| `useFileDrop` | `hooks/useFileDrop.ts` | Tauri `onDragDropEvent` handler, filters by video file extension (mp4, webm, mkv, mov) |

**Important patterns:**
- `useMpv` calls `init()` once on mount and **never** calls `destroy()` — the plugin tears down on `WindowEvent::CloseRequested`. This is safe because `init()` is idempotent, which matters because React StrictMode double-invokes effects in development.
- Both `useKeyboard` and `useWheelSeek` read state through refs (not direct dependencies) to avoid re-registering event listeners on every state change. This is a performance optimization — keyboard and wheel listeners fire frequently.

### Components

| Component | File | Description |
|---|---|---|
| `PlaybackControls` | `components/PlaybackControls.tsx` | Unified control bar spanning the full window width. Contains: play/pause, frame-step forward/back, mute toggle, Set Start/Set End buttons, Split, Delete, Next segment, segment counter indicator, and a zoom slider |
| `Timeline` | `components/Timeline.tsx` | The main editing surface. Renders a time ruler, colored segment blocks with drag handles, the playhead, and filmstrip thumbnails. Wheel listener is attached natively (non-passive) so `preventDefault` works. Supports zoom and panning centered on the playhead |
| `ExportModal` | `components/ExportModal.tsx` | Modal dialog for export configuration: output directory picker (via `pick_output_dir` Tauri command), export mode (separate/merge), codec mode (copy/reencode), codec (H.264/H.265/VP9), CRF quality slider, container override (source/MP4/MKV/WebM), filename pattern with live preview. Codec choices are dynamically filtered by container compatibility. Progress bar driven by `export-progress` Tauri events |
| `SettingsModal` | `components/SettingsModal.tsx` | Scroll-step sliders, HW encoder dropdown (options gated by probed `HwSupport` from the backend), accent color swatches, and Fast-edit data root folder picker |
| `ShortcutsModal` | `components/ShortcutsModal.tsx` | Lists all rebindable actions with their current bindings. Click a binding to enter capture mode, then press the new key/combo. Refuses to bind Escape, Tab, Shift, Control, Alt, or Meta as standalone keys. Reset button restores defaults |
| `ScrollPanelApp` | `components/ScrollPanelApp.tsx` | Standalone component for the floating scroll-step panel window. Contains the same two sliders as the Settings modal. Communicates with the main window via Tauri `emit`/`listen` events (`scroll-settings` and `scroll-settings-change`), not shared in-process state |
| `Downloader` | `downloader/Downloader.tsx` | Full download UI: URL input, quality selector (best/1080p/720p/480p/360p/audio-only), indeterminate progress with phase labels (fetching/downloading/muxing/done), Open Temp Folder button, Delete Temp button. Auto-installs mangofetch if missing, runs background self-update on mount |

### CSS and Theming

- **No CSS framework** — all styling is plain CSS in `App.css` and `downloader.css`
- **Dark theme** with OKLCH color variables:
  - `--bg-deep`: deepest background (sidebars)
  - `--bg-toolbar`: toolbar/control bar background
  - `--bg-surface`: general surface background
  - `--bg-modal`: modal background (one step brighter than surface for readability)
- **Transparent window** — `body` and `.video-panel` have `background: transparent` so mpv can paint behind the WebView
- **Accent color palette** — five presets (red, gold, green, blue, purple) selectable in Settings. OKLCH values are defined per-accent under `:root[data-accent="..."]` selectors. The accent drives segment selection highlights, buttons, and active states
- **CSS scoping for multi-window** — downloader-specific styles must be scoped to `.downloader-window` to avoid leaking into the main window (Vite bundles all CSS into one global stylesheet). Failure to scope causes: opaque body hiding mpv video, or wrong modal background colors

---

## Backend Deep Dive

### Startup Sequence

When the app launches, `lib.rs` runs the following setup in order:

1. **Register plugins** — `tauri-plugin-opener`, `tauri-plugin-dialog`, `tauri-plugin-libmpv`
2. **Initialize `FfmpegState`** — resolve the ffmpeg binary path via `find_ffmpeg`, then probe HW encoder support by running `ffmpeg -encoders` and grepping for `h264_nvenc`, `h264_qsv`, `h264_amf`
3. **Initialize `AppPaths`** — load the configurable Fast-edit root from `app_local_data_dir/app_paths.json`, defaulting to `Documents/Fast-edit`. Ensures the directory exists
4. **Initialize `MangofetchState`** — detect the mangofetch binary on PATH or in `~/.cargo/bin`, set temp dir to `<fast_edit_root>/Temp video files`
5. **Register command handlers** — 16 commands total (see table below)

### Tauri Commands (IPC)

All frontend-to-backend communication goes through Tauri's `invoke()` IPC mechanism. The registered commands:

| Command | Module | Description |
|---|---|---|
| `export_segments` | `ffmpeg` | Run ffmpeg to export segments (separate or merge mode) |
| `pick_output_dir` | `ffmpeg` | Open native folder picker dialog, return path |
| `get_hw_support` | `ffmpeg` | Return probed `HwSupport { nvenc, qsv, amf }` |
| `generate_thumbnails` | `ffmpeg` | Extract N evenly-spaced JPEG thumbnails as base64 data URIs |
| `get_mangofetch_config` | `mangofetch` | Return `{ installed, mangofetchPath, tempDir }` |
| `install_mangofetch` | `mangofetch` | Run `cargo install mangofetch`, emit phase events |
| `update_mangofetch` | `mangofetch` | Run `mangofetch update`, emit phase events |
| `download_video` | `mangofetch` | Download a URL at the specified quality, emit progress events |
| `get_temp_dir` | `mangofetch` | Return the temp download directory path |
| `clear_temp_dir` | `mangofetch` | Delete all files in the temp directory |
| `default_save_dir` | `project` | Return the default project save directory (`<root>/saves`) |
| `save_project` | `project` | Serialize a `Project` to a `.vtproj.json` file |
| `load_project` | `project` | Deserialize and validate a `.vtproj.json` file |
| `get_fast_edit_root` | `paths` | Return the current Fast-edit root directory |
| `set_fast_edit_root` | `paths` | Move the Fast-edit folder to a new location |

### ffmpeg Integration

**Path resolution:** `find_ffmpeg()` searches in two locations:
1. `<resource_dir>/ffmpeg/bin/ffmpeg.exe` — for production bundles
2. Walking up from the current executable directory — handles dev mode where the debug binary is deep inside `src-tauri/target/debug/`

**Subprocess execution:** All ffmpeg invocations use `CREATE_NO_WINDOW` (flag `0x0800_0000`) on Windows to prevent console window flashes. Progress is parsed from ffmpeg's stderr output by matching the `time=HH:MM:SS.mm` pattern and computing percent based on segment duration.

**Thumbnail extraction:** The `generate_thumbnails` command spawns all ffmpeg seeks **in parallel** (one thread per thumbnail) so the total wall-clock time is approximately one seek, not N sequential seeks. Each thread extracts a 160px-wide JPEG frame and returns it as a base64 data URI.

**Temp file cleanup:** The `TempCleanup` RAII guard tracks temporary segment files created during merge mode. If any step fails (or the function returns early), the guard's `Drop` implementation deletes all tracked files so no orphaned temp segments are left behind.

### Hardware Encoder Support

At startup, the backend runs `ffmpeg -encoders` and checks for:
- `h264_nvenc` / `hevc_nvenc` (NVIDIA)
- `h264_qsv` / `hevc_qsv` / `vp9_qsv` (Intel Quick Sync)
- `h264_amf` / `hevc_amf` (AMD)

The `HwSupport` struct is stored in `FfmpegState` and exposed to the frontend via the `get_hw_support` command. The Settings modal uses this to gate which encoder options appear in the dropdown.

**Encoder resolution logic** (in `args.rs`):
1. `HwEncoder::None` — always use software encoder (`libx264`, `libx265`, `libvpx-vp9`)
2. `HwEncoder::Auto` — pick the best available: NVENC > QSV > AMF. Falls back to software if no HW encoder supports the chosen codec
3. `HwEncoder::Nvenc` / `Qsv` / `Amf` — use the specified family if supported, fall back to software otherwise
4. **CRF 0 (lossless) always forces software encoding** regardless of HW preference — HW lossless support varies wildly

**Rate-control flags per family:**
- NVENC: `-rc constqp -qp <crf>`
- QSV: `-global_quality <crf>`
- AMF: `-rc cqp -qp_i <crf> -qp_p <crf> -qp_b <crf>`

### Video Downloader (mangofetch)

The downloader uses [mangofetch](https://crates.io/crates/mangofetch), a Rust CLI tool that wraps yt-dlp for video/audio downloading. The backend module (`mangofetch.rs`) manages:

- **Detection:** Searches for `mangofetch` (or `mangofetch.exe`) on PATH, then falls back to `~/.cargo/bin/mangofetch`
- **Auto-install:** If not found and `cargo` is available, runs `cargo install mangofetch` (first install compiles from source and can take several minutes). If cargo itself is missing, emits a `cargoMissing` phase so the UI can show a rustup.rs link
- **Background update:** Runs `mangofetch update` on startup to keep yt-dlp current
- **Download:** Spawns `mangofetch -v download -o <temp_dir> -y [flags] -- <url>`, parses verbose stderr for coarse phase transitions (fetching/downloading/muxing), emits `mangofetch-progress` events. The final downloaded file is identified by scanning the temp dir for the largest new file created during the run

**ANSI stripping:** mangofetch outputs colorized terminal output. The `strip_ansi()` function removes CSI sequences while preserving multi-byte UTF-8 characters.

### Project Save/Load

Project files (`.vtproj.json`) are JSON with this schema:

```json
{
  "version": 1,
  "savedAt": "2026-05-30T14:32:11Z",
  "filePath": "F:\\videos\\clip.mp4",
  "duration": 123.456,
  "playheadPosition": 42.5,
  "segments": [
    { "id": "abc", "start": 1.0, "end": 5.25, "color": "#ff0000" },
    { "id": "def", "start": 10.0, "end": 12.0, "color": "#00ff00" }
  ]
}
```

The `version` field is validated on load — only version `1` is currently supported. Loading a project:
1. The frontend calls `load_project` with the file path
2. The backend reads, parses, and validates the JSON, returning a `Project` struct
3. The frontend restores segments via `actions.loadProject(project)`
4. The playhead is restored via a `pendingSeekRef` — the seek is deferred until mpv reports the video's duration (indicating the file has loaded)

The default save directory is `<fast_edit_root>/saves`, created on demand.

### Configurable Data Root

The Fast-edit root directory (default: `Documents/Fast-edit`) is configurable via Settings. It contains:
- `saves/` — project files
- `Temp video files/` — downloaded videos

The `set_fast_edit_root` command validates the new path (must be absolute, not nested inside current root, target must be empty or non-existent), moves the existing directory contents (atomic `rename` if same volume, recursive copy+delete for cross-volume), persists the new path to `app_paths.json`, and updates both `AppPaths` and `MangofetchState` in memory.

---

## Keyboard Shortcuts

Shortcuts are **rebindable** and persisted under the `video-trimmer-shortcuts` localStorage key. Defaults:

| Action | Default Binding | Description |
|---|---|---|
| Play / Pause | `Space` | Toggle playback |
| Set Start | `I` | Move selected segment's start to playhead |
| Set End | `O` | Move selected segment's end to playhead |
| Frame Back | `Left Arrow` | Step one frame backward |
| Frame Forward | `Right Arrow` | Step one frame forward |
| Delete Segment | `Delete` | Remove the selected segment |
| Undo | `Ctrl+Z` | Undo last segment edit |
| Redo | `Ctrl+Shift+Z` | Redo last undone edit |

**Binding format:** Canonical `Combo` string — lowercase modifiers in fixed order `ctrl`, `shift`, `alt`, `meta` joined with `+`, then the key. Examples: `ctrl+z`, `ctrl+shift+z`, `i`, `Delete`.

**Suppression:** All keyboard shortcuts and scroll-wheel seeking are disabled when any modal is open (export, settings, shortcuts) or when focus is on an `input`, `select`, or `textarea` element.

---

## Scroll-Wheel Seeking

The mouse wheel is used for frame-accurate seeking anywhere in the window:

| Input | Behavior | Configurable Range |
|---|---|---|
| Wheel scroll | Step N frames forward/backward | 1–30 frames per tick (default: 5) |
| Shift + wheel | Step N seconds forward/backward | 1–20 seconds per tick (default: 1) |

The frame step size uses the video's actual `container-fps` (reported by mpv) for accurate frame boundaries. If mpv hasn't reported fps yet, a fallback of 30 fps is used.

Scroll-step values can be tuned in:
1. **Settings modal** — standard sliders
2. **Floating scroll panel** — an always-on-top decoration-free window that can stay visible while editing

The scroll panel communicates with the main window via Tauri `emit`/`listen` events, keeping values in sync in both directions.

---

## Timeline and Segments

### Segment Rules

- **Segments cannot overlap.** Handle dragging is clamped at neighboring segment boundaries
- **Segments cannot invert.** A minimum gap of ~0.033s (roughly one frame at 30fps) is enforced between start and end
- **Minimum segment duration** for the "add segment" action is 0.1 seconds
- **Minimum visual width** of a segment on the timeline is 4 pixels, ensuring very short segments remain grabbable

### NLE-Style Timeline

The timeline displays segments as an NLE (Non-Linear Editor): segments are laid out cumulatively by their kept-content duration, and the gaps between them (deleted content) are collapsed away. The user sees only the portions of the video they've chosen to keep.

Helper functions in `utils.ts` handle the coordinate transformation:
- `sourceToKept(srcT, sorted)` — map a source-video time to the kept-timeline time
- `keptToSource(keptT, sorted)` — map a kept-timeline time back to the source-video time
- `keptDuration(segs)` — total duration of all kept segments
- `keptOffsetOfSegment(sorted, index)` — cumulative kept-time offset of a segment

### Filmstrip Thumbnails

When a video is loaded and its duration is known, `App.tsx` calls the `generate_thumbnails` Tauri command to extract 30 evenly-spaced JPEG thumbnails. These are returned as base64 data URIs and rendered as a filmstrip background behind the segment blocks on the timeline.

Thumbnail extraction runs in parallel — all 30 ffmpeg seeks happen simultaneously on separate threads, so the total time is approximately one seek rather than 30 sequential seeks.

### Zoom

Timeline zoom is controlled by a slider in the PlaybackControls bar:

- **Zoom 1x** = entire video fits in the timeline width
- **Higher zoom** = shows a window of `duration / zoom` seconds centered on the playhead
- **Range:** 1x to 500x (enough for 2+ hour files to zoom to a 60-second window)
- **Default on file load:** `duration / 60` (clamped to range), so ~60 seconds of timeline are visible by default. A 10-second clip stays at 1x; a 2-hour file opens at 120x.

---

## Export System

### Export Modes

| Mode | Behavior |
|---|---|
| **Separate** | Each segment is exported as its own file. Filename pattern `{original}_{n}` produces `myfile_1.mp4`, `myfile_2.mp4`, etc. |
| **Merge** | All segments are individually extracted to temp files, then concatenated via ffmpeg's concat demuxer into a single output file. The `TempCleanup` RAII guard ensures temp segments are deleted even if the merge step fails. |

### Codec and Container Matrix

| Codec Mode | Codec | Supported Containers | Audio Encoder |
|---|---|---|---|
| **Copy** | *(passthrough)* | Source format only | *(passthrough)* |
| **Re-encode** | H.264 (`libx264`) | MP4, MKV | AAC |
| **Re-encode** | H.265 (`libx265`) | MP4, MKV | AAC |
| **Re-encode** | VP9 (`libvpx-vp9`) | MKV, WebM | libopus (WebM), AAC (MKV) |

**Compatibility enforcement:**
- VP9 in MP4/MOV → rejected with error
- H.264/H.265 in WebM → rejected with error

The CRF quality slider ranges from 0 (lossless, always forces software encoder) to 51 (worst quality).

### ffmpeg Argument Shapes

```bash
# Stream copy (fast, keyframe-aligned)
ffmpeg -ss <start> -to <end> -i <input> -c copy -avoid_negative_ts make_zero -y <output>

# Software re-encode
ffmpeg -ss <start> -to <end> -i <input> -c:v libx264 -crf <quality> -c:a aac -y <output>

# NVENC hardware encode
ffmpeg -ss <start> -to <end> -i <input> -c:v h264_nvenc -rc constqp -qp <crf> -c:a aac -y <output>

# QSV hardware encode
ffmpeg -ss <start> -to <end> -i <input> -c:v h264_qsv -global_quality <crf> -c:a aac -y <output>

# AMF hardware encode
ffmpeg -ss <start> -to <end> -i <input> -c:v h264_amf -rc cqp -qp_i <crf> -qp_p <crf> -qp_b <crf> -c:a aac -y <output>

# Merge segments (concat demuxer)
ffmpeg -f concat -safe 0 -i list.txt -c copy -y <output>
```

> The concat list file uses forward slashes on all platforms (ffmpeg's concat demuxer treats backslashes as escape characters). Single quotes in paths are escaped as `'\''`.

---

## Undo/Redo System

The undo system uses a **snapshot-based** approach with a maximum depth of 3:

- **What's captured:** `{ segments: Segment[], selectedSegmentId: string | null }`
- **What's NOT captured:** playhead position, play/pause state, mute, modal state, settings — undoing an edit doesn't rewind playback or close dialogs
- **What counts as an Action:** add segment, delete segment, split segment, set start/end (via buttons or `I`/`O` keys), drag a handle
- **What does NOT count:** playhead movement, segment selection, play/pause/mute, modal open/close, settings changes, file/project load
- **Drag coalescing:** `beginDrag()` pushes a snapshot before the first drag update; `endDrag()` is a no-op. This way, an entire mousedown-to-mouseup drag is one undo step regardless of how many intermediate updates fired
- **History clearing:** Loading a new file or project clears both undo and redo stacks

---

## Settings and Persistence

Settings are split across two `localStorage` keys:

| Key | Owner | Contents |
|---|---|---|
| `video-trimmer-settings` | `useAppState` | `framesPerScrollTick`, `secondsPerShiftScrollTick`, `hwEncoder`, `showScrollPanel`, `accentColor` |
| `video-trimmer-shortcuts` | `useShortcuts` | Map of action names to key bindings |

Both load synchronously at module initialization time (before first render).

Additional persisted values:
- `sidebar-expanded` — boolean, whether the left icon sidebar is expanded (separate localStorage key)
- `app_paths.json` — Fast-edit root directory, persisted to Tauri's `app_local_data_dir`

---

## Project Files (.vtproj.json)

Format: JSON, schema version 1.

```json
{
  "version": 1,
  "savedAt": "ISO 8601 timestamp",
  "filePath": "absolute path to source video",
  "duration": 123.456,
  "playheadPosition": 42.5,
  "segments": [
    { "id": "uuid", "start": 0.0, "end": 5.0, "color": "#hex" }
  ]
}
```

- Default save location: `<fast_edit_root>/saves/`
- Suggested filename: `<video_stem>.vtproj.json`
- Loading a project restores segments and playhead; undo/redo history is cleared
- The `version` field is validated — unsupported versions are rejected with an error message

---

## Accent Colors

Five preset accent colors are available in the Settings modal:

| Name | OKLCH Value | Preview |
|---|---|---|
| Red (default) | `oklch(0.68 0.19 25)` | Active buttons, selection highlights |
| Gold | `oklch(0.78 0.16 65)` | |
| Green | `oklch(0.74 0.17 150)` | |
| Blue | `oklch(0.68 0.16 250)` | |
| Purple | `oklch(0.65 0.20 310)` | |

The accent color is applied via `<html data-accent="red">` and read by CSS custom property selectors in `App.css`. All windows share the same `localStorage` and pick up the accent on mount.

---

## Known Gotchas

1. **Fresh clone requires `npx tauri-plugin-libmpv-api setup-lib`** — builds will fail without the libmpv DLLs in `src-tauri/lib/`

2. **React `onWheel` is passive** — `preventDefault()` is a no-op in React's synthetic wheel events. Both `Timeline` and `useWheelSeek` use `addEventListener('wheel', ..., { passive: false })` instead

3. **StrictMode double-invokes effects** — `useMpv` relies on the plugin's `init()` being idempotent and never calls `destroy()` in cleanup (that would race with in-flight `loadfile` commands)

4. **Transparent window** — the Tauri window is `transparent: true`. Any UI region without an explicit opaque background will show through to the desktop

5. **Vite CSS global leak** — Vite bundles all imported CSS into one global stylesheet regardless of which component imports it. Downloader-specific rules that touch `html`/`body`/`#root` or share class names with `App.css` (`.modal`, `.modal-input`, etc.) **must be scoped to `.downloader-window`**. Failure mode: opaque body hides mpv video, or wrong modal background color

6. **`tauri::Emitter` must be in scope** — to call `app_handle.emit(...)` in Rust, you need `use tauri::Emitter;` alongside `use tauri::Manager;`. Without it, the compiler gives a confusing "no method named `emit`" error

7. **`WebviewWindow.getByLabel()` is async in Tauri v2** — returns `Promise<WebviewWindow | null>`, not a synchronous value. Always `await` it before calling `.setFocus()` or similar methods

8. **ffmpeg concat demuxer and Windows paths** — the concat list file must use forward slashes (backslashes are treated as escape characters by ffmpeg's concat demuxer). The `strip_unc_prefix` function also removes Windows' `\\?\` verbatim prefix that `canonicalize()` adds, as some ffmpeg builds choke on UNC-style paths

9. **`CREATE_NO_WINDOW` for subprocess spawning** — all ffmpeg and mangofetch invocations on Windows use creation flag `0x0800_0000` to suppress console window flashes

---

## Roadmap

- [ ] Multi-file projects (queue several recordings together)
- [ ] Audio waveform overlay on the timeline
- [ ] Per-segment fade in/out
- [ ] Export presets (codec, resolution, bitrate)
- [ ] CI builds for Windows, macOS, and Linux releases
- [ ] Bundle ffmpeg in `tauri.conf.json` resources for self-contained distribution

---

## Contributing

Contributions are very welcome. Before opening a PR:

1. Open an issue first for anything larger than a bug fix or small polish, so we can agree on the shape before code gets written
2. Match the existing style — TypeScript strict mode, function components, no implicit `any`, plain CSS (no framework)
3. If your change touches the undo behavior or the keyboard shortcut model, test those flows manually
4. CSS for new windows or components that share class names with `App.css` must be scoped to avoid the Vite CSS global leak
5. `npm run tauri dev` should run cleanly with no console errors after your change

---

## License

[MIT](LICENSE)

---

<div align="center">
<sub>Built with Tauri, React, and mpv. Cuts long recordings down to the good parts.</sub>
</div>
