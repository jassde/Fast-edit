import { useEffect } from 'react'
import {
  MIN_FRAMES_PER_SCROLL_TICK,
  MAX_FRAMES_PER_SCROLL_TICK,
  MIN_SECONDS_PER_SHIFT_SCROLL_TICK,
  MAX_SECONDS_PER_SHIFT_SCROLL_TICK,
} from '../constants'
import { HwEncoder, HwSupport } from '../types'

// ── Props ─────────────────────────────────────────────────────────────────────

type SettingsModalProps = {
  framesPerScrollTick:       number
  secondsPerShiftScrollTick: number
  hwEncoder:                 HwEncoder
  hwSupport:                 HwSupport
  showScrollPanel:           boolean
  onChangeFrames:            (n: number) => void
  onChangeSeconds:           (n: number) => void
  onChangeHwEncoder:         (e: HwEncoder) => void
  onToggleScrollPanel:       (b: boolean) => void
  onClose:                   () => void
}

const HW_LABELS: Record<HwEncoder, string> = {
  auto:  'Auto (best available)',
  none:  'Software (CPU)',
  nvenc: 'NVIDIA NVENC',
  qsv:   'Intel Quick Sync',
  amf:   'AMD AMF',
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SettingsModal({
  framesPerScrollTick,
  secondsPerShiftScrollTick,
  hwEncoder,
  hwSupport,
  showScrollPanel,
  onChangeFrames,
  onChangeSeconds,
  onChangeHwEncoder,
  onToggleScrollPanel,
  onClose,
}: SettingsModalProps) {
  // Always offer Auto and Software; gate vendor-specific options on whether
  // ffmpeg has the encoder compiled in.
  const hwOptions: HwEncoder[] = ['auto', 'none']
  if (hwSupport.nvenc) hwOptions.push('nvenc')
  if (hwSupport.qsv)   hwOptions.push('qsv')
  if (hwSupport.amf)   hwOptions.push('amf')

  // If a previously-persisted vendor selection is no longer supported (e.g.
  // user uninstalled GPU drivers), still show it as the current value so the
  // dropdown isn't desynced from state — they can pick something else.
  if (!hwOptions.includes(hwEncoder)) {
    hwOptions.push(hwEncoder)
  }

  // Escape closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Settings">

        <div className="modal-title">Settings</div>

        {/* Frames-per-scroll-tick */}
        <div className="modal-field">
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
            />
            <span className="settings-slider-bound">{MAX_FRAMES_PER_SCROLL_TICK}</span>
          </div>
        </div>

        {/* Seconds-per-shift-scroll-tick */}
        <div className="modal-field">
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
            />
            <span className="settings-slider-bound">{MAX_SECONDS_PER_SHIFT_SCROLL_TICK}</span>
          </div>
        </div>

        {/* Floating scroll-step panel toggle */}
        <div className="modal-field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showScrollPanel}
              onChange={e => onToggleScrollPanel(e.target.checked)}
            />
            Show floating scroll-step panel while editing
          </label>
        </div>

        {/* Hardware encoder */}
        <div className="modal-field">
          <span className="modal-label">
            Hardware encoder (re-encode only)
          </span>
          <select
            className="modal-select"
            value={hwEncoder}
            onChange={e => onChangeHwEncoder(e.target.value as HwEncoder)}
          >
            {hwOptions.map(opt => (
              <option key={opt} value={opt}>{HW_LABELS[opt]}</option>
            ))}
          </select>
          <span className="modal-hint">
            GPU encoders are 5 to 10 times faster but produce slightly larger files at the same quality.
            Lossless always uses CPU.
          </span>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Close</button>
        </div>

      </div>
    </div>
  )
}
