import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

type Props = {
  currentPath: string
  onSave: (newPath: string) => void
  onClose: () => void
}

export default function YtdlpPathModal({ currentPath, onSave, onClose }: Props) {
  const [path, setPath] = useState(currentPath)
  const [error, setError] = useState('')
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

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div
      onClick={handleOverlayClick}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div style={{
        background: '#1e1e1e',
        border: '1px solid #333',
        borderRadius: 10,
        width: 480,
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>yt-dlp Path</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none', border: 'none', color: '#aaa',
              fontSize: 18, cursor: 'pointer', padding: '2px 6px',
            }}
          >✕</button>
        </div>

        {/* Info banner */}
        <div style={{
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 8,
          padding: '12px 14px',
          fontSize: 13,
          lineHeight: 1.65,
          color: '#aaa',
        }}>
          <strong style={{ color: '#e0e0e0' }}>yt-dlp must be installed</strong> to download
          videos. It&apos;s recommended to keep it up to date for best site compatibility.
          <br />
          <a
            href="#"
            style={{ color: '#4d9fff', textDecoration: 'none' }}
            onClick={(e) => {
              e.preventDefault()
              invoke('plugin:opener|open_url', { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest' })
            }}
          >
            github.com/yt-dlp/yt-dlp ↗
          </a>
        </div>

        {/* Path picker */}
        <div>
          <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 6 }}>
            Path to yt-dlp.exe
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="C:\tools\yt-dlp.exe"
              style={{
                flex: 1, minWidth: 0,
                background: '#2a2a2a', border: '1px solid #3a3a3a',
                borderRadius: 6, color: '#e0e0e0',
                padding: '7px 10px', fontSize: 13, outline: 'none',
              }}
            />
            <button
              onClick={browseForExe}
              style={{
                background: '#2a2a2a', border: '1px solid #3a3a3a',
                borderRadius: 6, color: '#e0e0e0',
                padding: '7px 14px', cursor: 'pointer', fontSize: 13,
                whiteSpace: 'nowrap',
              }}
            >
              Browse…
            </button>
          </div>
        </div>

        {error && (
          <p style={{ color: '#f87171', fontSize: 13, margin: 0 }}>{error}</p>
        )}

        {/* Footer buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onClose}
            style={{
              background: '#2a2a2a', border: '1px solid #3a3a3a',
              borderRadius: 6, color: '#e0e0e0',
              padding: '7px 18px', cursor: 'pointer', fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              background: saving ? '#1a3a6a' : '#2563eb',
              border: '1px solid transparent',
              borderRadius: 6, color: '#fff',
              padding: '7px 18px', cursor: saving ? 'not-allowed' : 'pointer',
              fontSize: 13, opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
