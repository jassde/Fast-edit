import { useEffect, useState } from 'react'
import {
  ShortcutAction,
  ShortcutBindings,
  SHORTCUT_LABELS,
  formatKeyLabel,
} from '../hooks/useShortcuts'

type ShortcutsModalProps = {
  bindings:    ShortcutBindings
  onRebind:    (action: ShortcutAction, key: string) => void
  onReset:     () => void
  onClose:     () => void
}

const ORDER: ShortcutAction[] = [
  'playPause',
  'frameBack',
  'frameForward',
  'setStart',
  'setEnd',
  'deleteSegment',
]

// Keys we refuse to bind because they'd trap the user or are modifier-only.
const FORBIDDEN_KEYS = new Set(['Escape', 'Tab', 'Shift', 'Control', 'Alt', 'Meta'])

export function ShortcutsModal({ bindings, onRebind, onReset, onClose }: ShortcutsModalProps) {
  // While `capturing` is non-null we intercept the next keydown as the new
  // binding for that action. Escape cancels capture (and otherwise closes).
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (capturing) {
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Escape') {
          setCapturing(null)
          return
        }
        if (FORBIDDEN_KEYS.has(e.key)) return
        onRebind(capturing, e.key)
        setCapturing(null)
        return
      }
      if (e.key === 'Escape') onClose()
    }
    // Capture phase so we beat the global useKeyboard handler — though that
    // handler is already gated on showShortcutsModal, this also protects the
    // forbidden-key check from leaking through.
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [capturing, onRebind, onClose])

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">

        <div className="modal-title">Keyboard Shortcuts</div>

        <div className="modal-field">
          <span className="modal-hint">
            Click a key to rebind it. Press Escape to cancel capture.
          </span>
        </div>

        <table className="shortcuts-table">
          <tbody>
            {ORDER.map(action => (
              <tr key={action}>
                <td className="shortcuts-label">{SHORTCUT_LABELS[action]}</td>
                <td className="shortcuts-key-cell">
                  <button
                    className={`shortcuts-key-btn${capturing === action ? ' capturing' : ''}`}
                    onClick={() => setCapturing(action)}
                  >
                    {capturing === action ? 'Press a key…' : formatKeyLabel(bindings[action])}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="modal-footer">
          <button className="btn" onClick={onReset}>Reset defaults</button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

      </div>
    </div>
  )
}
