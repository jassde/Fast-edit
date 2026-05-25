import { useRef, useState } from 'react'
import {
  MIN_FRAMES_PER_SCROLL_TICK,
  MAX_FRAMES_PER_SCROLL_TICK,
  MIN_SECONDS_PER_SHIFT_SCROLL_TICK,
  MAX_SECONDS_PER_SHIFT_SCROLL_TICK,
} from '../constants'

type Props = {
  framesPerScrollTick:       number
  secondsPerShiftScrollTick: number
  onChangeFrames:            (n: number) => void
  onChangeSeconds:           (n: number) => void
  onClose:                   () => void
}

/**
 * Persistent floating panel mirroring the two scroll-step sliders from the
 * Settings modal, so frames/seconds can be tuned while editing. Draggable by
 * its header; position is session-only (resets on reopen). The sliders bind to
 * the same state/actions as the Settings modal, so the two stay in sync.
 */
export function ScrollSettingsPanel({
  framesPerScrollTick,
  secondsPerShiftScrollTick,
  onChangeFrames,
  onChangeSeconds,
  onClose,
}: Props) {
  const [pos, setPos] = useState({ x: 24, y: 72 })
  const dragOffset = useRef({ dx: 0, dy: 0 })

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    dragOffset.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }

    const onMouseMove = (ev: MouseEvent) => {
      setPos({
        x: ev.clientX - dragOffset.current.dx,
        y: ev.clientY - dragOffset.current.dy,
      })
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  return (
    <div className="float-panel" style={{ left: pos.x, top: pos.y }}>
      <div className="float-panel-header" onMouseDown={startDrag}>
        <span>Scroll step</span>
        <button
          className="float-panel-close"
          onClick={onClose}
          title="Close panel"
          aria-label="Close panel"
        >
          ×
        </button>
      </div>

      <div className="float-panel-body">
        {/* Frames per scroll tick */}
        <div>
          <span className="modal-label">
            Scroll wheel: <strong>{framesPerScrollTick}</strong> frame{framesPerScrollTick === 1 ? '' : 's'} per tick
          </span>
          <div className="settings-slider-row">
            <span className="settings-slider-bound">{MIN_FRAMES_PER_SCROLL_TICK}</span>
            <input
              type="range"
              className="settings-slider"
              min={MIN_FRAMES_PER_SCROLL_TICK}
              max={MAX_FRAMES_PER_SCROLL_TICK}
              step={1}
              value={framesPerScrollTick}
              onChange={e => onChangeFrames(Number(e.target.value))}
              aria-label="Frames per scroll tick"
            />
            <span className="settings-slider-bound">{MAX_FRAMES_PER_SCROLL_TICK}</span>
          </div>
        </div>

        {/* Seconds per shift+scroll tick */}
        <div>
          <span className="modal-label">
            Shift + scroll: <strong>{secondsPerShiftScrollTick}</strong> second{secondsPerShiftScrollTick === 1 ? '' : 's'} per tick
          </span>
          <div className="settings-slider-row">
            <span className="settings-slider-bound">{MIN_SECONDS_PER_SHIFT_SCROLL_TICK}</span>
            <input
              type="range"
              className="settings-slider"
              min={MIN_SECONDS_PER_SHIFT_SCROLL_TICK}
              max={MAX_SECONDS_PER_SHIFT_SCROLL_TICK}
              step={1}
              value={secondsPerShiftScrollTick}
              onChange={e => onChangeSeconds(Number(e.target.value))}
              aria-label="Seconds per shift-scroll tick"
            />
            <span className="settings-slider-bound">{MAX_SECONDS_PER_SHIFT_SCROLL_TICK}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
