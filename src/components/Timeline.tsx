import { useRef, useCallback, useEffect, useState } from 'react'
import { Segment } from '../types'
import { clamp, pixelToTime, timeToPixel, formatTime } from '../utils'
import { DEFAULT_FPS, MIN_SEGMENT_PX } from '../constants'

// ── Props ─────────────────────────────────────────────────────────────────────

type TimelineProps = {
  duration: number
  segments: Segment[]
  selectedSegmentId: string | null
  playheadPosition: number
  framesPerScrollTick: number
  secondsPerShiftScrollTick: number
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
}

// ── Ruler tick interval ───────────────────────────────────────────────────────

const NICE_INTERVALS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 3600]

function computeTickInterval(visibleDuration: number, widthPx: number): number {
  if (widthPx === 0 || visibleDuration === 0) return 1
  const pixelsPerSecond = widthPx / visibleDuration
  const TARGET_PX = 60
  const rawInterval = TARGET_PX / pixelsPerSecond
  return NICE_INTERVALS.find(v => v >= rawInterval) ?? 3600
}

function formatTickLabel(seconds: number): string {
  if (seconds < 60)   return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h${Math.round((seconds % 3600) / 60)}m`
}

// ── Component ─────────────────────────────────────────────────────────────────

export function Timeline({
  duration,
  segments,
  selectedSegmentId,
  playheadPosition,
  framesPerScrollTick,
  secondsPerShiftScrollTick,
  zoom,
  onSeek,
  onSelectSegment,
  onUpdateSegmentStart,
  onUpdateSegmentEnd,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const getWidth = () => containerRef.current?.getBoundingClientRect().width ?? 0

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
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [onUpdateSegmentStart, onUpdateSegmentEnd, onSeek]
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

  // ── Scroll wheel ────────────────────────────────────────────────────────
  // React attaches `wheel` as a passive listener, so e.preventDefault() inside
  // a React onWheel handler is a no-op. Attach a native non-passive listener
  // so the page doesn't scroll when the user wheels over the timeline.
  //
  // The handler reads playheadPosition through a ref so the effect doesn't
  // re-fire on every mpv position update (~30 fps), which would tear down and
  // re-add the listener on every animation frame.

  const playheadRef = useRef(playheadPosition)
  playheadRef.current = playheadPosition

  // Mirror settings into refs so the wheel useEffect doesn't re-register when
  // the user adjusts a slider — same pattern as playheadRef above.
  const framesRef  = useRef(framesPerScrollTick)
  const secondsRef = useRef(secondsPerShiftScrollTick)
  framesRef.current  = framesPerScrollTick
  secondsRef.current = secondsPerShiftScrollTick

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handleWheel = (e: WheelEvent) => {
      if (duration === 0) return
      e.preventDefault()
      const direction = e.deltaY > 0 ? 1 : -1
      const stepSec   = e.shiftKey
        ? direction * secondsRef.current
        : direction * framesRef.current * (1 / DEFAULT_FPS)
      const newPos    = clamp(playheadRef.current + stepSec, 0, duration)
      onSeek(newPos)
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [duration, onSeek])

  // ── Render ──────────────────────────────────────────────────────────────

  const w = getWidth()  // may be 0 on first render — that's fine, ticks won't show

  // Convert an absolute time into a visible-window pixel x.
  const xOf = (t: number) => timeToPixel(t - effectiveViewStart, w, visibleDuration)

  // Ruler ticks — only generate ticks within the visible window.
  const tickInterval = computeTickInterval(visibleDuration, w)
  const ticks: { time: number; major: boolean }[] = []
  if (duration > 0 && w > 0 && visibleDuration > 0) {
    const firstTick = Math.floor(effectiveViewStart / tickInterval) * tickInterval
    const lastTick  = effectiveViewStart + visibleDuration
    for (let t = firstTick; t <= lastTick; t += tickInterval) {
      if (t < 0) continue
      const isMajor = Math.round(t / tickInterval) % 5 === 0
      ticks.push({ time: t, major: isMajor })
    }
  }

  const playheadX = duration > 0 ? xOf(playheadPosition) : 0

  return (
    <div
      ref={containerRef}
      className="timeline-container"
    >
      {/* ── Ruler ── */}
      <div className="ruler-area" onMouseDown={handleRulerMouseDown}>
        {ticks.map(({ time, major }) => {
          const x = xOf(time)
          return (
            <div key={time}>
              <div
                className={`ruler-tick ${major ? 'major' : ''}`}
                style={{ left: x }}
              />
              {major && (
                <span className="ruler-label" style={{ left: x }}>
                  {formatTickLabel(time)}
                </span>
              )}
            </div>
          )
        })}
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
        {segments.map(seg => {
          const left  = duration > 0 ? xOf(seg.start) : 0
          const right = duration > 0 ? xOf(seg.end)   : 0
          const width = Math.max(right - left, MIN_SEGMENT_PX)
          const isSelected = seg.id === selectedSegmentId

          return (
            <div
              key={seg.id}
              className={`segment-block${isSelected ? ' selected' : ''}`}
              style={{
                left,
                width,
                background: seg.color + '44',
                borderColor: seg.color,
              }}
              onMouseDown={e => {
                e.stopPropagation()
                onSelectSegment(seg.id)
              }}
              title={`${formatTime(seg.start)} – ${formatTime(seg.end)}`}
            >
              {/* Left (start) handle */}
              <div
                className="seg-handle seg-handle-left"
                onMouseDown={e => startDrag(e, 'start', seg)}
                title="Drag to adjust start (or press I)"
              />
              {/* Right (end) handle */}
              <div
                className="seg-handle seg-handle-right"
                onMouseDown={e => startDrag(e, 'end', seg)}
                title="Drag to adjust end (or press O)"
              />
            </div>
          )
        })}
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
