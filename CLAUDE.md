# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Tauri v2 desktop app for video trimming. Users open a video file, mark one or more segments on a timeline, and export them via ffmpeg (with optional re-encode). Playback uses libmpv via [`tauri-plugin-libmpv`](https://github.com/nini22P/tauri-plugin-libmpv); ffmpeg handles export.

## Commands

```bash
# Full dev mode (Rust backend + React frontend with hot reload)
npm run tauri -- dev

# Frontend only (no Rust, for UI iteration)
npm run dev

# Production build
npm run tauri -- build

# Type-check frontend
npm run build

# Rust unit tests (ffmpeg arg builder, time parser, filename expansion)
cd src-tauri && cargo test

# One-time setup: download libmpv-2.dll + libmpv-wrapper.dll into src-tauri/lib/
# Required after a fresh clone — the DLLs are gitignored.
npx tauri-plugin-libmpv-api setup-lib
```

No lint command is configured.

## Architecture

### Communication Flow

```
React (WebView, transparent)  ←→  Tauri IPC  ←→  Rust
                                                  ├── tauri-plugin-libmpv → libmpv-2.dll (in-process FFI)
                                                  └── ffmpeg.rs           → ffmpeg.exe (subprocess)
                                              ▲
            mpv renders into the host window  │  behind the WebView, constrained
            to the #video-panel rect via setVideoMarginRatio.
```

There is no Rust mpv code in this repo. The plugin owns the mpv lifecycle, property observation, and command dispatch. The frontend talks to mpv directly via the plugin's TS API (`init`, `command`, `setProperty`, `observeProperties`, `setVideoMarginRatio`).

### Frontend (`src/`)

- `App.tsx` — root component; lays out the chrome and a `#video-panel` div (the slot mpv renders behind). Manages segment state via `useAppState`.
- `constants.ts` / `types.ts` / `utils.ts` — single source of truth for constants (timeline dims, scroll-step bounds, color palette), shared types (`Segment`, `Codec`, `Container`, `HwEncoder`, `HwSupport`), and helpers (`clamp`, `newId`, `pickColor`, `expandFilename`, `formatTime`).
- `hooks/useMpv.ts` — owns the libmpv plugin lifecycle:
  - `init()` once on mount with `vo: gpu-next`, `hwdec: auto-safe`, `keep-open: yes`, `force-window: yes`, `pause: yes`, `hr-seek: yes`. Idempotent — never calls `destroy()` (the plugin tears down on `WindowEvent::CloseRequested`).
  - Observes `time-pos` / `duration` / `pause` / `eof-reached` / `mute` / `container-fps` and pushes them into `AppState`. `container-fps` drives the wheel-step calculation.
  - ResizeObserves `#video-panel` and calls `setVideoMarginRatio({left, right, top, bottom})` so mpv only paints inside that rectangle.
  - Calls `command('loadfile', [path])` when `filePath` changes.
  - Returns `{ play, pause, seek, frameStep, frameBackStep, setMute }`.
- `hooks/useAppState.ts` — single state hook holding segments, playhead, duration, fps, mute, file path, modal/error state, and persisted user settings (scroll-step values, HW encoder, scroll panel visibility). Persists settings to localStorage under `video-trimmer-settings`.
- `hooks/useKeyboard.ts` — global keydown handler (Space, ←/→, I, O, Delete); reads state via refs to avoid re-registering on every render.
- `hooks/useWheelSeek.ts` — **global** window-level wheel listener (non-passive). Wheel = step `framesPerScrollTick` frames using clip's real fps; Shift+wheel = step `secondsPerShiftScrollTick` seconds. Suppressed when modals are open or focus is on form controls. Mirrors `useKeyboard`'s ref-based pattern.
- `hooks/useFileDrop.ts` — Tauri webview drag-drop, filtered by extension.
- `components/PlaybackControls.tsx` — unified control bar: transport (play/pause/frame-step/mute), segment edit (set start/end, add/delete, Next ▸), and zoom slider.
- `components/Timeline.tsx` — ruler, segments, playhead, drag handles. Wheel listener attached natively (non-passive) so `preventDefault` works.
- `components/ExportModal.tsx` — output dir picker, mode/codec/container/quality form, progress UI driven by the `export-progress` Tauri event. Codec choices filtered by container; HW encoder label reflects current `hwEncoder` setting (CRF 0 always forces software).
- `components/SettingsModal.tsx` — scroll-step sliders, HW encoder dropdown (gated by probed `HwSupport`), and toggle for the floating scroll panel.
- `components/ScrollSettingsPanel.tsx` — draggable floating panel mirroring the two scroll-step sliders from the Settings modal so they can be tuned while editing. Visibility persisted.
- File drop is handled via Tauri's `onDragDropEvent`.
- No CSS framework — custom dark theme. The body and `.video-panel` are `background: transparent`; every chrome region (top bar, controls, timeline, modal) sets its own opaque background.

### Rust Backend (`src-tauri/src/`)

- **`lib.rs`** — registers `tauri_plugin_libmpv::init()`, `tauri_plugin_dialog`, `tauri_plugin_opener`. At startup, resolves ffmpeg path AND probes HW encoder support (`probe_hw_support`), storing both in `FfmpegState`. Registers three commands: `export_segments`, `pick_output_dir`, `get_hw_support`.
- **`ffmpeg.rs`** — spawns `ffmpeg.exe` for each segment (or merge step), parses stderr `time=` for progress, emits `export-progress` events. Supports container override (source/mp4/mkv/webm — drives audio codec choice: WebM → libopus, others → aac) and HW encoder selection (NVENC/QSV/AMF) with auto-priority NVENC → QSV → AMF. CRF 0 (lossless) always forces the software encoder regardless of HW choice. On Windows, all spawned `ffmpeg.exe` invocations use `CREATE_NO_WINDOW` (`hide_console`) so no console flashes. Includes `TempCleanup` RAII guard so a mid-merge error doesn't leave temp segments behind. Has unit tests for arg building, progress parsing, and filename expansion.
- **`main.rs`** — minimal entry point, calls `edit_lib::run()`.

### libmpv setup

The plugin needs two DLLs at runtime, both in `src-tauri/lib/` (gitignored):

- `libmpv-2.dll` — libmpv (~96 MB). The mpv player core compiled as a shared library.
- `libmpv-wrapper.dll` — thin C ABI shim the plugin loads via `libloading`.

Run `npx tauri-plugin-libmpv-api setup-lib` to download both. `tauri.conf.json` bundles `lib/**/*` as resources so they ship with `tauri build`.

### ffmpeg

`ffmpeg.exe` is **not** currently bundled (no resource entry in `tauri.conf.json`). `find_ffmpeg` resolves it by checking `<resource_dir>/ffmpeg/bin/ffmpeg.exe` first, then walks up from the current executable to find `ffmpeg/bin/ffmpeg.exe` or `ffmpeg/ffmpeg.exe` — which works in dev because the project root has `ffmpeg/bin/ffmpeg.exe`. For production builds, either re-add the resource entry or document that ffmpeg must be installed alongside the binary.

#### ffmpeg argument shapes

```bash
# Stream copy (fast, keyframe-aligned)
ffmpeg -ss <start> -to <end> -i <input> -c copy -avoid_negative_ts make_zero <output>

# Re-encode (frame-accurate)
ffmpeg -ss <start> -to <end> -i <input> -c:v <codec> -crf <quality> -c:a aac <output>

# HW encoders use a per-family rate-control flag (instead of -crf):
#   NVENC: -c:v {h264,hevc}_nvenc -rc constqp -qp <crf>
#   QSV:   -c:v {h264,hevc,vp9}_qsv -global_quality <crf>
#   AMF:   -c:v {h264,hevc}_amf -rc cqp -qp_i <crf> -qp_p <crf> -qp_b <crf>

# Merge segments — concat list paths use forward slashes; single quotes escaped as '\''
ffmpeg -f concat -safe 0 -i list.txt -c copy <output>
```

Merge mode picks the temp-file extension to match the input's container in copy mode (so mp4-incompatible codecs like VP9/Opus don't fail) and `.webm` for VP9 reencode.

### Segment Rules

Segments cannot overlap. Handle dragging is clamped at neighboring segment boundaries. "Add Segment" creates a 5-second default at the playhead, clamped to video bounds and shrunk to avoid overlap.

## Key Design Decisions

- **No UI framework** — plain CSS, small bundle, no style conflicts with the libmpv render area.
- **libmpv via plugin** — mpv runs in-process as `libmpv-2.dll`; no subprocess, no named pipe IPC. The Tauri window is `transparent: true` and mpv paints behind the WebView, with its render rect constrained to the `#video-panel` div via `setVideoMarginRatio`. Property changes (time-pos, duration, pause, eof-reached) flow back as `mpv-event-{windowLabel}` Tauri events.
- **Why transparency, not `--wid` HWND embedding** — the plugin's primary integration mode is the transparent overlay. It does support `--wid` override, but the overlay path needs no Win32 child-window code on our side and `setVideoMarginRatio` cleanly handles the panel-rect plumbing.
- **Capabilities** — `libmpv:default` is required in `src-tauri/capabilities/default.json` to authorize the plugin's IPC commands.
- **Keyboard shortcuts** (Space, ←/→, I, O, Delete) and global scroll-wheel seeking are disabled when any modal is open (export OR settings) or focus is in an input/select/textarea.
- **Hardware encoder probe** — at startup, ffmpeg's `-encoders` output is grepped once for `h264_{nvenc,qsv,amf}` to populate `HwSupport`. The Settings modal queries this via the `get_hw_support` command to gate dropdown options.
- **Persisted settings** — scroll-step values, HW encoder choice, and scroll-panel visibility are written to `localStorage` under key `video-trimmer-settings` by `useAppState`. Loaded synchronously at module init.
- **Design spec** is in `2026-04-08-video-trimmer-design.md` — refer to it for UI layout, color palette, timeline interactions, and export modal details.

## Gotchas

- After a fresh clone, builds will fail until you run `npx tauri-plugin-libmpv-api setup-lib` to populate `src-tauri/lib/`.
- React `onWheel` attaches a passive listener — `preventDefault` is a no-op there. Both `Timeline` and the global `useWheelSeek` hook use `addEventListener('wheel', …, { passive: false })` instead.
- StrictMode double-invokes effects in dev. `useMpv` relies on the plugin's `init()` being idempotent (and never calls `destroy()` in cleanup, since that races with in-flight `loadfile` commands).
- The window is `transparent: true`. Any chrome region without an explicit opaque background will show through to the desktop.
