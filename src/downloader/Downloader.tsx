import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { emit } from '@tauri-apps/api/event'
import YtdlpPathModal from './YtdlpPathModal'
import type { VideoFormat, YtdlpProgress, YtdlpConfig } from '../types'

type Phase = 'idle' | 'fetching' | 'ready' | 'downloading' | 'done' | 'error'

export default function Downloader() {
  const [url, setUrl] = useState('')
  const [formats, setFormats] = useState<VideoFormat[]>([])
  const [selectedFormat, setSelectedFormat] = useState<VideoFormat | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<YtdlpProgress>({ percent: 0, speed: '', eta: '' })
  const [downloadedPath, setDownloadedPath] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [tempDir, setTempDir] = useState('')
  const [ytdlpPath, setYtdlpPath] = useState('')
  const [showPathModal, setShowPathModal] = useState(false)
  const [clearingTemp, setClearingTemp] = useState(false)

  useEffect(() => {
    invoke<YtdlpConfig>('get_ytdlp_config').then((cfg) => {
      setYtdlpPath(cfg.ytdlpPath)
      setTempDir(cfg.tempDir)
    })
  }, [])

  useEffect(() => {
    const unlisten = listen<YtdlpProgress>('ytdlp-progress', (e) => {
      setProgress(e.payload)
    })
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
    setClearingTemp(true)
    try {
      await invoke('clear_temp_dir')
      if (phase === 'done') {
        setPhase('idle')
        setDownloadedPath('')
      }
    } catch (e) {
      setErrorMsg(String(e))
    } finally {
      setClearingTemp(false)
    }
  }, [phase])

  const isDownloading = phase === 'downloading'
  const isDone = phase === 'done'

  return (
    <>
      <style>{`
        html, body, #root {
          background: #1a1a1a;
          color: #e0e0e0;
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 14px;
          margin: 0;
          height: 100%;
          user-select: none;
        }
        * { box-sizing: border-box; }
        .dl-root {
          display: flex;
          flex-direction: column;
          height: 100vh;
        }
        .dl-titlebar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 16px;
          background: #111;
          border-bottom: 1px solid #2a2a2a;
          flex-shrink: 0;
        }
        .dl-title { font-weight: 600; font-size: 14px; }
        .dl-body {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 18px;
        }
        .dl-footer {
          padding: 14px 20px;
          background: #111;
          border-top: 1px solid #2a2a2a;
          display: flex;
          flex-direction: column;
          gap: 10px;
          flex-shrink: 0;
        }
        .dl-row { display: flex; gap: 8px; align-items: center; }
        .dl-input {
          flex: 1;
          background: #2a2a2a;
          border: 1px solid #3a3a3a;
          border-radius: 6px;
          color: #e0e0e0;
          padding: 7px 10px;
          font-size: 13px;
          outline: none;
          min-width: 0;
          font-family: inherit;
        }
        .dl-input:focus { border-color: #4d9fff; }
        .dl-btn {
          background: #2a2a2a;
          border: 1px solid #3a3a3a;
          border-radius: 6px;
          color: #e0e0e0;
          padding: 7px 14px;
          cursor: pointer;
          font-size: 13px;
          white-space: nowrap;
          font-family: inherit;
        }
        .dl-btn:hover:not(:disabled) { background: #333; border-color: #444; }
        .dl-btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .dl-btn-primary {
          background: #2563eb;
          border-color: #2563eb;
          color: #fff;
        }
        .dl-btn-primary:hover:not(:disabled) { background: #1d4ed8; border-color: #1d4ed8; }
        .dl-format-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .dl-format-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 12px;
          background: #222;
          border: 1px solid #333;
          border-radius: 6px;
          cursor: pointer;
          transition: border-color 0.1s;
        }
        .dl-format-item:hover { border-color: #444; }
        .dl-format-item.selected { border-color: #4d9fff; background: #1a2a3a; }
        .dl-format-item input[type=radio] { accent-color: #4d9fff; cursor: pointer; }
        .dl-progress-bar {
          height: 6px;
          background: #2a2a2a;
          border-radius: 3px;
          overflow: hidden;
        }
        .dl-progress-fill {
          height: 100%;
          background: #2563eb;
          border-radius: 3px;
          transition: width 0.25s ease;
        }
        .dl-info-text { font-size: 12px; color: #666; line-height: 1.55; }
        .dl-error { font-size: 13px; color: #f87171; margin: 0; }
        .dl-section-label { font-size: 12px; color: #777; margin-bottom: 6px; }
        .dl-divider { border: none; border-top: 1px solid #2a2a2a; margin: 2px 0; }
      `}</style>

      <div className="dl-root">
        {/* Title bar */}
        <div className="dl-titlebar">
          <span className="dl-title">Video Downloader</span>
          <button
            className="dl-btn"
            onClick={() => setShowPathModal(true)}
            title="Set path to yt-dlp.exe"
          >
            ⚙ yt-dlp path{!ytdlpPath ? ' ⚠' : ''}
          </button>
        </div>

        <div className="dl-body">
          {/* URL input */}
          <div>
            <div className="dl-section-label">Video URL</div>
            <div className="dl-row">
              <input
                className="dl-input"
                type="url"
                placeholder="https://www.youtube.com/watch?v=…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleFetch() }}
                disabled={isDownloading}
              />
              <button
                className="dl-btn"
                onClick={handleFetch}
                disabled={!url.trim() || phase === 'fetching' || isDownloading}
              >
                {phase === 'fetching' ? 'Fetching…' : 'Fetch formats'}
              </button>
            </div>
          </div>

          {/* Format picker */}
          {formats.length > 0 && (
            <div>
              <div className="dl-section-label">Available formats</div>
              <div className="dl-format-list">
                {formats.map((f) => (
                  <label
                    key={f.formatId}
                    className={`dl-format-item${selectedFormat?.formatId === f.formatId ? ' selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="format"
                      checked={selectedFormat?.formatId === f.formatId}
                      onChange={() => setSelectedFormat(f)}
                      disabled={isDownloading}
                    />
                    <span>{f.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Progress bar */}
          {isDownloading && (
            <div>
              <div className="dl-progress-bar">
                <div className="dl-progress-fill" style={{ width: `${progress.percent}%` }} />
              </div>
              <div className="dl-info-text" style={{ marginTop: 6 }}>
                {progress.percent.toFixed(1)}%
                {progress.speed ? ` · ${progress.speed}` : ''}
                {progress.eta ? ` · ETA ${progress.eta}` : ''}
              </div>
            </div>
          )}

          {/* Done indicator */}
          {isDone && (
            <div style={{ fontSize: 13, color: '#4ade80' }}>
              ✓ Download complete
            </div>
          )}

          {/* Error */}
          {phase === 'error' && (
            <p className="dl-error">{errorMsg}</p>
          )}
        </div>

        {/* Footer */}
        <div className="dl-footer">
          <div className="dl-row" style={{ justifyContent: 'space-between' }}>
            <div className="dl-row">
              <button
                className="dl-btn dl-btn-primary"
                onClick={handleDownload}
                disabled={!selectedFormat || isDownloading || !url.trim() || !ytdlpPath}
              >
                {isDownloading ? 'Downloading…' : 'Download'}
              </button>
              <button
                className="dl-btn dl-btn-primary"
                onClick={handleLoadInEditor}
                disabled={!isDone || !downloadedPath}
              >
                Load into Editor
              </button>
            </div>
            <button
              className="dl-btn"
              onClick={handleClearTemp}
              disabled={clearingTemp}
              title={tempDir ? `Delete all files in: ${tempDir}` : 'Delete Temp folder contents'}
            >
              {clearingTemp ? 'Clearing…' : 'Delete Temp'}
            </button>
          </div>
          <hr className="dl-divider" />
          <p className="dl-info-text">
            Videos download to your <strong style={{ color: '#aaa' }}>Temp</strong> folder.
            Clean up after downloading large or many videos to save disk space.
            {tempDir && (
              <><br /><span style={{ opacity: 0.5, fontSize: 11 }}>{tempDir}</span></>
            )}
          </p>
        </div>
      </div>

      {showPathModal && (
        <YtdlpPathModal
          currentPath={ytdlpPath}
          onSave={(newPath) => setYtdlpPath(newPath)}
          onClose={() => setShowPathModal(false)}
        />
      )}
    </>
  )
}
