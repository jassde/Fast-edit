import { Fragment, useRef, useCallback, useState, useMemo, useEffect } from 'react'
import { Segment } from '../types'
import { clamp, pixelToTime, timeToPixel, formatTime } from '../utils'
import { MIN_SEGMENT_PX } from '../constants'

// ── Props ─────────────────────────────────────────────────────────────────────

type TimelineProps = {
  duration: number
  segments: Segment[]
  selectedSegmentId: string | null
  playheadPosition: number
  /**
   * Magnification factor. 1 = full timeline visible. Higher zoom shows a
   * window of `duration / zoom` seconds, auto-centered on the playhead and
   * clamped to the video bounds.
   */
  zoom: number
  onSeek: (time: number) => void
  onSelectSegment: (id: string | null) => void
  onUpdateSegmentStart: (id: string, start: number) => void
  onUpdateSegmentEnd: (id: string, end: number) => void
  /** Called on handle mousedown — captures pre-drag state for undo coalescing. */
  onDragBegin: () => void
  /** Called on handle mouseup — commits the coalesced snapshot to undo stack. */
  onDragEnd: () => void
}

// ── Ruler tick interval ───────────────────────────────────────────────────────

// Major intervals that labels snap to. Minor ticks subdivide each major interval.
// Smallest is 1s — sub-second intervals would force formatTickLabel to round
// to integers, causing adjacent labels to collide (e.g. 0.5s and 1.0s both
// rendering as "0:01").
const NICE_INTERVALS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 3600]

/** How many minor subdivisions between each major (label-bearing) tick. */
const SUBDIVISIONS = 5

function computeTickInterval(visibleDuration: number, widthPx: number): number {
  if (widthPx === 0 || visibleDuration === 0) return 1
  const pixelsPerSecond = widthPx / visibleDuration
  // Target ~80 px between major ticks → more labels visible at once
  const TARGET_PX = 80
  const rawInterval = TARGET_PX / pixelsPerSecond
  return NICE_INTERVALS.find(v => v >= rawInterval) ?? 3600
}

/** Format seconds as H:MM:SS, M:SS, or 0:SS depending on magnitude. */
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
  onSeek,
  onSelectSegment,
  onUpdateSegmentStart,
  onUpdateSegmentEnd,
  onDragBegin,
  onDragEnd,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Track the container's pixel width so ruler ticks and segment blocks
  // recompute whenever the timeline is resized (e.g. window resize, sidebar
  // open/close). Without this, segments stay at stale pixel positions until
  // the next state-driven re-render.
  //
  // Two parallel trackers:
  //  - containerWidth  (state) → triggers re-renders, used in useMemo dep arrays
  //  - containerWidthRef (ref) → always current, used inside startDrag's
  //    onMouseMove closure where the state value would be stale (startDrag is a
  //    useCallback whose deps don't include containerWidth, so it captures the
  //    getWidth from its last creation — the same pattern as visibleDurationRef).
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

  // Reads the ref so all closures (including stale ones in startDrag) always
  // get the current width, regardless of when they were created.
  const getWidth = () => containerWidthRef.current

  // ── Visible-window math (zoom) ──────────────────────────────────────────
  // At zoom=1 the entire video is visible. At higher zooms we show a window
  // of `duration / zoom` seconds, auto-centered on the playhead and clamped
  // to the video bounds. All time↔pixel conversions below are in this window.
  const safeZoom         = Math.max(1, zoom)
  const visibleDuration  = duration > 0 ? duration / safeZoom : 0
  const maxViewStart     = Math.max(0, duration - visibleDuration)
  const viewStart        = duration > 0
    ? clamp(playheadPosition - visibleDuration / 2, 0, maxViewStart)
    : 0

  // While a handle is being dragged we freeze the view origin. Without this,
  // each drag mousemove seeks → moves the playhead → recomputes viewStart →
  // the pixel origin slides under the cursor, so at high zoom the grabbed edge
  // visibly drifts away. `dragViewStart` holds the frozen origin during a drag.
  const [dragViewStart, setDragViewStart] = useState<number | null>(null)
  const effectiveViewStart = dragViewStart ?? viewStart

  // ── Drag handle logic ───────────────────────────────────────────────────
  // The drag effect operates in time-space, so it has to mirror visibleDuration
  // (the dragged distance in pixels translates to a smaller time delta when
  // zoomed in). viewStart is mirrored too so the freeze can capture the live
  // value without re-registering the callback.
  const visibleDurationRef = useRef(visibleDuration)
  visibleDurationRef.current = visibleDuration
  const viewStartRef = useRef(viewStart)
  viewStartRef.current = viewStart

  const startDrag = useCallback(
    (e: React.MouseEvent, type: 'start' | 'end', seg: Segment) => {
      e.preventDefault()
      e.stopPropagation()

      const startX = e.clientX
      const originalTime = type === 'start' ? seg.start : seg.end

      // Freeze the view origin for the duration of this drag.
      setDragViewStart(viewStartRef.current)

      // Capture pre-drag state for undo coalescing. The matching onDragEnd in
      // onMouseUp pushes one undo entry — no matter how many intermediate
      // setSegmentStart/End calls fire from onMouseMove.
      onDragBegin()

      function onMouseMove(ev: MouseEvent) {
        const w  = getWidth()
        const vd = visibleDurationRef.current
        const dx = ev.clientX - startX
        const dt = vd > 0 ? (dx / w) * vd : 0
        const newTime = originalTime + dt

        if (type === 'start') {
          onUpdateSegmentStart(seg.id, newTime)
        } else {
          onUpdateSegmentEnd(seg.id, newTime)
        }
        onSeek(newTime)
      }

      function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        // Release the frozen origin → resume auto-centering on the playhead.
        setDragViewStart(null)
        onDragEnd()
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [onUpdateSegmentStart, onUpdateSegmentEnd, onSeek, onDragBegin, onDragEnd]
  )

  // ── Click ruler to seek ─────────────────────────────────────────────────

  const handleRulerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!containerRef.current || duration === 0) return
      const rect = containerRef.current.getBoundingClientRect()
      const time = effectiveViewStart + pixelToTime(e.clientX - rect.left, rect.width, visibleDuration)
      onSeek(time)
    },
    [duration, effectiveViewStart, visibleDuration, onSeek]
  )

  // ── Render ──────────────────────────────────────────────────────────────

  // containerWidth (state) drives re-renders and useMemo deps.
  // getWidth() (ref) is used inside event-handler closures where state would be stale.
  const w = containerWidth  // may be 0 on first render — that's fine, ticks won't show

  // Convert an absolute time into a visible-window pixel x.
  const xOf = (t: number) => timeToPixel(t - effectiveViewStart, w, visibleDuration)

  // Ruler ticks and segment blocks are memoized on everything they depend on
  // *except* playheadPosition. At zoom = 1 effectiveViewStart is constant, so
  // these element references stay stable while the playhead moves ~30–60×/s and
  // React skips re-rendering them — only the inline playhead below moves.
  const rulerTicks = useMemo(() => {
    if (!(duration > 0 && w > 0 && visibleDuration > 0)) return null

    const majorInterval = computeTickInterval(visibleDuration, w)
    const minorInterval = majorInterval / SUBDIVISIONS
    const firstTick = Math.floor(effectiveViewStart / minorInterval) * minorInterval
    const lastTick  = effectiveViewStart + visibleDuration
    const els: React.ReactNode[] = []

    for (let t = firstTick; t <= lastTick; t += minorInterval) {
      if (t < 0) continue
      // A tick is "major" when it falls on a multiple of the major interval.
      // Round to avoid float drift (e.g. 0.999999 vs 1.0).
      const isMajor = Math.abs(Math.round(t / majorInterval) * majorInterval - t) < 1e-6
      const x = timeToPixel(t - effectiveViewStart, w, visibleDuration)

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
  }, [duration, w, effectiveViewStart, visibleDuration])

  const segmentBlocks = useMemo(() =>
    segments.map(seg => {
      const left      = duration > 0 ? timeToPixel(seg.start - effectiveViewStart, w, visibleDuration) : 0
      const right     = duration > 0 ? timeToPixel(seg.end   - effectiveViewStart, w, visibleDuration) : 0
      const realWidth = right - left
      const isTiny    = realWidth < MIN_SEGMENT_PX
      const width     = isTiny ? 2 : realWidth
      const isSelected = seg.id === selectedSegmentId

      // Layered fill: a vivid color-mix base + a subtle top-light gradient for
      // depth. Keeps timeline readable while making segments pop more than the
      // previous flat 28% mix.
      const bg = `linear-gradient(180deg, color-mix(in oklch, ${seg.color} 52%, transparent) 0%, color-mix(in oklch, ${seg.color} 34%, transparent) 100%)`

      return (
        <div
          key={seg.id}
          className={`segment-block${isSelected ? ' selected' : ''}${isTiny ? ' tiny' : ''}`}
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
          title={`${formatTime(seg.start)} to ${formatTime(seg.end)}`}
        >
          {/* Drag handles only when the segment is wide enough to host them. */}
          {!isTiny && (
            <>
              <div
                className="seg-handle seg-handle-left"
                onMouseDown={e => startDrag(e, 'start', seg)}
                title="Drag to adjust start (or press I)"
              />
              <div
                className="seg-handle seg-handle-right"
                onMouseDown={e => startDrag(e, 'end', seg)}
                title="Drag to adjust end (or press O)"
              />
            </>
          )}
        </div>
      )
    }),
    [segments, selectedSegmentId, duration, w, effectiveViewStart, visibleDuration, startDrag, onSelectSegment]
  )

  const playheadX = duration > 0 ? xOf(playheadPosition) : 0

  return (
    <div
      ref={containerRef}
      className="timeline-container"
    >
      {/* ── Ruler ── */}
      <div className="ruler-area" onMouseDown={handleRulerMouseDown}>
        {rulerTicks}
      </div>

      {/* ── Segments ── */}
      <div
        className="segments-area"
        onMouseDown={e => {
          // Click on empty space → deselect
          if ((e.target as HTMLElement).classList.contains('segments-area')) {
            onSelectSegment(null)
          }
        }}
      >
        {segmentBlocks}
      </div>

      {/* ── Playhead ── */}
      {duration > 0 && (
        <div className="playhead" style={{ left: playheadX }}>
          <div className="playhead-head" />
          <div className="playhead-line" />
        </div>
      )}
    </div>
  )
}
