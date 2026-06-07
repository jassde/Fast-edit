# Context

Project glossary. Defines the terms used in this codebase precisely enough that two readers (or one reader and one Claude) won't mean different things by the same word.

This file is **not** a spec, design doc, or scratch pad. It is a glossary. Implementation lives in code; rationale for hard-to-reverse decisions lives in [docs/adr/](docs/adr/).

---

## Action

A user-initiated mutation of the segment list that participates in the undo/redo history.

The set of mutations that count as an Action is **closed and explicit**:

- **Add segment** — `addSegment` in `useAppState`.
- **Delete segment** — `deleteSegment`.
- **Edit segment start or end** — including:
  - The Set Start / Set End buttons in PlaybackControls.
  - The I / O keyboard shortcuts (which call `setSelectedStart` / `setSelectedEnd`).
  - A drag of a segment handle in Timeline. One mousedown→mouseup is **one** Action, regardless of how many intermediate `setSegmentStart`/`setSegmentEnd` calls fire during the drag.

The following are explicitly **not** Actions and do not appear in the undo history:

- Playhead movement (scrubbing, frame-step, wheel-seek, play position updates from mpv).
- Segment selection.
- Play / pause / mute.
- Modal open / close.
- Settings changes (HW encoder, scroll-step values, scroll-panel visibility).
- File load (`setFilePath`) or project load (`loadProject`) — these wipe segments entirely, and undoing back to a previous file would be surprising. Both events **clear** the undo and redo stacks instead.

See [docs/adr/0001-segment-undo-snapshot-stack.md](docs/adr/0001-segment-undo-snapshot-stack.md) for why the scope is this narrow.

## Segment

A contiguous time range `[start, end)` of the loaded video that the user has marked for export. Stored as `{ id, start, end, color }`. Segments cannot overlap; handle drags are clamped at neighboring segment boundaries. Invariant maintained in `useAppState`'s segment-mutation helpers.

## Snapshot

The unit stored on the undo and redo stacks. A Snapshot is `{ segments: Segment[], selectedSegmentId: string | null }` — enough state to restore the timeline to a previous moment.

Snapshots are intentionally **not** the full `AppState`: playhead position, playback state, and modal state are deliberately excluded so that undoing an edit doesn't also rewind playback or close a modal the user has open. See ADR-0001.

## Combo (keyboard)

A canonical string representation of a `KeyboardEvent` used as a rebindable shortcut binding. Format: `<modifiers>+<key>`, where modifiers are lowercase and appear in fixed order `ctrl, shift, alt, meta`, and `key` is the lowercase form of `KeyboardEvent.key` for printable keys or its raw form for named keys (`'Delete'`, `'ArrowLeft'`).

Examples: `'ctrl+z'`, `'ctrl+shift+z'`, `'i'`, `' '` (space), `'Delete'`.

A bare key (no modifiers) is still a valid Combo. Old single-character bindings stored under `video-trimmer-shortcuts` parse cleanly as zero-modifier Combos.
