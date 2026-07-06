import { getCurrentWindow } from '@tauri-apps/api/window'

export function EffectsPanelApp() {
  const handleClose = () => {
    getCurrentWindow().close().catch(console.error)
  }

  return (
    <div className="effects-panel-root">
      <div className="float-panel-header" data-tauri-drag-region>
        <span data-tauri-drag-region>Effects</span>
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
        <span className="modal-label" style={{ color: 'var(--text-muted)' }}>
          No effects available yet.
        </span>
      </div>
    </div>
  )
}
