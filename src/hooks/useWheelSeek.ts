import { useEffect, useRef } from 'react'
import { AppState, AppActions } from './useAppState'
import { clamp } from '../utils'
import { DEFAULT_FPS } from '../constants'

type PlaybackCommands = {
  seek: (pos: number) => void
}

/**
 * Global scroll-wheel seeking.
 *
 * Wheel = step by `framesPerScrollTick` frames (using the clip's real fps);
 * Shift+wheel = step by `secondsPerShiftScrollTick` seconds. Works anywhere in
 * the app window, not just over the timeline — mirrors useKeyboard, which is
 * also a single window-level listener.
 *
 * Uses refs so the listener never re-registers on the ~30–60 fps playhead
 * updates. A non-passive listener is required: window/document `wheel` is
 * passive by default, so preventDefault() would otherwise be a no-op.
 *
 * Suppressed when:
 * - No file is loaded (duration === 0).
 * - A modal is open (export, settings, or shortcuts) — so the modal's own scrollable areas
 *   (e.g. the segment checklist) behave normally.
 * - Focus/hover target is an <input>, <select>, or <textarea> (sliders, etc.).
 */
export function useWheelSeek(
  state: AppState,
  actions: AppActions,
  playback: PlaybackCommands,
  shortcutsModalOpen: boolean,
) {
  const stateRef              = useRef(state)
  const actionsRef            = useRef(actions)
  const playbackRef           = useRef(playback)
  const shortcutsModalOpenRef = useRef(shortcutsModalOpen)

  stateRef.current              = state
  actionsRef.current            = actions
  playbackRef.current           = playback
  shortcutsModalOpenRef.current = shortcutsModalOpen

  useEffect(() => {
    function handleWheel(e: WheelEvent) {
      const s = stateRef.current
      const a = actionsRef.current
      const p = playbackRef.current

      if (s.duration === 0) return
      if (s.showExportModal || s.showSettingsModal || shortcutsModalOpenRef.current) return

      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA'
      ) {
        return
      }

      // Direction detection. Some Windows touchpad / mouse drivers (and a few
      // WebView2 builds) report `e.deltaY` with the SAME sign for both physical
      // scroll directions, breaking direction inference. The legacy
      // `wheelDeltaY` property carries the original WHEEL_DELTA from the OS
      // event (+120 per notch up, -120 per notch down) and is still exposed by
      // Chromium, so prefer it when available. Note its sign convention is the
      // OPPOSITE of `deltaY`: wheelDeltaY > 0 = scroll up = seek backward.
      // Fall back to `deltaY` if `wheelDeltaY` is missing (non-Chromium engines)
      // or zero (smooth-scroll devices that emit deltaY=0 mid-gesture).
      const wd = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY
      const sign = wd !== undefined && wd !== 0
        ? -Math.sign(wd)
        : Math.sign(e.deltaY)
      if (sign === 0) return  // genuine no-direction event — ignore

      e.preventDefault()
      const stepSec = e.shiftKey
        ? sign * s.secondsPerShiftScrollTick
        : sign * s.framesPerScrollTick * (1 / (s.fps || DEFAULT_FPS))
      const newPos  = clamp(s.playheadPosition + stepSec, 0, s.duration)

      p.seek(newPos)
      a.setPlayheadPosition(newPos)
    }

    window.addEventListener('wheel', handleWheel, { passive: false })
    return () => window.removeEventListener('wheel', handleWheel)
  }, []) // ← registered once, reads latest values via refs
}
