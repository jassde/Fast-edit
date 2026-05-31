import './downloader.css'
import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { openPath } from '@tauri-apps/plugin-opener'
import YtdlpPathModal from './YtdlpPathModal'
import type { VideoFormat, YtdlpProgress, YtdlpConfig, CookieSource } from '../types'

type Phase = 'idle' | 'fetching' | 'ready' | 'downloading' | 'done' | 'error'

export default function Downloader() {
  const [url, setUrl]                     = useState('')
  const [formats, setFormats]             = useState<VideoFormat[]>([])
  const [selectedFormat, setSelectedFormat] = useState<VideoFormat | null>(null)
  const [phase, setPhase]                 = useState<Phase>('idle')
  const [progress, setProgress]           = useState<YtdlpProgress>({ percent: 0, speed: '', eta: '' })
  const [errorMsg, setErrorMsg]           = useState('')
  const [tempDir, setTempDir]             = useState('')
  const [ytdlpPath, setYtdlpPath]         = useState('')
  const [showPathModal, setShowPathModal] = useState(false)
  const [clearingTemp, setClearingTemp]   = useState(false)
  const [cookieSource, setCookieSource]   = useState<CookieSource>({ type: 'none' })
  const [savingCookies, setSavingCookies] = useState(false)
  const [tempDirInput, setTempDirInput]   = useState('')
  const [savingTempPath, setSavingTempPath] = useState(false)

  useEffect(() => {
    invoke<YtdlpConfig>('get_ytdlp_config').then(cfg => {
      setYtdlpPath(cfg.ytdlpPath)
      setTempDir(cfg.tempDir)
      setTempDirInput(cfg.tempDir)
      setCookieSource(cfg.cookieSource)
    })
  }, [])

  useEffect(() => {
    let aborted = false
    let unlisten: (() => void) | null = null
    listen<YtdlpProgress>('ytdlp-progress', e => setProgress(e.payload))
      .then(ul => {
        if (aborted) ul()
        else unlisten = ul
      })
      .catch(console.error)
    return () => {
      aborted = true
      unlisten?.()
    }
  }, [])

  const handleFetch = useCallback(async () => {
    if (!url.trim()) return
    setPhase('fetching')
    setErrorMsg('')
    setFormats([])
    setSelectedFormat(null)
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
      await invoke<string>('download_video', {
        url,
        formatSelector: selectedFormat.ytdlpSelector,
      })
      setPhase('done')
    } catch (e) {
      setErrorMsg(String(e))
      setPhase('error')
    }
  }, [selectedFormat, url])

  const handleCookieSave = useCallback(async (source: CookieSource) => {
    setSavingCookies(true)
    try {
      await invoke('save_cookie_settings', { cookieSource: source })
      setCookieSource(source)
      setErrorMsg('')
    } catch (e) {
      setErrorMsg(String(e))
    } finally {
      setSavingCookies(false)
    }
  }, [])

  const browseCookieFile = useCallback(async () => {
    const selected = await open({ multiple: false, filters: [{ name: 'Cookie file', extensions: ['txt'] }] })
    if (typeof selected === 'string') {
      await handleCookieSave({ type: 'file', path: selected })
    }
  }, [handleCookieSave])

  const handleOpenTempFolder = useCallback(async () => {
    if (!tempDir) return
    try {
      await openPath(tempDir)
      setErrorMsg('')
    } catch (e) {
      setErrorMsg(`Could not open folder: ${e}`)
    }
  }, [tempDir])

  const handleBrowseTempDir = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false })
    if (typeof selected === 'string') setTempDirInput(selected)
  }, [])

  const handleSaveTempDir = useCallback(async () => {
    setSavingTempPath(true)
    try {
      const canonical = await invoke<string>('save_temp_dir', { path: tempDirInput })
      setTempDir(canonical)
      setTempDirInput(canonical)
      setErrorMsg('')
    } catch (e) {
      setErrorMsg(String(e))
    } finally {
      setSavingTempPath(false)
    }
  }, [tempDirInput])

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
      if (phase === 'done') setPhase('idle')
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

        {/* Cookie source */}
        <div className="modal-field">
          <span className="modal-label">Cookie source</span>
          <div className="dl-cookie-options">
            <label className="dl-cookie-radio">
              <input
                type="radio" name="cookie-source"
                checked={cookieSource.type === 'none'}
                onChange={() => handleCookieSave({ type: 'none' })}
                disabled={isDownloading}
              />
              None
            </label>

            <label className="dl-cookie-radio">
              <input
                type="radio" name="cookie-source"
                checked={cookieSource.type === 'browser'}
                onChange={() => handleCookieSave({ type: 'browser', browser: 'chrome', profile: '' })}
                disabled={isDownloading}
              />
              Browser
            </label>
            {cookieSource.type === 'browser' && (
              <div className="dl-cookie-browser-row">
                <select
                  className="dl-cookie-select"
                  value={cookieSource.browser}
                  onChange={e => handleCookieSave({ type: 'browser', browser: e.target.value, profile: cookieSource.profile })}
                  disabled={isDownloading}
                >
                  <option value="chrome">Chrome</option>
                  <option value="firefox">Firefox</option>
                  <option value="edge">Edge</option>
                  <option value="brave">Brave</option>
                  <option value="opera">Opera</option>
                  <option value="chromium">Chromium</option>
                </select>
                <input
                  className="modal-input dl-cookie-profile"
                  type="text"
                  placeholder="Profile name (optional)"
                  value={cookieSource.profile}
                  onChange={e => {
                    if (cookieSource.type === 'browser')
                      setCookieSource({ ...cookieSource, profile: e.target.value })
                  }}
                  onBlur={() => {
                    if (cookieSource.type === 'browser') handleCookieSave(cookieSource)
                  }}
                  disabled={isDownloading}
                />
              </div>
            )}

            <label className="dl-cookie-radio">
              <input
                type="radio" name="cookie-source"
                checked={cookieSource.type === 'file'}
                onChange={() => handleCookieSave({ type: 'file', path: '' })}
                disabled={isDownloading}
              />
              Cookie file
            </label>
            {cookieSource.type === 'file' && (
              <div className="dl-cookie-file-row">
                <input
                  className="modal-input" type="text"
                  value={cookieSource.path}
                  placeholder="C:\path\to\cookies.txt"
                  onChange={e => setCookieSource({ type: 'file', path: e.target.value })}
                  onBlur={() => { if (cookieSource.type === 'file') handleCookieSave(cookieSource) }}
                  disabled={isDownloading}
                />
                <button className="btn" onClick={browseCookieFile} disabled={isDownloading}>
                  Browse…
                </button>
              </div>
            )}
          </div>
          {savingCookies && <span className="dl-cookie-saving">Saving…</span>}
        </div>

        {/* Missing yt-dlp warning banner */}
        {isYtdlpMissing && phase !== 'downloading' && (
          <div className="warning-banner">
            ⚠️ yt-dlp is not configured. Click the <strong>“yt-dlp Path”</strong> button above to select the executable.
          </div>
        )}

        {/* Format picker table */}
        {formats.length > 0 && (
          <div className="modal-field">
            <span className="modal-label">Available formats</span>
            <div className="dl-format-table-wrap">
              <table className="dl-format-table">
                <thead>
                  <tr>
                    <th className="dl-fmt-check"></th>
                    <th>Resolution</th>
                    <th>FPS</th>
                    <th>Codec</th>
                    <th>Size</th>
                    <th>Ext</th>
                    <th>DR</th>
                  </tr>
                </thead>
                <tbody>
                  {formats.map(f => {
                    const isSelected = selectedFormat?.formatId === f.formatId
                    const isSpecial  = !f.resolution  // Best available / Audio only rows
                    return (
                      <tr
                        key={f.formatId}
                        className={`dl-fmt-row${isSelected ? ' is-selected' : ''}${isDownloading ? ' is-disabled' : ''}`}
                        onClick={() => { if (!isDownloading) setSelectedFormat(f) }}
                        title={f.label}
                      >
                        <td className="dl-fmt-check">{isSelected ? '✓' : ''}</td>
                        {isSpecial ? (
                          <td className="dl-fmt-special" colSpan={6}>{f.label}</td>
                        ) : (
                          <>
                            <td>{f.resolution}</td>
                            <td>{f.fps}</td>
                            <td>{f.codec}</td>
                            <td className="dl-fmt-size">{f.filesize}</td>
                            <td className="dl-fmt-muted">{f.ext}</td>
                            <td className="dl-fmt-muted">{f.dynamicRange !== 'SDR' ? f.dynamicRange : ''}</td>
                          </>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
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
            ✅ Download complete.
          </div>
        )}

        {/* Error message — shown whenever set, not gated on phase, so settings
            save failures (temp dir, cookies) surface to the user too. */}
        {errorMsg && (
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

        <div className="dl-footer-hint">
          <span className="dl-temp-label">Temp folder</span>
          <div className="dl-temp-path-row">
            <input
              className="modal-input dl-temp-input"
              type="text"
              value={tempDirInput}
              onChange={e => setTempDirInput(e.target.value)}
              placeholder="C:\path\to\temp"
              disabled={isDownloading}
            />
            <button className="btn" onClick={handleBrowseTempDir} disabled={isDownloading}>
              Browse…
            </button>
            <button
              className="btn"
              onClick={handleSaveTempDir}
              disabled={isDownloading || savingTempPath || tempDirInput === tempDir}
            >
              {savingTempPath ? 'Saving…' : 'Save'}
            </button>
          </div>
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