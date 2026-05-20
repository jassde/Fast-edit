import { useEffect, useRef } from 'react'
import { AppState, AppActions } from './useAppState'

type PlaybackCommands = {
  play:          () => void
  pause:         () => void
  frameStep:     () => void
  frameBackStep: () => void
}

/**
 * Global keyboard shortcut handler.
 *
 * Uses a ref to avoid re-registering the listener on every state change
 * (playback-position fires ~30fps which would otherwise cause constant
 * addEventListener/removeEventListener churn).
 *
 * Active when:
 * - No modal is open (export or settings).
 * - Focus is not inside an <input>, <select>, or <textarea> element.
 *
 * Shortcuts:
 *   Space       → play / pause toggle
 *   ←           → frame back step
 *   →           → frame forward step
 *   I / i       → set start of selected segment to playhead
 *   O / o       → set end of selected segment to playhead
 *   Delete      → delete selected segment
 */
export function useKeyboard(
  state: AppState,
  actions: AppActions,
  playback: PlaybackCommands,
) {
  // Keep a ref that always points to the latest values.
  // The keydown handler reads from the ref, so we never need
  // to tear down / re-add the listener when state changes.
  const stateRef    = useRef(state)
  const actionsRef  = useRef(actions)
  const playbackRef = useRef(playback)

  stateRef.current    = state
  actionsRef.current  = actions
  playbackRef.current = playback

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const s = stateRef.current
      const a = actionsRef.current
      const p = playbackRef.current

      if (s.showExportModal || s.showSettingsModal) return

      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA'
      ) {
        return
      }

      switch (e.key) {
        case ' ':
          e.preventDefault()
          if (s.isPlaying) {
            p.pause()
            a.setIsPlaying(false)
          } else {
            p.play()
            a.setIsPlaying(true)
          }
          break

        case 'ArrowLeft':
          e.preventDefault()
          p.frameBackStep()
          break

        case 'ArrowRight':
          e.preventDefault()
          p.frameStep()
          break

        case 'i':
        case 'I':
          if (s.selectedSegmentId) {
            a.setSelectedStart(s.playheadPosition)
          }
          break

        case 'o':
        case 'O':
          if (s.selectedSegmentId) {
            a.setSelectedEnd(s.playheadPosition)
          }
          break

        case 'Delete':
          if (s.selectedSegmentId) {
            a.deleteSegment(s.selectedSegmentId)
          }
          break

        default:
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, []) // ← registered once, reads latest values via refs
}
