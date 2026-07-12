import { useState, useEffect } from 'react'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

const MIN_SPEED = 0.25
const MAX_SPEED = 2
const MIN_SCALE = 0.1
const MAX_SCALE = 2

type EffectsSettingsPayload = {
  speed: number
  scale: number
}

type EffectsChangePayload =
  | { kind: 'speed' | 'scale'; value: number }
  | { kind: 'reset' }

export function EffectsPanelApp() {
  const [speed, setSpeed] = useState(1)
  const [scale, setScale] = useState(1)

  useEffect(() => {
    let unlisten: (() => void) | null = null
    let aborted = false

    listen<EffectsSettingsPayload>('effects-settings', (e) => {
      setSpeed(e.payload.speed)
      setScale(e.payload.scale)
    }).then((ul) => {
      if (aborted) ul()
      else unlisten = ul
    })

    return () => {
      aborted = true
      unlisten?.()
    }
  }, [])

  const handleSpeedChange = (value: number) => {
    setSpeed(value)
    emit<EffectsChangePayload>('effects-change', { kind: 'speed', value }).catch(console.error)
  }

  const handleScaleChange = (value: number) => {
    setScale(value)
    emit<EffectsChangePayload>('effects-change', { kind: 'scale', value }).catch(console.error)
  }

  const handleReset = () => {
    setScale(1)
    setSpeed(1)
    emit<EffectsChangePayload>('effects-change', { kind: 'reset' }).catch(console.error)
  }

  const handleClose = () => {
    getCurrentWindow().close().catch(console.error)
  }

  return (
    <div className="effects-panel-root">
      <div className="float-panel-header" data-tauri-drag-region>
        <span data-tauri-drag-region>Effects</span>
        <button
          className="effects-reset-btn"
          onClick={handleReset}
          title="Reset effects"
          aria-label="Reset effects"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z" />
            <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466" />
          </svg>
        </button>
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
        <div className="effects-slider-card">
          <div className="effects-slider-header">
            <span className="effects-slider-label">SCALE</span>
            <span className="effects-slider-value">{Math.round(scale * 100)} %</span>
          </div>
          <div className="effects-slider-track">
            <input
              type="range"
              className="effects-range-input"
              min={MIN_SCALE}
              max={MAX_SCALE}
              step={0.01}
              value={scale}
              onChange={(e) => handleScaleChange(Number(e.target.value))}
              aria-label="Scale"
            />
          </div>
          <div className="effects-slider-bounds">
            <span>{Math.round(MIN_SCALE * 100)}%</span>
            <span>{Math.round(MAX_SCALE * 100)}%</span>
          </div>
        </div>

        <div className="effects-slider-card">
          <div className="effects-slider-header">
            <span className="effects-slider-label">SPEED</span>
            <span className="effects-slider-value">{speed.toFixed(2)} x</span>
          </div>
          <div className="effects-slider-track">
            <input
              type="range"
              className="effects-range-input"
              min={MIN_SPEED}
              max={MAX_SPEED}
              step={0.05}
              value={speed}
              onChange={(e) => handleSpeedChange(Number(e.target.value))}
              aria-label="Playback speed"
            />
          </div>
          <div className="effects-slider-bounds">
            <span>{MIN_SPEED} x</span>
            <span>{MAX_SPEED} x</span>
          </div>
        </div>
      </div>
    </div>
  )
}
