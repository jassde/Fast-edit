import { Fragment, useRef, useCallback, useState, useMemo, useEffect } from 'react'
import { Segment } from '../types'
import {
  clamp,
  formatTime,
  keptToSource,
  sortedByStart,
  sourceToKept,
} from '../utils'
import { MIN_SEGMENT_PX, MIN_FRAME_GAP_S } from '../constants'

// ── Props ─────────────────────────────────────────────────────────────────────
//
// `playheadPosition` and the start/end fields of each Segment are all in
// SOURCE time (matching mpv's clock and the export pipeline). The renderer
// projects them onto a "kept timeline" — segments laid out cumulatively by
// duration, so deleted/trimmed source content collapses out of view.

type TimelineProps = {
  /** Source duration (mpv's clock). Only used to gate "is a file loaded?". */
  duration: number
  segments: Segment[]
  selectedSegmentId: string | null
  /** SOURCE time. */
  playheadPosition: number
  /** Magnification factor. 1 = full kept timeline visible. */
  zoom: number
  /** Base64 JPEG data URLs for the filmstrip, evenly spaced across the source. */
  thumbnails?: string[]
  /** Called with a SOURCE time. */
  onSeek: (time: number) => void
  onSelectSegment: (id: string | null) => void
  /** Called with a SOURCE time + the pre-drag lower bound (shrink-only on the receiver). */
  onUpdateSegmentStart: (id: string, start: number, minStart: number) => void
  /** Called with a SOURCE time + the pre-drag upper bound (shrink-only on the receiver). */
  onUpdateSegmentEnd: (id: string, end: number, maxEnd: number) => void
  onDragBegin: () => void
  onDragEnd: () => void
}

// Each filmstrip frame slot is sized at 16:9 × the segments-area height.
const FILMSTRIP_AREA_H = 86  // must match CSS: timeline-container(116) - ruler-area(30)
const FILMSTRIP_FRAME_W = Math.round(FILMSTRIP_AREA_H * (16 / 9))  // ~153 px

// ── Ruler tick interval ───────────────────────────────────────────────────────

const NICE_INTERVALS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 3600]
const SUBDIVISIONS = 5

function computeTickInterval(visibleDuration: number, widthPx: number): number {
  if (widthPx === 0 || visibleDuration === 0) return 1
  const pixelsPerSecond = widthPx / visibleDuration
  const TARGET_PX = 80
  const rawInterval = TARGET_PX / pixelsPerSecond
  return NICE_INTERVALS.find(v => v >= rawInterval) ?? 3600
}

function formatTickLabel(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 0) return '0:00'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

// ── Component ─────────────────────────────────────────────────────────────────

export function Timeline({
  duration,
  segments,
  selectedSegmentId,
  playheadPosition,
  zoom,
  thumbnails,
  onSeek,
  onSelectSegment,
  onUpdateSegmentStart,
  onUpdateSegmentEnd,
  onDragBegin,
  onDragEnd,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const [containerWidth, setContainerWidth] = useState(0)
  const containerWidthRef = useRef(0)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = (w: number) => {
      containerWidthRef.current = w
      setContainerWidth(w)
    }
    update(el.getBoundingClientRect().width)
    const ro = new ResizeObserver(entries => update(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const getWidth = () => containerWidthRef.current

  // ── Cumulative kept-space layout ────────────────────────────────────────
  // Segments are sorted by source-start and laid out left-to-right by duration.
  // `placed` carries the kept-space offset alongside each segment so the
  // renderer doesn't have to recompute the prefix sum per element.
  const { sortedSegs, keptDur, placed } = useMemo(() => {
    const sorted = sortedByStart(segments)
    const placedArr: { seg: Segment; keptStart: number; keptEnd: number }[] = []
    let acc = 0
    for (const seg of sorted) {
      const d = seg.end - seg.start
      placedArr.push({ seg, keptStart: acc, keptEnd: acc + d })
      acc += d
    }
    return { sortedSegs: sorted, keptDur: acc, placed: placedArr }
  }, [segments])

  // Playhead in kept-space; null when the source playhead is in a deleted gap.
  const playheadKept = useMemo(
    () => (keptDur > 0 ? sourceToKept(playheadPosition, sortedSegs) : null),
    [playheadPosition, sortedSegs, keptDur],
  )

  // ── Visible-window math (zoom) ──────────────────────────────────────────
  // When the source playhead falls in a deleted gap (playheadKept == null) we
  // hold the last good viewStart so the viewport doesn't teleport back to 0
  // every frame while playback crosses the gap. Mutating the ref here is a
  // pure cache of derived values — safe across StrictMode double-invokes.
  const lastViewStartRef = useRef(0)
  const safeZoom         = Math.max(1, zoom)
  const visibleDuration  = keptDur > 0 ? keptDur / safeZoom : 0
  const maxViewStart     = Math.max(0, keptDur - visibleDuration)
  let viewStart: number
  if (keptDur === 0) {
    viewStart = 0
  } else if (playheadKept != null) {
    viewStart = clamp(playheadKept - visibleDuration / 2, 0, maxViewStart)
    lastViewStartRef.current = viewStart
  } else {
    viewStart = clamp(lastViewStartRef.current, 0, maxViewStart)
  }

  // Freeze the view origin during a drag so the dragged edge doesn't slide
  // under the cursor when the playhead-driven auto-center recomputes.
  const [dragViewStart, setDragViewStart] = useState<number | null>(null)
  const effectiveViewStart = dragViewStart ?? viewStart

  // ── Trim animation: drag snapshot + close-gap state ─────────────────────
  // During a drag we render the dragged segment's edge under the cursor and
  // hold "after" segments at their pre-drag positions, leaving a visible gap
  // where the trimmed-off kept-content used to be. On release we drop the
  // snapshot and let CSS transition the elements from their frozen positions
  // to the live cumulative positions (the gap closes).
  const [dragSnap, setDragSnap] = useState<
    { id: string; originalDur: number; type: 'start' | 'end' } | null
  >(null)
  const [animatingClose, setAnimatingClose] = useState(false)
  const closeTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
  }, [])

  // Locate the dragged segment + compute the "phantom gap" — the amount of
  // kept-time we're holding open while the user drags. Zero when no drag.
  const { draggedIndex, phantomGap, draggedType } = useMemo(() => {
    if (!dragSnap) return { draggedIndex: -1, phantomGap: 0, draggedType: null as 'start' | 'end' | null }
    const idx = placed.findIndex(p => p.seg.id === dragSnap.id)
    if (idx === -1) return { draggedIndex: -1, phantomGap: 0, draggedType: null as 'start' | 'end' | null }
    const currentDur = placed[idx].keptEnd - placed[idx].keptStart
    return {
      draggedIndex: idx,
      phantomGap: Math.max(0, dragSnap.originalDur - currentDur),
      draggedType: dragSnap.type,
    }
  }, [dragSnap, placed])

  // Mirrors of the kept-space view state, captured by drag closures whose
  // dependency arrays don't include them (would re-register on every change).
  const visibleDurationRef = useRef(visibleDuration)
  visibleDurationRef.current = visibleDuration
  const viewStartRef = useRef(viewStart)
  viewStartRef.current = viewStart
  const sortedSegsRef = useRef(sortedSegs)
  sortedSegsRef.current = sortedSegs

  // ── Drag handle logic ───────────────────────────────────────────────────
  // Pixel deltas convert to KEPT-time deltas. Within a single clip the kept
  // axis is 1:1 with source, so the delta applies straight to seg.start /
  // seg.end as a SOURCE delta.
  //
  // Drag-scoped clamping uses the segment's PRE-drag bounds so a single drag
  // can reverse direction freely. Doing the clamp inside setSegmentStart/End
  // (against the *current* bounds) ratchets — every mousemove tightens the
  // window. We also clamp the value handed to onSeek so an overshoot drag
  // can't fling mpv into an unrelated source region.
  const startDrag = useCallback(
    (e: React.MouseEvent, type: 'start' | 'end', seg: Segment) => {
      e.preventDefault()
      e.stopPropagation()

      const startX = e.clientX
      const originalStart = seg.start
      const originalEnd   = seg.end
      const originalTime  = type === 'start' ? originalStart : originalEnd

      // If a previous close animation is still playing, end it now — the new
      // drag should start with no transition on its mousemove updates.
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
      setAnimatingClose(false)
      setDragSnap({ id: seg.id, originalDur: originalEnd - originalStart, type })
      setDragViewStart(viewStartRef.current)
      onDragBegin()

      function onMouseMove(ev: MouseEvent) {
        const w  = getWidth()
        const vd = visibleDurationRef.current
        const dx = ev.clientX - startX
        const dt = vd > 0 ? (dx / w) * vd : 0
        const raw = originalTime + dt

        // Clamp here too so the playhead seek can't fling mpv into a region
        // outside the segment being trimmed. The receiver enforces the same
        // range authoritatively via the pre-drag bounds we pass below.
        const clamped = type === 'start'
          ? clamp(raw, originalStart, originalEnd - MIN_FRAME_GAP_S)
          : clamp(raw, originalStart + MIN_FRAME_GAP_S, originalEnd)

        if (type === 'start') {
          onUpdateSegmentStart(seg.id, clamped, originalStart)
        } else {
          onUpdateSegmentEnd(seg.id, clamped, originalEnd)
        }
        onSeek(clamped)
      }

      function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        setDragViewStart(null)
        // Clearing dragSnap drops the phantom-gap shift; adding animatingClose
        // in the same render enables the CSS transition so segments slide from
        // their frozen positions to live cumulative positions. The class is
        // removed shortly after the transition completes.
        setDragSnap(null)
        setAnimatingClose(true)
        closeTimerRef.current = window.setTimeout(() => {
          setAnimatingClose(false)
          closeTimerRef.current = null
        }, 240)
        onDragEnd()
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [onUpdateSegmentStart, onUpdateSegmentEnd, onSeek, onDragBegin, onDragEnd]
  )

  // ── Click ruler to seek ─────────────────────────────────────────────────
  // Click x → kept-time → source-time (via keptToSource).
  const handleRulerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!containerRef.current || keptDur === 0) return
      const rect = containerRef.current.getBoundingClientRect()
      const px   = e.clientX - rect.left
      const vd   = visibleDurationRef.current
      const keptT = effectiveViewStart + (vd > 0 ? (px / rect.width) * vd : 0)
      const hit  = keptToSource(keptT, sortedSegsRef.current)
      if (hit) onSeek(hit.sourceT)
    },
    [keptDur, effectiveViewStart, onSeek]
  )

  // ── Render ──────────────────────────────────────────────────────────────

  const w = containerWidth

  // Kept-time → pixel
  const xOfKept = (keptT: number) =>
    visibleDuration > 0 ? ((keptT - effectiveViewStart) / visibleDuration) * w : 0

  const rulerTicks = useMemo(() => {
    if (!(keptDur > 0 && w > 0 && visibleDuration > 0)) return null

    const majorInterval = computeTickInterval(visibleDuration, w)
    const minorInterval = majorInterval / SUBDIVISIONS
    const firstTick = Math.floor(effectiveViewStart / minorInterval) * minorInterval
    const lastTick  = effectiveViewStart + visibleDuration
    const els: React.ReactNode[] = []

    for (let t = firstTick; t <= lastTick; t += minorInterval) {
      if (t < 0) continue
      const isMajor = Math.abs(Math.round(t / majorInterval) * majorInterval - t) < 1e-6
      const x = ((t - effectiveViewStart) / visibleDuration) * w

      els.push(
        <Fragment key={t}>
          <div className={`ruler-tick${isMajor ? ' major' : ''}`} style={{ left: x }} />
          {isMajor && (
            <span className="ruler-label" style={{ left: x }}>
              {formatTickLabel(t)}
            </span>
          )}
        </Fragment>
      )
    }
    return els
  }, [keptDur, w, effectiveViewStart, visibleDuration])

  // Filmstrip — each slot's kept-time maps back to a SOURCE time (via
  // keptToSource) and then to the nearest thumbnail (which is indexed by
  // source position, since extraction happened against the source).
  const filmstrip = useMemo(() => {
    if (!thumbnails?.length || keptDur === 0 || w === 0 || visibleDuration === 0 || duration <= 0) {
      return null
    }
    const slots = Math.max(1, Math.ceil(w / FILMSTRIP_FRAME_W) + 1)
    const frames: string[] = []
    for (let i = 0; i < slots; i++) {
      const keptT = effectiveViewStart + ((i + 0.5) / slots) * visibleDuration
      const hit   = keptToSource(keptT, sortedSegs)
      if (!hit) {
        frames.push('')
        continue
      }
      const frac = Math.max(0, Math.min(1, hit.sourceT / duration))
      const idx  = Math.round(frac * (thumbnails.length - 1))
      frames.push(thumbnails[Math.max(0, Math.min(thumbnails.length - 1, idx))])
    }
    return (
      <div className="filmstrip">
        {frames.map((src, i) => (
          <div
            key={i}
            className="filmstrip-frame"
            style={src ? { backgroundImage: `url(${src})` } : undefined}
          />
        ))}
      </div>
    )
  }, [thumbnails, duration, keptDur, sortedSegs, effectiveViewStart, visibleDuration, w])

  const segmentBlocks = useMemo(() =>
    placed.map(({ seg, keptStart, keptEnd }, i) => {
      // Phantom-gap shift during an active trim drag:
      //   - segments AFTER the dragged one render at their pre-drag offsets
      //     (shifted right by phantomGap relative to live cumulative)
      //   - the dragged segment itself shifts right ONLY on a LEFT-handle
      //     drag, so its left edge follows the cursor. RIGHT-handle drag
      //     already renders correctly at the cumulative position.
      let shift = 0
      if (draggedIndex >= 0) {
        if (i > draggedIndex) shift = phantomGap
        else if (i === draggedIndex && draggedType === 'start') shift = phantomGap
      }
      const dispLeft  = keptStart + shift
      const dispRight = keptEnd   + shift
      const left  = ((dispLeft  - effectiveViewStart) / Math.max(visibleDuration, 1e-9)) * w
      const right = ((dispRight - effectiveViewStart) / Math.max(visibleDuration, 1e-9)) * w
      const realWidth = right - left
      const isTiny    = realWidth < MIN_SEGMENT_PX
      const width     = isTiny ? 2 : realWidth
      const isSelected = seg.id === selectedSegmentId

      const bg = `linear-gradient(180deg, color-mix(in oklch, ${seg.color} 52%, transparent) 0%, color-mix(in oklch, ${seg.color} 34%, transparent) 100%)`

      const cls = `segment-block${isSelected ? ' selected' : ''}${isTiny ? ' tiny' : ''}${animatingClose ? ' animating-trim-close' : ''}`

      return (
        <div
          key={seg.id}
          className={cls}
          style={{
            left,
            width,
            background: isTiny ? seg.color : bg,
            borderColor: seg.color,
          }}
          onMouseDown={e => {
            e.stopPropagation()
            onSelectSegment(seg.id)
          }}
          title={`Source ${formatTime(seg.start)} → ${formatTime(seg.end)}`}
        >
          {!isTiny && (
            <>
              <div
                className="seg-handle seg-handle-left"
                onMouseDown={e => startDrag(e, 'start', seg)}
                title="Drag to trim start (or press I)"
              />
              <div
                className="seg-handle seg-handle-right"
                onMouseDown={e => startDrag(e, 'end', seg)}
                title="Drag to trim end (or press O)"
              />
            </>
          )}
        </div>
      )
    }),
    [placed, selectedSegmentId, w, effectiveViewStart, visibleDuration, startDrag, onSelectSegment, draggedIndex, phantomGap, draggedType, animatingClose]
  )

  const playheadX = playheadKept != null ? xOfKept(playheadKept) : null

  return (
    <div
      ref={containerRef}
      className="timeline-container"
    >
      <div className="ruler-area" onMouseDown={handleRulerMouseDown}>
        {rulerTicks}
      </div>

      <div
        className="segments-area"
        onMouseDown={e => {
          if ((e.target as HTMLElement).classList.contains('segments-area')) {
            onSelectSegment(null)
          }
        }}
      >
        {filmstrip}
        {segmentBlocks}
      </div>

      {playheadX != null && (
        <div className="playhead" style={{ left: playheadX }}>
          <div className="playhead-head" />
          <div className="playhead-line" />
        </div>
      )}
    </div>
  )
}
