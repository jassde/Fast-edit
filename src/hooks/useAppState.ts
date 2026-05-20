import { useState, useCallback, useMemo } from 'react'
import { Segment, HwEncoder } from '../types'
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
} from '../constants'

const VALID_HW_ENCODERS: ReadonlySet<HwEncoder> = new Set(['none', 'auto', 'nvenc', 'qsv', 'amf'])

// ── Persisted settings ────────────────────────────────────────────────────────

type PersistedSettings = {
  framesPerScrollTick:       number
  secondsPerShiftScrollTick: number
  hwEncoder:                 HwEncoder
}

function loadSettings(): PersistedSettings {
  const fb: PersistedSettings = {
    framesPerScrollTick:       DEFAULT_FRAMES_PER_SCROLL_TICK,
    secondsPerShiftScrollTick: DEFAULT_SECONDS_PER_SHIFT_SCROLL_TICK,
    hwEncoder:                 DEFAULT_HW_ENCODER,
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
  })
}

// ── State shape ──────────────────────────────────────────────────────────────

export type AppState = {
  segments: Segment[]
  selectedSegmentId: string | null
  playheadPosition: number    // seconds
  duration: number            // seconds; 0 means no file loaded
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
}

// ── Actions shape ─────────────────────────────────────────────────────────────

export type AppActions = {
  setFilePath: (path: string) => void
  setDuration: (d: number) => void
  setPlayheadPosition: (pos: number) => void
  setIsPlaying: (playing: boolean) => void
  setIsMuted: (muted: boolean) => void
  addSegment: () => void
  deleteSegment: (id: string) => void
  selectSegment: (id: string | null) => void
  /** Select the next segment in start order, wrapping last→first */
  selectNextSegment: () => void
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
  setMpvError: (msg: string | null) => void
  setExportError: (msg: string | null) => void
}

// ── Initial state ─────────────────────────────────────────────────────────────

const PERSISTED = loadSettings()

const INITIAL_STATE: AppState = {
  segments: [],
  selectedSegmentId: null,
  playheadPosition: 0,
  duration: 0,
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
      const leftNeighbor  = [...sorted].reverse().find(seg => seg.end <= pos)
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

      return {
        ...s,
        segments: [...s.segments, newSeg],
        selectedSegmentId: newSeg.id,
      }
    })
  }, [])

  const deleteSegment = useCallback((id: string) => {
    setState(s => ({
      ...s,
      segments: s.segments.filter(seg => seg.id !== id),
      selectedSegmentId: s.selectedSegmentId === id ? null : s.selectedSegmentId,
    }))
  }, [])

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
      return {
        ...s,
        segments: s.segments.map(sg =>
          sg.id === s.selectedSegmentId ? { ...sg, start: clamped } : sg
        ),
      }
    })
  }, [])

  const setSelectedEnd = useCallback((end: number) => {
    setState(s => {
      if (!s.selectedSegmentId) return s
      const found = findSorted(s.segments, s.selectedSegmentId)
      if (!found) return s
      const { sorted, idx, seg } = found
      const rightBound = idx < sorted.length - 1 ? sorted[idx + 1].start : s.duration
      const clamped    = clamp(end, seg.start + MIN_FRAME_GAP_S, rightBound)
      return {
        ...s,
        segments: s.segments.map(sg =>
          sg.id === s.selectedSegmentId ? { ...sg, end: clamped } : sg
        ),
      }
    })
  }, [])

  // ── Plain setters (all wrapped in useCallback for stable identity) ──────

  const setFilePath = useCallback((path: string) =>
    setState(s => ({
      ...s,
      filePath: path,
      segments: [],
      selectedSegmentId: null,
      playheadPosition: 0,
      duration: 0,
      isPlaying: false,
      mpvError: null,
    })), [])

  const setDuration         = useCallback((d: number) => setState(s => ({ ...s, duration: d })), [])
  const setPlayheadPosition = useCallback((pos: number) => setState(s => ({ ...s, playheadPosition: pos })), [])
  const setIsPlaying        = useCallback((playing: boolean) => setState(s => ({ ...s, isPlaying: playing })), [])
  const setIsMuted          = useCallback((muted: boolean) => setState(s => ({ ...s, isMuted: muted })), [])
  const selectSegment       = useCallback((id: string | null) => setState(s => ({ ...s, selectedSegmentId: id })), [])

  const selectNextSegment = useCallback(() => {
    setState(s => {
      if (s.segments.length === 0) return s
      const sorted = [...s.segments].sort((a, b) => a.start - b.start)
      const curr = sorted.findIndex(seg => seg.id === s.selectedSegmentId)
      const next = curr === -1 ? 0 : (curr + 1) % sorted.length
      return { ...s, selectedSegmentId: sorted[next].id }
    })
  }, [])
  const openExportModal     = useCallback(() => setState(s => ({ ...s, showExportModal: true })), [])
  const closeExportModal    = useCallback(() => setState(s => ({ ...s, showExportModal: false, exportError: null })), [])
  const openSettingsModal   = useCallback(() => setState(s => ({ ...s, showSettingsModal: true })), [])
  const closeSettingsModal  = useCallback(() => setState(s => ({ ...s, showSettingsModal: false })), [])
  const setMpvError         = useCallback((msg: string | null) => setState(s => ({ ...s, mpvError: msg })), [])
  const setExportError      = useCallback((msg: string | null) => setState(s => ({ ...s, exportError: msg })), [])

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

  const actions: AppActions = useMemo(() => ({
    setFilePath,
    setDuration,
    setPlayheadPosition,
    setIsPlaying,
    setIsMuted,
    addSegment,
    deleteSegment,
    selectSegment,
    selectNextSegment,
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
    setMpvError,
    setExportError,
  }), [
    setFilePath, setDuration, setPlayheadPosition, setIsPlaying, setIsMuted,
    addSegment, deleteSegment, selectSegment, selectNextSegment,
    setSegmentStart, setSegmentEnd, setSelectedStart, setSelectedEnd,
    openExportModal, closeExportModal,
    openSettingsModal, closeSettingsModal,
    setFramesPerScrollTick, setSecondsPerShiftScrollTick, setHwEncoder,
    setMpvError, setExportError,
  ])

  return [state, actions] as const
}
