# ADR-0001: Segment undo via a 3-deep in-memory snapshot stack

**Status:** Accepted — 2026-06-07

## Context

Users want a Ctrl+Z undo (and Ctrl+Shift+Z redo) for the timeline. The original request was "undo last action, go back upwards 3 actions, keyboard shortcut Ctrl+Z, rebindable in the Keyboard Shortcuts page."

This required deciding three things that are easy to get wrong and hard to change later:

1. **Scope** — what counts as an undoable Action?
2. **Storage** — how is each Action represented on the stack?
3. **Persistence and depth** — how deep is the history, and does it survive a reload?

The app state shape that frames these choices is in [`src/hooks/useAppState.ts`](../../src/hooks/useAppState.ts). It carries 17 fields spanning segments, playback, modals, settings, and persisted preferences.

## Decision

### Scope: segment edits only

Only mutations of the segment list count as Actions. Specifically: `addSegment`, `deleteSegment`, and any edit of a segment's start or end (Set Start / Set End buttons, I / O keys, or a drag-handle release). One mousedown→mouseup drag is one Action, not one per intermediate `setSegmentStart` call. Playhead, selection, playback, modal, settings, and file-load mutations are explicitly excluded. See [CONTEXT.md → Action](../../CONTEXT.md) for the canonical list.

### Storage: whole-segments snapshots

Each stack entry is a `Snapshot`: `{ segments: Segment[], selectedSegmentId: string | null }`. Undo restores that snapshot wholesale. There are no per-action inverse handlers ("undo an add" vs "undo a delete" vs "undo an edit"); the snapshot replaces state directly.

### Depth and persistence: 3 entries per stack, in-memory only

The undo and redo stacks each cap at 3 entries with FIFO eviction. Both are kept in `useRef<Snapshot[]>` — not part of `AppState`, not persisted to localStorage, not survived across reloads or window close. Both are cleared on `setFilePath` and `loadProject`. The redo stack is additionally cleared whenever a non-undo/redo Action pushes onto the undo stack.

## Alternatives considered

### Delta-encoded actions instead of snapshots

A typed record per stack entry — `{ type: 'add', segment } | { type: 'delete', segment } | { type: 'edit', id, before, after }` — with a pattern-matching inverse-application step on undo.

Rejected because:
- A `Segment` is ~80 bytes and the stack is 3 deep. Memory is not a concern at any plausible segment count, so the supposed "saves memory" benefit of deltas is hypothetical.
- Every undoable action needs its own inverse handler, plus drag coalescing has to synthesise a synthetic `'edit'` delta by diffing two states — multiplying the surface area where bugs hide.
- Snapshots preserve `selectedSegmentId` for free; deltas have to track selection independently or accept that undoing a delete leaves selection stale.

### Broader scope: also undo playhead, selection, playback, file load

Rejected because:
- Playhead updates fire ~30×/sec from mpv property observation. Including them would flood the 3-deep stack in under a second.
- "Ctrl+Z to undo a play/pause" or "Ctrl+Z to undo opening a file" is not how any editor works and would surprise users.
- The narrow scope makes "an Action" something the user *did to their segments* — a coherent mental model.

### Deeper stack (e.g., 50 entries) or persisted history

Rejected because:
- The user explicitly asked for 3.
- A persisted stack across reloads references segments whose validity depends on a video file that may have moved or changed between sessions; restoring a snapshot then would violate segment-vs-duration invariants.
- Every editor's Ctrl+Z is empty after a fresh launch. Deviating would surprise users.

### Make undo lift into `AppState` so a future "Undo" button can re-render

Rejected for now because no visible button is planned. `useRef` avoids re-rendering the whole tree on every snapshot push and keeps the implementation honest about "the stack itself is not user-visible state." If a visible button is added later, lifting is a small, mechanical change.

## Consequences

**Positive**
- Implementation is small and contained: a couple of hooks, one new entry type, and the existing shortcut machinery extended to recognise modifier-bearing Combos.
- No inverse-handler matrix — adding a new segment-mutating Action later only requires calling `pushUndo()` before the mutation.
- Drag coalescing falls out of the snapshot-on-mousedown / push-on-mouseup-if-changed flow.

**Negative**
- Heavy timeline edits (more than 3 in a row) lose access to earlier states. Mitigation: this is the explicit user spec; deepening the stack later is a one-line constant change.
- Settings and playback aren't undoable. A user who toggles HW encoder and immediately wants to revert must do so manually. Considered acceptable — settings have their own affordances in the Settings modal.
- The undo stack is invisible. Users can't see how many undos are queued. Mitigation: silent UX is the standard editor behavior; the timeline itself is the visual feedback.

**Followups (out of scope for this ADR)**
- A visible Undo / Redo button in the left sidebar, gated on stack length.
- Per-action toast feedback ("Undid: segment edit") would require a toast system; we don't have one and shouldn't bolt one on for undo alone.
- Deeper stack and/or session persistence if user feedback says 3 is too shallow.
