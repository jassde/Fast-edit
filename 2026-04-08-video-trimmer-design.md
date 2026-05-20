# Video Timeline Trimmer — Design Spec

A Tauri desktop app (React frontend, Rust backend) for quickly cutting one or more segments from a video file and exporting them, preferably lossless. Uses local mpv for playback and local ffmpeg for export.

## Target Audience

Built for distribution — polished UI with tooltips, discoverability, and a clean workflow for new users.

## Supported Formats

MP4, WebM, MKV, MOV — common web/desktop video formats.

---

## UI Layout

Single window, stacked vertically:

1. **Top bar** — app title, Open File button, Export button.
2. **Video player** — mpv embedded via `--wid` into a native panel. Also the drag-and-drop target for opening files. Supports both drag-and-drop and file picker (Open File button / Tauri native dialog).
3. **Playback controls** — centered row: current time, frame-back, frame-forward, play/pause button, frame-forward, frame-back, total duration.
4. **Segment controls** — centered row: Set Start, Set End, Add Segment, Delete Segment buttons.
5. **Timeline** — 90px tall horizontal strip showing the full video duration. Contains:
   - Time ruler along the top with tick marks.
   - Colored segment blocks with 12px-wide draggable handles on each side (full height, with grip lines for affordance).
   - White playhead with a large triangle head (19px wide).
   - Click on ruler area to seek. Click a segment to select it. Scroll wheel steps the playhead forwards/backwards 5 frames.

Segments are color-coded (cycling through a palette) to distinguish them visually. The selected segment has a brighter border.

Dark theme throughout (backgrounds: `#1a1a2e`, `#16213e`, `#0d1117`; accents: `#4287f5`, `#e94560`, `#a0c4ff`).

---

## Architecture

### React Frontend (Webview)

- Renders all UI: top bar, playback controls, segment buttons, timeline, export modal.
- Manages segment state: array of `{ id, start, end, color }`, plus `selectedSegmentId`.
- Communicates with Rust via `invoke()` for commands, listens to Tauri events for position updates and export progress.
- Handles file drop events via Tauri's file drop API.

### Rust Backend (Tauri)

Three modules:

**mpv controller (`src-tauri/src/mpv.rs`)**
- Spawns `mpv.exe` with `--wid=<HWND>` and `--input-ipc-server=\\.\pipe\trimmer-mpv-{pid}`.
- Communicates via JSON IPC over named pipe.
- Commands: `loadfile`, `play`, `pause`, `seek`, `frame-step`, `frame-back-step`.
- Polls `time-pos` at ~30fps, emits `playback-position` events to frontend.
- Reports `duration` after file load.

**ffmpeg module (`src-tauri/src/ffmpeg.rs`)**
- Spawns `ffmpeg.exe` from the bundled `ffmpeg/bin/` directory.
- Builds command arguments based on export settings.
- Parses stderr for `time=` field to report progress.
- Emits `export-progress` events to frontend.

**window module (`src-tauri/src/window.rs`)**
- Obtains a native HWND from the Tauri window for the video panel area.
- Manages resize events to keep mpv's render area in sync.

### External Processes

- `mpv.exe` — checked in bundled directory first, then system PATH. If not found, show error with download instructions.
- `ffmpeg.exe` — bundled at `ffmpeg/bin/ffmpeg.exe` (already in project).

---

## Segment Workflow

1. User opens a video (drag-and-drop or file picker).
2. mpv loads the file; frontend receives duration and scales the timeline.
3. User navigates to desired position using play/pause, seeking, or frame-stepping.
4. User clicks "Add Segment" — creates a new segment at the playhead position with a default 5-second duration (clamped to video bounds and shrunk to avoid overlapping adjacent segments). The new segment is automatically selected.
5. User adjusts start/end by:
   - Dragging the segment handles on the timeline, OR
   - Navigating to the desired frame and clicking "Set Start" / "Set End" (or pressing I / O).
6. Repeat steps 3-5 for additional segments.
7. User clicks Export to open the export modal.

Segments cannot overlap. If a handle is dragged into another segment, it stops at that segment's boundary.

---

## Export Modal

Modal dialog over the main window with:

- **Output directory** — folder picker via Tauri native dialog, displays selected path.
- **Export mode** — radio buttons:
  - "Separate files" (default) — one output file per segment.
  - "Merge into one file" — concatenate all segments sequentially.
- **Codec mode** — radio buttons:
  - "Stream copy (fast)" (default) — `ffmpeg -c copy`. Near-instant, cuts on nearest keyframe.
  - "Re-encode (frame-accurate)" — reveals additional options:
    - Codec dropdown: H.264, H.265, VP9.
    - Quality: dropdown mapped to CRF values — Low (CRF 28), Medium (CRF 23), High (CRF 18), Lossless (CRF 0 / `-preset veryslow`).
- **Filename pattern** — text field, default: `{original}_segment_{n}`. Shows preview of first output filename.
- **Export button** — starts export. Modal transitions to show spinner with "Exporting..." status. On completion, shows success notification and closes.

### ffmpeg Commands

**Stream copy:**
```
ffmpeg -ss <start> -to <end> -i <input> -c copy -avoid_negative_ts make_zero <output>
```

**Re-encode:**
```
ffmpeg -ss <start> -to <end> -i <input> -c:v <codec> -crf <quality> -c:a aac <output>
```

**Merge (after individual segments are exported):**
```
ffmpeg -f concat -safe 0 -i list.txt -c copy <output>
```

Progress is parsed from ffmpeg's stderr (`time=` field), calculated as percentage of segment duration, and emitted as Tauri events.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space | Play / Pause |
| Left Arrow | Step back one frame (`frame-back-step`) |
| Right Arrow | Step forward one frame (`frame-step`) |
| I | Set start point of selected segment |
| O | Set end point of selected segment |
| Delete | Delete selected segment |

Shortcuts are active when the main window has focus. Disabled when the export modal is open.

---

## Timeline Interactions

- **Click on ruler** — seeks playhead to that position.
- **Click on segment** — selects it (highlighted border).
- **Click empty space** — deselects current segment.
- **Drag segment handle** — updates start/end time in real-time; playhead syncs to handle position for visual feedback.
- **Scroll wheel** — steps the playhead forwards or backwards 5 frames per tick.

---

## mpv Integration

- **IPC:** Named pipe `\\.\pipe\trimmer-mpv-{pid}` on Windows using mpv's JSON IPC protocol.
- **Embedding:** `--wid=<HWND>` renders video into a panel inside the Tauri window.
- **Position sync:** Rust polls `time-pos` at ~30fps, emits events to React for playhead updates.
- **Resize:** On window resize, Rust sends resize commands to keep mpv's render area in sync with the panel.
- **File loading:** `loadfile <path>` via IPC. mpv reports duration for timeline scaling.
- **Discovery:** Check bundled directory first, then system PATH. Show actionable error if not found.

---

## Tech Stack

- **Tauri v2** — desktop framework (Rust + Webview).
- **React 18** with TypeScript — frontend UI.
- **mpv** — video playback (external process, embedded via `--wid`).
- **ffmpeg** — video export (bundled at `ffmpeg/bin/ffmpeg.exe`).
- **CSS** — custom dark theme, no UI framework dependency (keeps bundle small and avoids style conflicts with the video-centric layout).

---

## Error Handling

- **mpv not found:** Show a prominent banner in the video area with a message and link to download mpv.
- **ffmpeg failure:** Show error in the export modal with the ffmpeg error message. Allow retry.
- **Unsupported file:** If mpv fails to load a file, show an error message in the video area.
- **IPC disconnection:** If mpv crashes or the pipe disconnects, show an error and offer to restart mpv.
- **Overlapping segments:** Prevent via handle clamping — handles stop at neighboring segment boundaries.
