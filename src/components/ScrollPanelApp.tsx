import { useState, useEffect } from 'react'
import { emit, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import {
  MIN_FRAMES_PER_SCROLL_TICK,
  MAX_FRAMES_PER_SCROLL_TICK,
  MIN_SECONDS_PER_SHIFT_SCROLL_TICK,
  MAX_SECONDS_PER_SHIFT_SCROLL_TICK,
  DEFAULT_FRAMES_PER_SCROLL_TICK,
  DEFAULT_SECONDS_PER_SHIFT_SCROLL_TICK,
  SETTINGS_STORAGE_KEY,
} from '../constants'
import { clamp } from '../utils'

// Mirror the persisted settings shape from useAppState.
type PersistedSettings = {
  framesPerScrollTick?: number
  secondsPerShiftScrollTick?: number
}

function readFromStorage(): { frames: number; seconds: number } {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return { frames: DEFAULT_FRAMES_PER_SCROLL_TICK, seconds: DEFAULT_SECONDS_PER_SHIFT_SCROLL_TICK }
    const parsed: PersistedSettings = JSON.parse(raw)
    const rawFrames  = parsed.framesPerScrollTick       ?? DEFAULT_FRAMES_PER_SCROLL_TICK
    const rawSeconds = parsed.secondsPerShiftScrollTick ?? DEFAULT_SECONDS_PER_SHIFT_SCROLL_TICK
    return {
      frames:  isNaN(rawFrames)  ? DEFAULT_FRAMES_PER_SCROLL_TICK  : clamp(rawFrames,  MIN_FRAMES_PER_SCROLL_TICK,  MAX_FRAMES_PER_SCROLL_TICK),
      seconds: isNaN(rawSeconds) ? DEFAULT_SECONDS_PER_SHIFT_SCROLL_TICK : clamp(rawSeconds, MIN_SECONDS_PER_SHIFT_SCROLL_TICK, MAX_SECONDS_PER_SHIFT_SCROLL_TICK),
    }
  } catch {
    return { frames: DEFAULT_FRAMES_PER_SCROLL_TICK, seconds: DEFAULT_SECONDS_PER_SHIFT_SCROLL_TICK }
  }
}

type ScrollSettingsPayload = {
  framesPerScrollTick: number
  secondsPerShiftScrollTick: number
}

export function ScrollPanelApp() {
  const [frames,  setFrames]  = useState(() => readFromStorage().frames)
  const [seconds, setSeconds] = useState(() => readFromStorage().seconds)

  // Sync incoming state from the main window. Note: the main window emits
  // scroll-settings on tauri://created, but that event may arrive before
  // this listener registers — localStorage initial values cover that gap.
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let aborted = false

    listen<ScrollSettingsPayload>('scroll-settings', e => {
      setFrames(e.payload.framesPerScrollTick)
      setSeconds(e.payload.secondsPerShiftScrollTick)
    }).then(ul => {
      if (aborted) ul()
      else unlisten = ul
    })

    return () => {
      aborted = true
      unlisten?.()
    }
  }, [])

  // Re-focus the main window on every mousedown so keyboard shortcuts keep
  // working in the editor while the user adjusts sliders here.
  useEffect(() => {
    const refocus = () => {
      WebviewWindow.getByLabel('main').then(win => win?.setFocus())
    }
    document.addEventListener('mousedown', refocus, { capture: true })
    return () => document.removeEventListener('mousedown', refocus, { capture: true })
  }, [])

  const handleFramesChange = (value: number) => {
    setFrames(value)
    emit('scroll-settings-change', { kind: 'frames', value }).catch(console.error)
  }

  const handleSecondsChange = (value: number) => {
    setSeconds(value)
    emit('scroll-settings-change', { kind: 'seconds', value }).catch(console.error)
  }

  const handleClose = () => {
    emit('scroll-panel-close', null).catch(console.error)
  }

  return (
    <div className="scroll-panel-root">
      <div className="float-panel-header" data-tauri-drag-region>
        <span data-tauri-drag-region>Scroll step</span>
        <button
          className="float-panel-close"
          onClick={handleClose}
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
            Scroll wheel: <strong>{frames}</strong> frame{frames === 1 ? '' : 's'} per tick
          </span>
          <div className="settings-slider-row">
            <span className="settings-slider-bound">{MIN_FRAMES_PER_SCROLL_TICK}</span>
            <input
              type="range"
              className="settings-slider"
              min={MIN_FRAMES_PER_SCROLL_TICK}
              max={MAX_FRAMES_PER_SCROLL_TICK}
              step={1}
              value={frames}
              onChange={e => handleFramesChange(Number(e.target.value))}
              aria-label="Frames per scroll tick"
            />
            <span className="settings-slider-bound">{MAX_FRAMES_PER_SCROLL_TICK}</span>
          </div>
        </div>

        {/* Seconds per shift+scroll tick */}
        <div>
          <span className="modal-label">
            Shift + scroll: <strong>{seconds}</strong> second{seconds === 1 ? '' : 's'} per tick
          </span>
          <div className="settings-slider-row">
            <span className="settings-slider-bound">{MIN_SECONDS_PER_SHIFT_SCROLL_TICK}</span>
            <input
              type="range"
              className="settings-slider"
              min={MIN_SECONDS_PER_SHIFT_SCROLL_TICK}
              max={MAX_SECONDS_PER_SHIFT_SCROLL_TICK}
              step={1}
              value={seconds}
              onChange={e => handleSecondsChange(Number(e.target.value))}
              aria-label="Seconds per shift-scroll tick"
            />
            <span className="settings-slider-bound">{MAX_SECONDS_PER_SHIFT_SCROLL_TICK}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
