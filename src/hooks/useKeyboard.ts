import { useEffect, useRef } from 'react'
import { AppState, AppActions } from './useAppState'
import { ShortcutAction, normaliseKey } from './useShortcuts'

type PlaybackCommands = {
  play:          () => void
  pause:         () => void
  frameStep:     () => void
  frameBackStep: () => void
}

/**
 * Global keyboard shortcut handler.
 *
 * Uses refs to avoid re-registering the listener on every state change
 * (playback-position fires ~30fps which would otherwise cause constant
 * addEventListener/removeEventListener churn).
 *
 * Active when:
 * - No modal is open (export, settings, or shortcuts).
 * - Focus is not inside an <input>, <select>, or <textarea> element.
 *
 * Bindings are looked up via the `keyToAction` map passed in from
 * useShortcuts(); see DEFAULT_SHORTCUTS for the original mapping.
 */
export function useKeyboard(
  state: AppState,
  actions: AppActions,
  playback: PlaybackCommands,
  keyToAction: Map<string, ShortcutAction>,
  shortcutsModalOpen: boolean,
) {
  const stateRef        = useRef(state)
  const actionsRef      = useRef(actions)
  const playbackRef     = useRef(playback)
  const mapRef          = useRef(keyToAction)
  const modalOpenRef    = useRef(shortcutsModalOpen)

  stateRef.current     = state
  actionsRef.current   = actions
  playbackRef.current  = playback
  mapRef.current       = keyToAction
  modalOpenRef.current = shortcutsModalOpen

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const s = stateRef.current
      const a = actionsRef.current
      const p = playbackRef.current

      if (s.showExportModal || s.showSettingsModal || modalOpenRef.current) return

      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA'
      ) {
        return
      }

      const action = mapRef.current.get(normaliseKey(e.key))
      if (!action) return

      switch (action) {
        case 'playPause':
          e.preventDefault()
          if (s.isPlaying) {
            p.pause()
            a.setIsPlaying(false)
          } else {
            p.play()
            a.setIsPlaying(true)
          }
          break

        case 'frameBack':
          e.preventDefault()
          p.frameBackStep()
          break

        case 'frameForward':
          e.preventDefault()
          p.frameStep()
          break

        case 'setStart':
          if (s.selectedSegmentId) {
            a.setSelectedStart(s.playheadPosition)
          }
          break

        case 'setEnd':
          if (s.selectedSegmentId) {
            a.setSelectedEnd(s.playheadPosition)
          }
          break

        case 'deleteSegment':
          if (s.selectedSegmentId) {
            a.deleteSegment(s.selectedSegmentId)
          }
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}
