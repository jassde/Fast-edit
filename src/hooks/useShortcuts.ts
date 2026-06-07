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
  | 'undo'
  | 'redo'

export type ShortcutBindings = Record<ShortcutAction, string>

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  playPause:     ' ',
  frameBack:     'ArrowLeft',
  frameForward:  'ArrowRight',
  setStart:      'i',
  setEnd:        'o',
  deleteSegment: 'Delete',
  undo:          'ctrl+z',
  redo:          'ctrl+shift+z',
}

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  playPause:     'Play / Pause',
  frameBack:     'Step one frame back',
  frameForward:  'Step one frame forward',
  setStart:      'Set selected segment start',
  setEnd:        'Set selected segment end',
  deleteSegment: 'Delete selected segment',
  undo:          'Undo last action',
  redo:          'Redo last undone action',
}

const STORAGE_KEY = 'video-trimmer-shortcuts'

/**
 * Normalise a KeyboardEvent.key for binding comparison. Letters are
 * lowercased so 'I' and 'i' both match the same binding. Named keys
 * (Delete, ArrowLeft, …) pass through unchanged.
 */
export function normaliseKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key
}

type KeyEventLike = {
  ctrlKey:  boolean
  shiftKey: boolean
  altKey:   boolean
  metaKey:  boolean
  key:      string
}

/**
 * Build the canonical Combo string for a KeyboardEvent. Format is
 * `<modifiers>+<key>` with modifiers always in fixed order ctrl→shift→alt→meta
 * and a normalised key. A bare keypress emits just the normalised key.
 *
 * Modifier-only events (e.key === 'Control'/'Shift'/'Alt'/'Meta') return the
 * key itself, since they cannot form a complete Combo on their own.
 */
export function normaliseCombo(e: KeyEventLike): string {
  if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') {
    return e.key
  }
  const parts: string[] = []
  if (e.ctrlKey)  parts.push('ctrl')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey)   parts.push('alt')
  if (e.metaKey)  parts.push('meta')
  parts.push(normaliseKey(e.key))
  return parts.join('+')
}

const MOD_LABELS: Record<string, string> = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: 'Meta' }

/** Human-readable label for a stored Combo, used in the modal UI. */
export function formatKeyLabel(key: string): string {
  if (key === ' ') return 'Space'
  // Detect combos by a modifier prefix rather than the bare presence of '+',
  // so the literal '+' key (and combos whose key portion is '+') render
  // correctly. The trailing `(.+)` captures the key portion in one piece —
  // splitting on every '+' would shred 'shift++' into junk.
  const m = key.match(/^((?:(?:ctrl|shift|alt|meta)\+)+)(.+)$/)
  if (m) {
    const mods = m[1].split('+').filter(Boolean).map(mod => MOD_LABELS[mod] ?? mod)
    const k    = m[2]
    const kLabel = k === ' ' ? 'Space' : (k.length === 1 ? k.toUpperCase() : k)
    return [...mods, kLabel].join(' + ')
  }
  if (key.length === 1) return key.toUpperCase()
  return key
}

/**
 * Canonicalise an arbitrary binding string into the form the rest of this
 * module expects: lowercase modifiers, normalised key portion. Used at the
 * two boundaries where bindings enter the system (loadBindings, setBinding)
 * so the lookup map and collision check can do plain string equality.
 */
function canonicaliseBinding(b: string): string {
  // Bare key (no combo separator) → just normalise the key.
  // Note: a literal '+' bound as the key has no modifier prefix; it falls
  // through the regex below and is handled here.
  const comboMatch = b.match(/^((?:(?:ctrl|shift|alt|meta)\+)+)(.+)$/i)
  if (!comboMatch) return normaliseKey(b)
  const mods = comboMatch[1].split('+').filter(Boolean).map(m => m.toLowerCase())
  return [...mods, normaliseKey(comboMatch[2])].join('+')
}

function loadBindings(): ShortcutBindings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SHORTCUTS }
    const parsed = JSON.parse(raw) as Partial<ShortcutBindings>
    const out: ShortcutBindings = { ...DEFAULT_SHORTCUTS }
    for (const k of Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]) {
      if (typeof parsed[k] === 'string' && parsed[k]!.length > 0) {
        out[k] = canonicaliseBinding(parsed[k]!)
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

  const setBinding = useCallback((action: ShortcutAction, rawKey: string) => {
    // Canonicalise at the boundary so the rest of the module can rely on
    // stored bindings being in normal form.
    const key = canonicaliseBinding(rawKey)
    setBindings(prev => {
      // Find if this key is already owned by a different action
      const displaced = (Object.keys(prev) as ShortcutAction[])
        .find(k => k !== action && prev[k] === key)

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

  /** Reverse map: canonical binding string → action, for fast lookup in the keydown handler. */
  const keyToAction = useMemo(() => {
    const map = new Map<string, ShortcutAction>()
    for (const k of Object.keys(bindings) as ShortcutAction[]) {
      map.set(bindings[k], k)
    }
    return map
  }, [bindings])

  return { bindings, setBinding, reset, keyToAction }
}
