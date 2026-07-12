import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { Segment, HwEncoder, ProjectFile } from '../types'
import { clamp, newId, pickColor } from '../utils'
import {
  MIN_FRAME_GAP_S,
  DEFAULT_FRAMES_PER_SCROLL_TICK,
  MIN_FRAMES_PER_SCROLL_TICK,
  MAX_FRAMES_PER_SCROLL_TICK,
  DEFAULT_SECONDS_PER_SHIFT_SCROLL_TICK,
  MIN_SECONDS_PER_SHIFT_SCROLL_TICK,
  MAX_SECONDS_PER_SHIFT_SCROLL_TICK,
  DEFAULT_HW_ENCODER,
  SETTINGS_STORAGE_KEY,
  DEFAULT_FPS,
  ACCENT_COLORS,
  DEFAULT_ACCENT_COLOR,
  AccentColor,
} from '../constants'

const VALID_HW_ENCODERS: ReadonlySet<HwEncoder> = new Set(['none', 'auto', 'nvenc', 'qsv', 'amf'])
const VALID_ACCENT_COLORS: ReadonlySet<AccentColor> = new Set(ACCENT_COLORS)

// ── Persisted settings ────────────────────────────────────────────────────────

type PersistedSettings = {
  framesPerScrollTick:       number
  secondsPerShiftScrollTick: number
  hwEncoder:                 HwEncoder
  showScrollPanel:           boolean
  accentColor:               AccentColor
}

function loadSettings(): PersistedSettings {
  const fb: PersistedSettings = {
    framesPerScrollTick:       DEFAULT_FRAMES_PER_SCROLL_TICK,
    secondsPerShiftScrollTick: DEFAULT_SECONDS_PER_SHIFT_SCROLL_TICK,
    hwEncoder:                 DEFAULT_HW_ENCODER,
    showScrollPanel:           false,
    accentColor:               DEFAULT_ACCENT_COLOR,
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
      accentColor: VALID_ACCENT_COLORS.has(p.accentColor) ? p.accentColor : fb.accentColor,
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
    accentColor:               s.accentColor,
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
  accentColor: AccentColor
}

// ── Undo / Redo ───────────────────────────────────────────────────────────────
// A Snapshot is the unit stored on the undo/redo stacks. Intentionally narrow:
// only segments + selection. Playhead / playback / modal / settings state are
// deliberately excluded so undo only affects segment edits.

export type Snapshot = {
  segments:          Segment[]
  selectedSegmentId: string | null
}

const MAX_UNDO = 50

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
  /** Split the segment containing the playhead into two adjacent segments at the playhead. */
  splitSegment: () => void
  /** Create a single segment spanning [0, duration] if none exist; no-op otherwise. */
  ensureFullSegment: () => void
  deleteSegment: (id: string) => void
  selectSegment: (id: string | null) => void
  /**
   * Update a segment's source-start. `minStart` is the inclusive lower bound
   * (typically the pre-drag seg.start, captured by the trim-handle drag handler
   * so a single drag can reverse direction without the receiver ratcheting).
   */
  setSegmentStart: (id: string, start: number, minStart: number) => void
  /** As setSegmentStart; `maxEnd` is the inclusive upper bound. */
  setSegmentEnd: (id: string, end: number, maxEnd: number) => void
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
  setAccentColor: (c: AccentColor) => void
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
  accentColor:               PERSISTED.accentColor,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Validate segments loaded from a .vtproj.json file. The file is user-editable
 * so its contents are not trusted: drop entries with non-finite or non-positive
 * spans, then walk in start order and drop anything overlapping a kept segment.
 * This keeps the rest of the app's "no overlap, finite numbers" invariants safe.
 */
function sanitizeLoadedSegments(raw: unknown): Segment[] {
  if (!Array.isArray(raw)) return []
  const valid: Segment[] = []
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue
    const seg = s as Partial<Segment>
    const start = Number(seg.start)
    const end   = Number(seg.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    if (start < 0 || end <= start) continue
    valid.push({
      id:    typeof seg.id === 'string' && seg.id ? seg.id : newId(),
      start,
      end,
      color: typeof seg.color === 'string' && seg.color ? seg.color : pickColor(valid.map(v => v.color)),
    })
  }
  valid.sort((a, b) => a.start - b.start)
  const kept: Segment[] = []
  for (const seg of valid) {
    const last = kept[kept.length - 1]
    if (last && seg.start < last.end) continue   // overlaps previous → drop
    kept.push(seg)
  }
  return kept
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
  // re-render via setState.
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

  const splitSegment = useCallback(() => {
    setState(s => {
      if (s.duration === 0) return s
      const pos = s.playheadPosition
      const target = s.segments.find(seg => pos > seg.start && pos < seg.end)
      if (!target) return s
      // Both halves must satisfy the standard "at least one frame" gap so the
      // existing handle-drag clamps don't immediately collapse them.
      if (pos - target.start < MIN_FRAME_GAP_S) return s
      if (target.end - pos < MIN_FRAME_GAP_S) return s

      pushUndo({ segments: s.segments, selectedSegmentId: s.selectedSegmentId })

      const rightHalf: Segment = {
        id:    newId(),
        start: pos,
        end:   target.end,
        color: pickColor(s.segments.map(seg => seg.color)),
      }
      return {
        ...s,
        segments: s.segments.map(seg =>
          seg.id === target.id ? { ...seg, end: pos } : seg
        ).concat(rightHalf),
        selectedSegmentId: rightHalf.id,
      }
    })
  }, [pushUndo])

  const ensureFullSegment = useCallback(() => {
    setState(s => {
      if (s.duration <= 0) return s
      if (s.segments.length > 0) return s
      const seg: Segment = {
        id:    newId(),
        start: 0,
        end:   s.duration,
        color: pickColor([]),
      }
      return {
        ...s,
        segments: [seg],
        selectedSegmentId: seg.id,
      }
    })
  }, [])

  // Ripple delete: remove the segment. The kept-timeline renderer lays
  // segments out cumulatively by duration, so the gap closes visually without
  // mutating any other segment's SOURCE positions — keeping the export honest.
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

  // Trim is shrink-only relative to the bounds the caller passes. The caller
  // (the trim-handle drag in Timeline.tsx) supplies the PRE-drag bounds so a
  // single drag can reverse direction freely. Using the current seg.start /
  // seg.end as the bound ratchets the window tighter on every mousemove.
  const setSegmentStart = useCallback((id: string, start: number, minStart: number) => {
    setState(s => {
      const seg = s.segments.find(sg => sg.id === id)
      if (!seg) return s
      const clamped = clamp(start, minStart, seg.end - MIN_FRAME_GAP_S)
      return {
        ...s,
        segments: s.segments.map(sg =>
          sg.id === id ? { ...sg, start: clamped } : sg
        ),
      }
    })
  }, [])

  const setSegmentEnd = useCallback((id: string, end: number, maxEnd: number) => {
    setState(s => {
      const seg = s.segments.find(sg => sg.id === id)
      if (!seg) return s
      const clamped = clamp(end, seg.start + MIN_FRAME_GAP_S, maxEnd)
      return {
        ...s,
        segments: s.segments.map(sg =>
          sg.id === id ? { ...sg, end: clamped } : sg
        ),
      }
    })
  }, [])

  const setSelectedStart = useCallback((start: number) => {
    setState(s => {
      if (!s.selectedSegmentId) return s
      const sorted = [...s.segments].sort((a, b) => a.start - b.start)
      const idx = sorted.findIndex(sg => sg.id === s.selectedSegmentId)
      if (idx === -1) return s
      const seg = sorted[idx]
      const prevEnd = idx > 0 ? sorted[idx - 1].end : 0
      const clamped = clamp(start, prevEnd, seg.end - MIN_FRAME_GAP_S)
      if (clamped === seg.start) return s
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
      const sorted = [...s.segments].sort((a, b) => a.start - b.start)
      const idx = sorted.findIndex(sg => sg.id === s.selectedSegmentId)
      if (idx === -1) return s
      const seg = sorted[idx]
      const nextStart = idx < sorted.length - 1 ? sorted[idx + 1].start : s.duration
      const clamped = clamp(end, seg.start + MIN_FRAME_GAP_S, nextStart)
      if (clamped === seg.end) return s
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
    // .vtproj.json is user-editable — don't trust the file. Drop segments with
    // non-finite or inverted times, then sort + walk to drop overlaps that
    // would break the timeline's "no overlap" invariant.
    const cleanSegments = sanitizeLoadedSegments(p.segments)
    const playheadPosition = Number.isFinite(p.playheadPosition) && p.playheadPosition >= 0
      ? p.playheadPosition
      : 0
    setState(s => ({
      ...s,
      filePath: p.filePath,
      segments: cleanSegments,
      selectedSegmentId: null,
      playheadPosition,
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

  // Debounce settings persistence so slider drags don't hammer localStorage
  // on every mousemove tick. The 300ms window collapses a drag into one write.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const schedulePersist = useCallback((s: AppState) => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      persistFromAppState(s)
      persistTimerRef.current = null
    }, 300)
  }, [])
  useEffect(() => () => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
  }, [])

  const setFramesPerScrollTick = useCallback((n: number) => {
    setState(s => {
      const next = { ...s, framesPerScrollTick: n }
      schedulePersist(next)
      return next
    })
  }, [schedulePersist])

  const setSecondsPerShiftScrollTick = useCallback((n: number) => {
    setState(s => {
      const next = { ...s, secondsPerShiftScrollTick: n }
      schedulePersist(next)
      return next
    })
  }, [schedulePersist])

  const setHwEncoder = useCallback((e: HwEncoder) => {
    setState(s => {
      const next = { ...s, hwEncoder: e }
      schedulePersist(next)
      return next
    })
  }, [schedulePersist])

  const setShowScrollPanel = useCallback((b: boolean) => {
    setState(s => {
      const next = { ...s, showScrollPanel: b }
      schedulePersist(next)
      return next
    })
  }, [schedulePersist])

  const setAccentColor = useCallback((c: AccentColor) => {
    setState(s => {
      const next = { ...s, accentColor: c }
      schedulePersist(next)
      return next
    })
  }, [schedulePersist])

  const actions: AppActions = useMemo(() => ({
    setFilePath,
    setDuration,
    setFps,
    setPlayheadPosition,
    setIsPlaying,
    setIsMuted,
    splitSegment,
    ensureFullSegment,
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
    setAccentColor,
    setMpvError,
    setExportError,
    loadProject,
    undo,
    redo,
    beginDrag,
    endDrag,
  }), [
    setFilePath, setDuration, setFps, setPlayheadPosition, setIsPlaying, setIsMuted,
    splitSegment, ensureFullSegment, deleteSegment, selectSegment,
    setSegmentStart, setSegmentEnd, setSelectedStart, setSelectedEnd,
    openExportModal, closeExportModal,
    openSettingsModal, closeSettingsModal,
    setFramesPerScrollTick, setSecondsPerShiftScrollTick, setHwEncoder, setShowScrollPanel, setAccentColor,
    setMpvError, setExportError, loadProject,
    undo, redo, beginDrag, endDrag,
  ])

  return [state, actions] as const
}
