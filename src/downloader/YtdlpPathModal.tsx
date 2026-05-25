import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'

type Props = {
  currentPath: string
  onSave: (newPath: string) => void
  onClose: () => void
}

export default function YtdlpPathModal({ currentPath, onSave, onClose }: Props) {
  const [path, setPath]     = useState(currentPath)
  const [error, setError]   = useState('')
  const [saving, setSaving] = useState(false)

  async function browseForExe() {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: 'Executable', extensions: ['exe'] }],
      title: 'Select yt-dlp.exe',
    })
    if (typeof selected === 'string') setPath(selected)
  }

  async function handleSave() {
    if (!path.trim()) { setError('Please select a path first.'); return }
    setSaving(true)
    setError('')
    try {
      await invoke('save_ytdlp_path', { path })
      onSave(path)
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="yt-dlp Path">

        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="modal-title">yt-dlp Path</div>
          <button
            className="btn btn-chrome btn-icon"
            onClick={onClose}
            aria-label="Close"
            style={{ fontSize: 16, lineHeight: 1 }}
          >
            ✕
          </button>
        </div>

        {/* Info box */}
        <div className="dl-info-box">
          <strong>yt-dlp must be installed</strong> to download videos.
          Keep it up to date for best site compatibility.
          {' '}
          <a
            href="#"
            onClick={e => { e.preventDefault(); openUrl('https://github.com/yt-dlp/yt-dlp/releases/latest') }}
          >
            github.com/yt-dlp/yt-dlp ↗
          </a>
        </div>

        {/* Path field */}
        <div className="modal-field">
          <span className="modal-label">Path to yt-dlp.exe</span>
          <div className="modal-row">
            <input
              className="modal-input"
              type="text"
              value={path}
              onChange={e => setPath(e.target.value)}
              placeholder="C:\tools\yt-dlp.exe"
              style={{ flex: 1, minWidth: 0 }}
            />
            <button className="btn" onClick={browseForExe}>Browse…</button>
          </div>
        </div>

        {/* Error */}
        {error && <div className="modal-error">{error}</div>}

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

      </div>
    </div>
  )
}
