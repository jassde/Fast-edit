import './downloader.css'
import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { openPath } from '@tauri-apps/plugin-opener'
import type {
  MangofetchConfig,
  MangofetchInstall,
  MangofetchProgress,
  MangofetchQuality,
  MangofetchUpdate,
} from '../types'

type Phase = 'idle' | 'downloading' | 'done' | 'error'

const QUALITIES: { value: MangofetchQuality; label: string }[] = [
  { value: 'best',  label: 'Best available' },
  { value: '1080p', label: '1080p' },
  { value: '720p',  label: '720p' },
  { value: '480p',  label: '480p' },
  { value: '360p',  label: '360p' },
  { value: 'audio', label: 'Audio only (best quality)' },
]

const PHASE_LABEL: Record<MangofetchProgress['phase'], string> = {
  fetching:    'Fetching media info…',
  downloading: 'Downloading…',
  muxing:      'Finalizing…',
  done:        'Complete',
}

export default function Downloader() {
  const [url, setUrl]                     = useState('')
  const [quality, setQuality]             = useState<MangofetchQuality>('best')
  const [phase, setPhase]                 = useState<Phase>('idle')
  const [progressPhase, setProgressPhase] = useState<MangofetchProgress['phase']>('fetching')
  const [errorMsg, setErrorMsg]           = useState('')
  const [tempDir, setTempDir]             = useState('')
  const [installed, setInstalled]         = useState<boolean | null>(null)
  const [installState, setInstallState]   = useState<'idle' | 'running' | 'done' | 'cargoMissing' | 'error'>('idle')
  const [installError, setInstallError]   = useState('')
  const [updateState, setUpdateState]     = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [updateError, setUpdateError]     = useState('')
  const [clearingTemp, setClearingTemp]   = useState(false)

  // Load config on mount.
  useEffect(() => {
    invoke<MangofetchConfig>('get_mangofetch_config').then(cfg => {
      setInstalled(cfg.installed)
      setTempDir(cfg.tempDir)
    })
  }, [])

  // Listen for download progress phase changes.
  useEffect(() => {
    let aborted = false
    let unlisten: (() => void) | null = null
    listen<MangofetchProgress>('mangofetch-progress', e => setProgressPhase(e.payload.phase))
      .then(ul => { if (aborted) ul(); else unlisten = ul })
      .catch(console.error)
    return () => { aborted = true; unlisten?.() }
  }, [])

  // Listen for background-update events.
  useEffect(() => {
    let aborted = false
    let unlisten: (() => void) | null = null
    listen<MangofetchUpdate>('mangofetch-update', e => {
      setUpdateState(e.payload.phase)
      if (e.payload.phase === 'error') setUpdateError(e.payload.message)
      else setUpdateError('')
    })
      .then(ul => { if (aborted) ul(); else unlisten = ul })
      .catch(console.error)
    return () => { aborted = true; unlisten?.() }
  }, [])

  // Listen for install events.
  useEffect(() => {
    let aborted = false
    let unlisten: (() => void) | null = null
    listen<MangofetchInstall>('mangofetch-install', e => {
      setInstallState(e.payload.phase)
      if (e.payload.phase === 'error') setInstallError(e.payload.message)
      else if (e.payload.phase !== 'cargoMissing') setInstallError('')
      // When install reports done, refresh config so `installed` flips to true
      // and the `update` effect below fires.
      if (e.payload.phase === 'done') {
        invoke<MangofetchConfig>('get_mangofetch_config').then(cfg => {
          setInstalled(cfg.installed)
          setTempDir(cfg.tempDir)
        })
      }
    })
      .then(ul => { if (aborted) ul(); else unlisten = ul })
      .catch(console.error)
    return () => { aborted = true; unlisten?.() }
  }, [])

  // Auto-install if missing. The Rust side gates on cargo presence and emits
  // `cargoMissing` if rustup isn't there — in which case we don't retry.
  useEffect(() => {
    if (installed === false && installState === 'idle') {
      invoke('install_mangofetch').catch(e => {
        // Phase events already update state; ignore the rejection unless the
        // event listener missed it (defensive — shouldn't happen).
        const msg = String(e)
        if (msg.includes('cargo) is not installed')) {
          setInstallState('cargoMissing')
        } else {
          setInstallState('error')
          setInstallError(msg)
        }
      })
    }
  }, [installed, installState])

  // Fire `mangofetch update` once installed (background, non-blocking).
  useEffect(() => {
    if (installed === true) {
      invoke('update_mangofetch').catch(e => {
        setUpdateState('error')
        setUpdateError(String(e))
      })
    }
  }, [installed])

  const handleDownload = useCallback(async () => {
    if (!url.trim()) return
    setPhase('downloading')
    setProgressPhase('fetching')
    setErrorMsg('')
    try {
      await invoke<string>('download_video', {
        url,
        quality,
        audioOnly: quality === 'audio',
      })
      setPhase('done')
    } catch (e) {
      setErrorMsg(String(e))
      setPhase('error')
    }
  }, [url, quality])

  const handleOpenTempFolder = useCallback(async () => {
    if (!tempDir) return
    try {
      await openPath(tempDir)
      setErrorMsg('')
    } catch (e) {
      setErrorMsg(`Could not open folder: ${e}`)
    }
  }, [tempDir])

  const handleClearTemp = useCallback(async () => {
    const ok = window.confirm(
      'Delete all files in the Temp folder?\n\nThis cannot be undone.'
    )
    if (!ok) return
    setClearingTemp(true)
    try {
      await invoke('clear_temp_dir')
      if (phase === 'done') setPhase('idle')
    } catch (e) {
      setErrorMsg(String(e))
    } finally {
      setClearingTemp(false)
    }
  }, [phase])

  const isDownloading = phase === 'downloading'
  const isDone        = phase === 'done'
  const isMissing     = installed === false
  const isInstalling  = installState === 'running'
  const formLocked    = isDownloading || isMissing || isInstalling

  const downloadDisabled = formLocked || !url.trim()
  let downloadTitle = ''
  if (isInstalling)         downloadTitle = 'Installing mangofetch…'
  else if (isMissing)       downloadTitle = 'mangofetch is not installed'
  else if (!url.trim())     downloadTitle = 'Enter a video URL'
  else if (isDownloading)   downloadTitle = 'Download in progress'

  return (
    <div className="dl-window">

      {/* Title bar */}
      <div className="top-bar">
        <span className="app-title">🥭 Video Downloader</span>
        {isInstalling && (
          <span className="dl-update-chip" style={{ marginLeft: 'auto' }}>
            Installing mangofetch…
          </span>
        )}
        {!isInstalling && updateState === 'running' && (
          <span className="dl-update-chip" style={{ marginLeft: 'auto' }}>
            Updating tools…
          </span>
        )}
        {!isInstalling && updateState === 'done' && (
          <span className="dl-update-chip dl-update-chip-ok" style={{ marginLeft: 'auto' }}>
            Tools up to date
          </span>
        )}
        {!isInstalling && updateState === 'error' && (
          <span
            className="dl-update-chip dl-update-chip-err"
            style={{ marginLeft: 'auto' }}
            title={updateError}
          >
            Update failed
          </span>
        )}
      </div>

      {/* Body */}
      <div className="dl-body">

        {/* Install status — shown while cargo install is running, on errors, and
            when the Rust toolchain itself is missing. */}
        {isInstalling && (
          <div className="warning-banner">
            ⏳ Installing <strong>mangofetch</strong> via <code>cargo install</code>.
            First-time setup compiles from source and can take several minutes.
          </div>
        )}
        {installState === 'cargoMissing' && (
          <div className="warning-banner">
            ⚠️ <strong>Rust (cargo) is not installed.</strong>{' '}
            Install it from{' '}
            <a
              href="https://rustup.rs/"
              onClick={e => { e.preventDefault(); openPath('https://rustup.rs/').catch(() => {}) }}
            >
              rustup.rs
            </a>
            , then restart the app — mangofetch will be installed automatically.
          </div>
        )}
        {installState === 'error' && (
          <div className="warning-banner">
            ❌ Could not install mangofetch.{' '}
            <button
              className="btn btn-link"
              onClick={() => { setInstallState('idle'); /* triggers re-install effect */ }}
            >
              Try again
            </button>
            {installError && <div className="modal-error" style={{ marginTop: 6 }}>{installError}</div>}
          </div>
        )}

        {/* URL field */}
        <div className="modal-field">
          <span className="modal-label">Video URL</span>
          <input
            className="modal-input"
            type="url"
            placeholder="https://www.youtube.com/watch?v=…"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !downloadDisabled) handleDownload() }}
            disabled={formLocked}
          />
        </div>

        {/* Quality picker */}
        <div className="modal-field">
          <span className="modal-label">Quality</span>
          <select
            className="modal-input"
            value={quality}
            onChange={e => setQuality(e.target.value as MangofetchQuality)}
            disabled={formLocked}
          >
            {QUALITIES.map(q => (
              <option key={q.value} value={q.value}>{q.label}</option>
            ))}
          </select>
        </div>

        {/* Download progress — indeterminate; mangofetch CLI doesn't expose
            per-chunk percent so we show a striped bar + phase label. */}
        {isDownloading && (
          <div className="modal-field">
            <div className="progress-bar-track">
              <div className="progress-bar-fill progress-bar-indeterminate" />
            </div>
            <div className="dl-progress-meta">
              <span>📥 {PHASE_LABEL[progressPhase]}</span>
            </div>
          </div>
        )}

        {isDone && <div className="dl-done">✅ Download complete.</div>}

        {errorMsg && <div className="modal-error">{errorMsg}</div>}

      </div>

      {/* Footer */}
      <div className="dl-footer">
        <div className="dl-footer-actions">
          <div className="dl-footer-actions-left">
            <button
              className="btn btn-primary"
              onClick={handleDownload}
              disabled={downloadDisabled}
              title={downloadTitle}
            >
              {isDownloading ? 'Downloading…' : 'Download'}
            </button>
            <button
              className="btn"
              onClick={handleOpenTempFolder}
              disabled={!tempDir}
              title={tempDir ? `Open: ${tempDir}` : 'No temp folder set'}
            >
              📁 Open Temp Folder
            </button>
          </div>
          <button
            className="btn btn-danger"
            onClick={handleClearTemp}
            disabled={clearingTemp}
            title={tempDir ? `Delete all files in: ${tempDir}` : 'Delete temporary files'}
          >
            {clearingTemp ? 'Clearing…' : '🗑 Delete Temp'}
          </button>
        </div>
      </div>

    </div>
  )
}
