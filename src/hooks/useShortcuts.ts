import { useState, useCallback, useMemo } from 'react'

// Identifiers for each rebindable action. Keep this list aligned with the
// switch statement in useKeyboard.ts and the rows rendered by ShortcutsModal.
export type ShortcutAction =
  | 'playPause'
  | 'frameBack'
  | 'frameForward'
  | 'setStart'
  | 'setEnd'
  | 'deleteSegment'

export type ShortcutBindings = Record<ShortcutAction, string>

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  playPause:     ' ',
  frameBack:     'ArrowLeft',
  frameForward:  'ArrowRight',
  setStart:      'i',
  setEnd:        'o',
  deleteSegment: 'Delete',
}

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  playPause:     'Play / Pause',
  frameBack:     'Step one frame back',
  frameForward:  'Step one frame forward',
  setStart:      'Set selected segment start',
  setEnd:        'Set selected segment end',
  deleteSegment: 'Delete selected segment',
}

const STORAGE_KEY = 'video-trimmer-shortcuts'

/**
 * Normalise a KeyboardEvent.key for binding comparison. Letters are
 * lowercased so 'I' and 'i' both match the same binding.
 */
export function normaliseKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key
}

/** Human-readable label for a key value, used in the modal UI. */
export function formatKeyLabel(key: string): string {
  if (key === ' ') return 'Space'
  if (key.length === 1) return key.toUpperCase()
  return key
}

function loadBindings(): ShortcutBindings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SHORTCUTS }
    const parsed = JSON.parse(raw) as Partial<ShortcutBindings>
    const out: ShortcutBindings = { ...DEFAULT_SHORTCUTS }
    for (const k of Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]) {
      if (typeof parsed[k] === 'string' && parsed[k]!.length > 0) {
        out[k] = parsed[k]!
      }
    }
    return out
  } catch {
    return { ...DEFAULT_SHORTCUTS }
  }
}

function persist(b: ShortcutBindings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(b)) } catch { /* ignore */ }
}

export function useShortcuts() {
  const [bindings, setBindings] = useState<ShortcutBindings>(loadBindings)

  const setBinding = useCallback((action: ShortcutAction, key: string) => {
    setBindings(prev => {
      // Find if this key is already owned by a different action
      const displaced = (Object.keys(prev) as ShortcutAction[])
        .find(k => k !== action && normaliseKey(prev[k]) === normaliseKey(key))

      const next = { ...prev, [action]: key }
      if (displaced) {
        // Give the displaced action the key that `action` was using
        next[displaced] = prev[action]
      }
      persist(next)
      return next
    })
  }, [])

  const reset = useCallback(() => {
    setBindings({ ...DEFAULT_SHORTCUTS })
    persist(DEFAULT_SHORTCUTS)
  }, [])

  /** Reverse map: normalised key → action, for fast lookup in the keydown handler. */
  const keyToAction = useMemo(() => {
    const map = new Map<string, ShortcutAction>()
    for (const k of Object.keys(bindings) as ShortcutAction[]) {
      map.set(normaliseKey(bindings[k]), k)
    }
    return map
  }, [bindings])

  return { bindings, setBinding, reset, keyToAction }
}
