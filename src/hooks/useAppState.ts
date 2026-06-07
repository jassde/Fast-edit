import { useState, useCallback, useMemo, useRef } from 'react'
import { Segment, HwEncoder, ProjectFile } from '../types'
import { clamp, newId, pickColor } from '../utils'
import {
  MIN_FRAME_GAP_S,
  MIN_SEGMENT_DURATION_S,
  DEFAULT_FRAMES_PER_SCROLL_TICK,
  MIN_FRAMES_PER_SCROLL_TICK,
  MAX_FRAMES_PER_SCROLL_TICK,
  DEFAULT_SECONDS_PER_SHIFT_SCROLL_TICK,
  MIN_SECONDS_PER_SHIFT_SCROLL_TICK,
  MAX_SECONDS_PER_SHIFT_SCROLL_TICK,
  DEFAULT_HW_ENCODER,
  SETTINGS_STORAGE_KEY,
  DEFAULT_FPS,
} from '../constants'

const VALID_HW_ENCODERS: ReadonlySet<HwEncoder> = new Set(['none', 'auto', 'nvenc', 'qsv', 'amf'])

// ── Persisted settings ────────────────────────────────────────────────────────

type PersistedSettings = {
  framesPerScrollTick:       number
  secondsPerShiftScrollTick: number
  hwEncoder:                 HwEncoder
  showScrollPanel:           boolean
}

function loadSettings(): PersistedSettings {
  const fb: PersistedSettings = {
    framesPerScrollTick:       DEFAULT_FRAMES_PER_SCROLL_TICK,
    secondsPerShiftScrollTick: DEFAULT_SECONDS_PER_SHIFT_SCROLL_TICK,
    hwEncoder:                 DEFAULT_HW_ENCODER,
    showScrollPanel:           false,
  }
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return fb
    const p = JSON.parse(raw)
    return {
      framesPerScrollTick: clamp(
        Number(p.framesPerScrollTick) || fb.framesPerScrollTick,
        MIN_FRAMES_PER_SCROLL_TICK, MAX_FRAMES_PER_SCROLL_TICK,
      ),
      secondsPerShiftScrollTick: clamp(
        Number(p.secondsPerShiftScrollTick) || fb.secondsPerShiftScrollTick,
        MIN_SECONDS_PER_SHIFT_SCROLL_TICK, MAX_SECONDS_PER_SHIFT_SCROLL_TICK,
      ),
      hwEncoder: VALID_HW_ENCODERS.has(p.hwEncoder) ? p.hwEncoder : fb.hwEncoder,
      showScrollPanel: p.showScrollPanel === true,
    }
  } catch {
    return fb
  }
}

function saveSettings(s: PersistedSettings) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(s))
  } catch {
    // quota / private mode — ignore; in-session state still works
  }
}

/** Extract just the persisted-settings slice from full AppState and write it. */
function persistFromAppState(s: AppState) {
  saveSettings({
    framesPerScrollTick:       s.framesPerScrollTick,
    secondsPerShiftScrollTick: s.secondsPerShiftScrollTick,
    hwEncoder:                 s.hwEncoder,
    showScrollPanel:           s.showScrollPanel,
  })
}

// ── State shape ──────────────────────────────────────────────────────────────

export type AppState = {
  segments: Segment[]
  selectedSegmentId: string | null
  playheadPosition: number    // seconds
  duration: number            // seconds; 0 means no file loaded
  fps: number                 // clip frame rate; DEFAULT_FPS until mpv reports container-fps
  isPlaying: boolean
  isMuted: boolean
  filePath: string | null
  showExportModal: boolean
  showSettingsModal: boolean
  mpvError: string | null
  exportError: string | null
  framesPerScrollTick: number
  secondsPerShiftScrollTick: number
  hwEncoder: HwEncoder
  showScrollPanel: boolean
}

// ── Undo / Redo ───────────────────────────────────────────────────────────────
// A Snapshot is the unit stored on the undo/redo stacks. Intentionally narrow:
// only segments + selection. Playhead / playback / modal / settings state are
// deliberately excluded — see docs/adr/0001-segment-undo-snapshot-stack.md.

export type Snapshot = {
  segments:          Segment[]
  selectedSegmentId: string | null
}

const MAX_UNDO = 3

function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  if (a.selectedSegmentId !== b.selectedSegmentId) return false
  if (a.segments.length !== b.segments.length) return false
  for (let i = 0; i < a.segments.length; i++) {
    const x = a.segments[i]
    const y = b.segments[i]
    if (x.id !== y.id || x.start !== y.start || x.end !== y.end || x.color !== y.color) {
      return false
    }
  }
  return true
}

// ── Actions shape ─────────────────────────────────────────────────────────────

export type AppActions = {
  setFilePath: (path: string) => void
  setDuration: (d: number) => void
  setFps: (fps: number) => void
  setPlayheadPosition: (pos: number) => void
  setIsPlaying: (playing: boolean) => void
  setIsMuted: (muted: boolean) => void
  addSegment: () => void
  deleteSegment: (id: string) => void
  selectSegment: (id: string | null) => void
  setSegmentStart: (id: string, start: number) => void
  setSegmentEnd: (id: string, end: number) => void
  /** Set start of whichever segment is currently selected */
  setSelectedStart: (start: number) => void
  /** Set end of whichever segment is currently selected */
  setSelectedEnd: (end: number) => void
  openExportModal: () => void
  closeExportModal: () => void
  openSettingsModal: () => void
  closeSettingsModal: () => void
  setFramesPerScrollTick: (n: number) => void
  setSecondsPerShiftScrollTick: (n: number) => void
  setHwEncoder: (e: HwEncoder) => void
  setShowScrollPanel: (b: boolean) => void
  setMpvError: (msg: string | null) => void
  setExportError: (msg: string | null) => void
  loadProject: (p: ProjectFile) => void
  /** Pop one undo snapshot and apply it; push current state onto redo stack. */
  undo: () => void
  /** Pop one redo snapshot and apply it; push current state onto undo stack. */
  redo: () => void
  /**
   * Capture the current segments/selection ahead of a drag-style edit. Pair
   * with endDrag(). Calling beginDrag without a matching endDrag is harmless —
   * the captured snapshot lives in a ref and is overwritten by the next call.
   */
  beginDrag: () => void
  /**
   * Commit a drag-style edit. Pushes the snapshot captured by beginDrag onto
   * the undo stack if (and only if) segments actually changed.
   */
  endDrag: () => void
}

// ── Initial state ─────────────────────────────────────────────────────────────

const PERSISTED = loadSettings()

const INITIAL_STATE: AppState = {
  segments: [],
  selectedSegmentId: null,
  playheadPosition: 0,
  duration: 0,
  fps: DEFAULT_FPS,
  isPlaying: false,
  isMuted: false,
  filePath: null,
  showExportModal: false,
  showSettingsModal: false,
  mpvError: null,
  exportError: null,
  framesPerScrollTick:       PERSISTED.framesPerScrollTick,
  secondsPerShiftScrollTick: PERSISTED.secondsPerShiftScrollTick,
  hwEncoder:                 PERSISTED.hwEncoder,
  showScrollPanel:           PERSISTED.showScrollPanel,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Sort segments by start time and return them alongside their sorted index for a given id. */
function findSorted(
  segments: Segment[],
  id: string,
): { sorted: Segment[]; idx: number; seg: Segment } | null {
  const sorted = [...segments].sort((a, b) => a.start - b.start)
  const idx    = sorted.findIndex(s => s.id === id)
  if (idx === -1) return null
  return { sorted, idx, seg: sorted[idx] }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAppState(): [AppState, AppActions] {
  const [state, setState] = useState<AppState>(INITIAL_STATE)

  // Mirror of `state` for callbacks (undo/redo/beginDrag/endDrag) that need
  // to read the latest committed state synchronously without going through a
  // setState updater. The setState-updater path would be unsafe under React
  // StrictMode for actions that mutate refs non-idempotently (e.g. pop), since
  // updaters are double-invoked in dev.
  const stateRef = useRef(state)
  stateRef.current = state

  // ── Undo / Redo stacks ──────────────────────────────────────────────────
  // Kept as refs (not state) because the stacks themselves drive no UI;
  // the visible feedback is the segments mutation, which already triggers a
  // re-render via setState. See docs/adr/0001-segment-undo-snapshot-stack.md.
  const undoStackRef  = useRef<Snapshot[]>([])
  const redoStackRef  = useRef<Snapshot[]>([])
  // Drag snapshot held between beginDrag() and endDrag().
  const dragSnapRef   = useRef<Snapshot | null>(null)

  /**
   * Push a snapshot onto the undo stack and clear the redo stack. Called
   * from each undoable mutator BEFORE the state change. Dedups against the
   * top of the stack so React StrictMode's double-invoke of the updater
   * function can't pollute the history.
   */
  const pushUndo = useCallback((snap: Snapshot) => {
    const stack = undoStackRef.current
    const top   = stack[stack.length - 1]
    if (top && snapshotsEqual(top, snap)) return
    stack.push(snap)
    if (stack.length > MAX_UNDO) stack.shift()  // FIFO eviction
    redoStackRef.current.length = 0             // any new action invalidates redo
  }, [])

  // ── Segment mutations ────────────────────────────────────────────────────

  const addSegment = useCallback(() => {
    setState(s => {
      if (s.duration === 0) return s

      const DEFAULT_SEG_DURATION = 5
      const pos    = s.playheadPosition
      const sorted = [...s.segments].sort((a, b) => a.start - b.start)

      // If the playhead is inside an existing segment, no-op
      if (sorted.some(seg => pos >= seg.start && pos < seg.end)) return s

      // Bounds: left neighbor's end → right neighbor's start (or video edges)
      const rightNeighbor = sorted.find(seg => seg.start > pos)
      const leftNeighbor  = sorted.findLast(seg => seg.end <= pos)
      const minStart = leftNeighbor  ? leftNeighbor.end   : 0
      const maxEnd   = rightNeighbor ? rightNeighbor.start : s.duration

      if (maxEnd - minStart < MIN_SEGMENT_DURATION_S) return s  // no room, silent no-op

      const start = clamp(pos, minStart, maxEnd - MIN_SEGMENT_DURATION_S)
      const end   = clamp(pos + DEFAULT_SEG_DURATION, start + MIN_SEGMENT_DURATION_S, maxEnd)

      const newSeg: Segment = {
        id:    newId(),
        start,
        end,
        color: pickColor(s.segments.map(seg => seg.color)),
      }

      pushUndo({ segments: s.segments, selectedSegmentId: s.selectedSegmentId })

      return {
        ...s,
        segments: [...s.segments, newSeg],
        selectedSegmentId: newSeg.id,
      }
    })
  }, [pushUndo])

  const deleteSegment = useCallback((id: string) => {
    setState(s => {
      if (!s.segments.some(seg => seg.id === id)) return s
      pushUndo({ segments: s.segments, selectedSegmentId: s.selectedSegmentId })
      return {
        ...s,
        segments: s.segments.filter(seg => seg.id !== id),
        selectedSegmentId: s.selectedSegmentId === id ? null : s.selectedSegmentId,
      }
    })
  }, [pushUndo])

  const setSegmentStart = useCallback((id: string, start: number) => {
    setState(s => {
      const found = findSorted(s.segments, id)
      if (!found) return s
      const { sorted, idx, seg } = found
      const leftBound    = idx > 0 ? sorted[idx - 1].end : 0
      const clampedStart = clamp(start, leftBound, seg.end - MIN_FRAME_GAP_S)
      return {
        ...s,
        segments: s.segments.map(sg =>
          sg.id === id ? { ...sg, start: clampedStart } : sg
        ),
      }
    })
  }, [])

  const setSegmentEnd = useCallback((id: string, end: number) => {
    setState(s => {
      const found = findSorted(s.segments, id)
      if (!found) return s
      const { sorted, idx, seg } = found
      const rightBound = idx < sorted.length - 1 ? sorted[idx + 1].start : s.duration
      const clampedEnd = clamp(end, seg.start + MIN_FRAME_GAP_S, rightBound)
      return {
        ...s,
        segments: s.segments.map(sg =>
          sg.id === id ? { ...sg, end: clampedEnd } : sg
        ),
      }
    })
  }, [])

  const setSelectedStart = useCallback((start: number) => {
    setState(s => {
      if (!s.selectedSegmentId) return s
      const found = findSorted(s.segments, s.selectedSegmentId)
      if (!found) return s
      const { sorted, idx, seg } = found
      const leftBound = idx > 0 ? sorted[idx - 1].end : 0
      const clamped   = clamp(start, leftBound, seg.end - MIN_FRAME_GAP_S)
      if (clamped === seg.start) return s   // no-op: don't pollute undo
      pushUndo({ segments: s.segments, selectedSegmentId: s.selectedSegmentId })
      return {
        ...s,
        segments: s.segments.map(sg =>
          sg.id === s.selectedSegmentId ? { ...sg, start: clamped } : sg
        ),
      }
    })
  }, [pushUndo])

  const setSelectedEnd = useCallback((end: number) => {
    setState(s => {
      if (!s.selectedSegmentId) return s
      const found = findSorted(s.segments, s.selectedSegmentId)
      if (!found) return s
      const { sorted, idx, seg } = found
      const rightBound = idx < sorted.length - 1 ? sorted[idx + 1].start : s.duration
      const clamped    = clamp(end, seg.start + MIN_FRAME_GAP_S, rightBound)
      if (clamped === seg.end) return s   // no-op: don't pollute undo
      pushUndo({ segments: s.segments, selectedSegmentId: s.selectedSegmentId })
      return {
        ...s,
        segments: s.segments.map(sg =>
          sg.id === s.selectedSegmentId ? { ...sg, end: clamped } : sg
        ),
      }
    })
  }, [pushUndo])

  // ── Plain setters (all wrapped in useCallback for stable identity) ──────

  const setFilePath = useCallback((path: string) => {
    // Snapshots reference segments tied to the old file; useless and confusing
    // after a new file load. See ADR-0001.
    undoStackRef.current.length = 0
    redoStackRef.current.length = 0
    dragSnapRef.current = null
    setState(s => ({
      ...s,
      filePath: path,
      segments: [],
      selectedSegmentId: null,
      playheadPosition: 0,
      duration: 0,
      fps: DEFAULT_FPS,
      isPlaying: false,
      mpvError: null,
    }))
  }, [])

  const setDuration         = useCallback((d: number) => setState(s => ({ ...s, duration: d })), [])
  const setFps              = useCallback((fps: number) => setState(s => ({ ...s, fps })), [])
  const setPlayheadPosition = useCallback((pos: number) => setState(s => ({ ...s, playheadPosition: pos })), [])
  const setIsPlaying        = useCallback((playing: boolean) => setState(s => ({ ...s, isPlaying: playing })), [])
  const setIsMuted          = useCallback((muted: boolean) => setState(s => ({ ...s, isMuted: muted })), [])
  const selectSegment       = useCallback((id: string | null) => setState(s => ({ ...s, selectedSegmentId: id })), [])
  const openExportModal     = useCallback(() => setState(s => ({ ...s, showExportModal: true })), [])
  const closeExportModal    = useCallback(() => setState(s => ({ ...s, showExportModal: false, exportError: null })), [])
  const openSettingsModal   = useCallback(() => setState(s => ({ ...s, showSettingsModal: true })), [])
  const closeSettingsModal  = useCallback(() => setState(s => ({ ...s, showSettingsModal: false })), [])
  const setMpvError         = useCallback((msg: string | null) => setState(s => ({ ...s, mpvError: msg })), [])
  const setExportError      = useCallback((msg: string | null) => setState(s => ({ ...s, exportError: msg })), [])

  const loadProject = useCallback((p: ProjectFile) => {
    // Fresh document → fresh history. See ADR-0001.
    undoStackRef.current.length = 0
    redoStackRef.current.length = 0
    dragSnapRef.current = null
    setState(s => ({
      ...s,
      filePath: p.filePath,
      segments: p.segments,
      selectedSegmentId: null,
      playheadPosition: p.playheadPosition,
      duration: 0,
      fps: DEFAULT_FPS,
      isPlaying: false,
      mpvError: null,
    }))
  }, [])

  // ── Undo / Redo actions ─────────────────────────────────────────────────
  // These callbacks mutate refs (pop/push) synchronously, OUTSIDE the setState
  // updater. Doing the pop inside the updater would be unsafe: React 18
  // StrictMode double-invokes updaters in dev, which would pop two entries per
  // press and silently corrupt the history. The setState call here only carries
  // the segment-and-selection swap (idempotent under double-invocation).

  const undo = useCallback(() => {
    const popped = undoStackRef.current.pop()
    if (!popped) return
    const s = stateRef.current
    const redoStack = redoStackRef.current
    redoStack.push({ segments: s.segments, selectedSegmentId: s.selectedSegmentId })
    if (redoStack.length > MAX_UNDO) redoStack.shift()
    setState(prev => ({
      ...prev,
      segments: popped.segments,
      selectedSegmentId: popped.selectedSegmentId,
    }))
  }, [])

  const redo = useCallback(() => {
    const popped = redoStackRef.current.pop()
    if (!popped) return
    const s = stateRef.current
    const undoStack = undoStackRef.current
    undoStack.push({ segments: s.segments, selectedSegmentId: s.selectedSegmentId })
    if (undoStack.length > MAX_UNDO) undoStack.shift()
    setState(prev => ({
      ...prev,
      segments: popped.segments,
      selectedSegmentId: popped.selectedSegmentId,
    }))
  }, [])

  const beginDrag = useCallback(() => {
    const s = stateRef.current
    dragSnapRef.current = { segments: s.segments, selectedSegmentId: s.selectedSegmentId }
  }, [])

  const endDrag = useCallback(() => {
    const snap = dragSnapRef.current
    dragSnapRef.current = null
    if (!snap) return
    const s = stateRef.current
    const current: Snapshot = { segments: s.segments, selectedSegmentId: s.selectedSegmentId }
    if (!snapshotsEqual(snap, current)) {
      pushUndo(snap)
    }
  }, [pushUndo])

  const setFramesPerScrollTick = useCallback((n: number) => {
    setState(s => {
      const next = { ...s, framesPerScrollTick: n }
      persistFromAppState(next)
      return next
    })
  }, [])

  const setSecondsPerShiftScrollTick = useCallback((n: number) => {
    setState(s => {
      const next = { ...s, secondsPerShiftScrollTick: n }
      persistFromAppState(next)
      return next
    })
  }, [])

  const setHwEncoder = useCallback((e: HwEncoder) => {
    setState(s => {
      const next = { ...s, hwEncoder: e }
      persistFromAppState(next)
      return next
    })
  }, [])

  const setShowScrollPanel = useCallback((b: boolean) => {
    setState(s => {
      const next = { ...s, showScrollPanel: b }
      persistFromAppState(next)
      return next
    })
  }, [])

  const actions: AppActions = useMemo(() => ({
    setFilePath,
    setDuration,
    setFps,
    setPlayheadPosition,
    setIsPlaying,
    setIsMuted,
    addSegment,
    deleteSegment,
    selectSegment,
    setSegmentStart,
    setSegmentEnd,
    setSelectedStart,
    setSelectedEnd,
    openExportModal,
    closeExportModal,
    openSettingsModal,
    closeSettingsModal,
    setFramesPerScrollTick,
    setSecondsPerShiftScrollTick,
    setHwEncoder,
    setShowScrollPanel,
    setMpvError,
    setExportError,
    loadProject,
    undo,
    redo,
    beginDrag,
    endDrag,
  }), [
    setFilePath, setDuration, setFps, setPlayheadPosition, setIsPlaying, setIsMuted,
    addSegment, deleteSegment, selectSegment,
    setSegmentStart, setSegmentEnd, setSelectedStart, setSelectedEnd,
    openExportModal, closeExportModal,
    openSettingsModal, closeSettingsModal,
    setFramesPerScrollTick, setSecondsPerShiftScrollTick, setHwEncoder, setShowScrollPanel,
    setMpvError, setExportError, loadProject,
    undo, redo, beginDrag, endDrag,
  ])

  return [state, actions] as const
}
