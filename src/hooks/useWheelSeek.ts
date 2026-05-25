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
 * - A modal is open (export or settings) — so the modal's own scrollable areas
 *   (e.g. the segment checklist) behave normally.
 * - Focus/hover target is an <input>, <select>, or <textarea> (sliders, etc.).
 */
export function useWheelSeek(
  state: AppState,
  actions: AppActions,
  playback: PlaybackCommands,
) {
  const stateRef    = useRef(state)
  const actionsRef  = useRef(actions)
  const playbackRef = useRef(playback)

  stateRef.current    = state
  actionsRef.current  = actions
  playbackRef.current = playback

  useEffect(() => {
    function handleWheel(e: WheelEvent) {
      const s = stateRef.current
      const a = actionsRef.current
      const p = playbackRef.current

      if (s.duration === 0) return
      if (s.showExportModal || s.showSettingsModal) return

      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA'
      ) {
        return
      }

      e.preventDefault()
      const direction = e.deltaY > 0 ? 1 : -1
      const stepSec   = e.shiftKey
        ? direction * s.secondsPerShiftScrollTick
        : direction * s.framesPerScrollTick * (1 / (s.fps || DEFAULT_FPS))
      const newPos    = clamp(s.playheadPosition + stepSec, 0, s.duration)

      p.seek(newPos)
      a.setPlayheadPosition(newPos)
    }

    window.addEventListener('wheel', handleWheel, { passive: false })
    return () => window.removeEventListener('wheel', handleWheel)
  }, []) // ← registered once, reads latest values via refs
}
