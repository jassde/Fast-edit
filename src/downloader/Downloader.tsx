import './downloader.css'
import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { emit } from '@tauri-apps/api/event'
import YtdlpPathModal from './YtdlpPathModal'
import type { VideoFormat, YtdlpProgress, YtdlpConfig } from '../types'

type Phase = 'idle' | 'fetching' | 'ready' | 'downloading' | 'done' | 'error'

export default function Downloader() {
  const [url, setUrl]                     = useState('')
  const [formats, setFormats]             = useState<VideoFormat[]>([])
  const [selectedFormat, setSelectedFormat] = useState<VideoFormat | null>(null)
  const [phase, setPhase]                 = useState<Phase>('idle')
  const [progress, setProgress]           = useState<YtdlpProgress>({ percent: 0, speed: '', eta: '' })
  const [downloadedPath, setDownloadedPath] = useState('')
  const [errorMsg, setErrorMsg]           = useState('')
  const [tempDir, setTempDir]             = useState('')
  const [ytdlpPath, setYtdlpPath]         = useState('')
  const [showPathModal, setShowPathModal] = useState(false)
  const [clearingTemp, setClearingTemp]   = useState(false)

  useEffect(() => {
    invoke<YtdlpConfig>('get_ytdlp_config').then(cfg => {
      setYtdlpPath(cfg.ytdlpPath)
      setTempDir(cfg.tempDir)
    })
  }, [])

  useEffect(() => {
    const unlisten = listen<YtdlpProgress>('ytdlp-progress', e => setProgress(e.payload))
    return () => { unlisten.then(fn => fn()) }
  }, [])

  const handleFetch = useCallback(async () => {
    if (!url.trim()) return
    setPhase('fetching')
    setErrorMsg('')
    setFormats([])
    setSelectedFormat(null)
    setDownloadedPath('')
    try {
      const result = await invoke<VideoFormat[]>('fetch_formats', { url })
      setFormats(result)
      setSelectedFormat(result[0] ?? null)
      setPhase('ready')
    } catch (e) {
      setErrorMsg(String(e))
      setPhase('error')
    }
  }, [url])

  const handleDownload = useCallback(async () => {
    if (!selectedFormat) return
    setPhase('downloading')
    setProgress({ percent: 0, speed: '', eta: '' })
    setErrorMsg('')
    try {
      const path = await invoke<string>('download_video', {
        url,
        formatSelector: selectedFormat.ytdlpSelector,
      })
      setDownloadedPath(path)
      setPhase('done')
    } catch (e) {
      setErrorMsg(String(e))
      setPhase('error')
    }
  }, [selectedFormat, url])

  const handleLoadInEditor = useCallback(async () => {
    if (!downloadedPath) return
    await emit('load-video-file', downloadedPath)
    await invoke('focus_main_window')
  }, [downloadedPath])

  const handleClearTemp = useCallback(async () => {
    // Confirm before deleting — destructive and irreversible. If the user just
    // downloaded a file and hasn't loaded it into the editor yet, this nukes it.
    const ok = window.confirm(
      'Delete all files in the Temp folder?\n\nThis cannot be undone.'
    )
    if (!ok) return
    setClearingTemp(true)
    try {
      await invoke('clear_temp_dir')
      if (phase === 'done') { setPhase('idle'); setDownloadedPath('') }
    } catch (e) {
      setErrorMsg(String(e))
    } finally {
      setClearingTemp(false)
    }
  }, [phase])

  const isDownloading = phase === 'downloading'
  const isDone        = phase === 'done'
  const isFetching    = phase === 'fetching'
  const isYtdlpMissing = !ytdlpPath

  const downloadDisabled = !selectedFormat || isDownloading || !url.trim() || isYtdlpMissing

  let downloadTitle = ''
  if (isYtdlpMissing) downloadTitle = 'yt-dlp path not configured — click "yt-dlp Path" button above'
  else if (!selectedFormat) downloadTitle = 'Select a video format first'
  else if (!url.trim()) downloadTitle = 'Enter a video URL'
  else if (isDownloading) downloadTitle = 'Download in progress'

  const pathBtnClass = isYtdlpMissing ? 'btn btn-danger' : 'btn btn-chrome'

  return (
    <div className="dl-window">

      {/* Title bar */}
      <div className="top-bar">
        <span className="app-title">🎬 Video Downloader</span>
        <button
          className={pathBtnClass}
          style={{ marginLeft: 'auto' }}
          onClick={() => setShowPathModal(true)}
          title={ytdlpPath ? `yt-dlp: ${ytdlpPath}` : '⚠️ yt-dlp is missing — set path to enable downloads'}
        >
          yt-dlp Path{isYtdlpMissing ? ' ⚠️' : ''}
        </button>
      </div>

      {/* Body */}
      <div className="dl-body">

        {/* URL field */}
        <div className="modal-field">
          <span className="modal-label">Video URL</span>
          <div className="dl-url-row">
            <input
              className="modal-input"
              type="url"
              placeholder="https://www.youtube.com/watch?v=…"
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleFetch() }}
              disabled={isDownloading}
            />
            <button
              className="btn"
              onClick={handleFetch}
              disabled={!url.trim() || isFetching || isDownloading}
            >
              {isFetching ? 'Fetching…' : 'Fetch formats'}
            </button>
          </div>
        </div>

        {/* Missing yt-dlp warning banner */}
        {isYtdlpMissing && phase !== 'downloading' && (
          <div className="warning-banner">
            ⚠️ yt-dlp is not configured. Click the <strong>“yt-dlp Path”</strong> button above to select the executable.
          </div>
        )}

        {/* Format picker */}
        {formats.length > 0 && (
          <div className="modal-field">
            <span className="modal-label">Available formats</span>
            <div className="dl-format-list">
              {formats.map(f => (
                <label
                  key={f.formatId}
                  className={`dl-format-option${selectedFormat?.formatId === f.formatId ? ' is-selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="format"
                    checked={selectedFormat?.formatId === f.formatId}
                    onChange={() => setSelectedFormat(f)}
                    disabled={isDownloading}
                  />
                  {f.label}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Download progress */}
        {isDownloading && (
          <div className="modal-field">
            <div className="progress-bar-track">
              <div className="progress-bar-fill" style={{ width: `${progress.percent}%` }} />
            </div>
            <div className="dl-progress-meta">
              <span>📥 Downloading…</span>
              <span>
                {progress.percent.toFixed(1)}%
                {progress.speed && ` · ${progress.speed}`}
                {progress.eta   && ` · ETA ${progress.eta}`}
              </span>
            </div>
          </div>
        )}

        {/* Done state */}
        {isDone && (
          <div className="dl-done">
            ✅ Download complete — ready to load into editor.
          </div>
        )}

        {/* Error message */}
        {phase === 'error' && (
          <div className="modal-error">{errorMsg}</div>
        )}

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
              onClick={handleLoadInEditor}
              disabled={!isDone || !downloadedPath}
              title={!isDone ? 'Complete a download first' : 'Load into main editor'}
            >
              Load into Editor
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

        <div className="dl-footer-hint">
          <span className="modal-hint">
            Videos download to the <strong>Temp</strong> folder. Clean up regularly to save space.
            {tempDir && (
              <div className="temp-path">
                📁 {tempDir}
              </div>
            )}
          </span>
        </div>
      </div>

      {showPathModal && (
        <YtdlpPathModal
          currentPath={ytdlpPath}
          onSave={newPath => setYtdlpPath(newPath)}
          onClose={() => setShowPathModal(false)}
        />
      )}

    </div>
  )
}