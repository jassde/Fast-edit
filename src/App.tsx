import './App.css'
import { useRef, useCallback, useEffect, useState, useMemo } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

import { useAppState } from './hooks/useAppState'
import { useMpv } from './hooks/useMpv'
import { useFileDrop } from './hooks/useFileDrop'
import { useKeyboard } from './hooks/useKeyboard'
import { useWheelSeek } from './hooks/useWheelSeek'
import { HwSupport } from './types'

import { PlaybackControls } from './components/PlaybackControls'
import { Timeline } from './components/Timeline'
import { ExportModal } from './components/ExportModal'
import { SettingsModal } from './components/SettingsModal'

const NO_HW_SUPPORT: HwSupport = { nvenc: false, qsv: false, amf: false }

type ScrollSettingsChangePayload = { kind: 'frames' | 'seconds'; value: number }

export default function App() {
  const [state, actions] = useAppState()
  const videoPanelRef    = useRef<HTMLDivElement>(null)

  // Probe HW-encoder support once at startup. The Settings modal uses this to
  // know which vendor options to expose. Defaults to "no support" so the
  // dropdown still renders Auto + Software if the probe fails.
  const [hwSupport, setHwSupport] = useState<HwSupport>(NO_HW_SUPPORT)
  useEffect(() => {
    invoke<HwSupport>('get_hw_support')
      .then(setHwSupport)
      .catch(() => { /* fall back to NO_HW_SUPPORT — Auto + Software remain selectable */ })
  }, [])

  // mpv backend hook — pass the ref object, not .current, so useMpv reads the
  // live DOM element after mount (videoPanelRef.current is null on first render).
  const playback = useMpv(actions, videoPanelRef, state.filePath)

  // File drop onto the video panel
  const handleFileDrop = useCallback((path: string) => {
    actions.setFilePath(path)
  }, [actions])

  const isDragOver = useFileDrop(handleFileDrop)

  // Global keyboard shortcuts
  useKeyboard(state, actions, playback)

  // Global scroll-wheel seeking (works anywhere in the window, not just the timeline)
  useWheelSeek(state, actions, playback)

  // Native file picker (Open File button)
  const handleOpenFile = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Video', extensions: ['mp4', 'webm', 'mkv', 'mov'] }],
    })
    if (selected && typeof selected === 'string') {
      actions.setFilePath(selected)
    }
  }, [actions])

  // Cross-window: load a video file emitted by the downloader window.
  // Uses the aborted-flag pattern (mirrors useMpv) to handle the StrictMode
  // double-mount race where the component unmounts before listen() resolves.
  useEffect(() => {
    let aborted = false
    let unlisten: (() => void) | null = null
    listen<string>('load-video-file', (event) => {
      actions.setFilePath(event.payload)
    }).then(ul => {
      if (aborted) ul()
      else unlisten = ul
    })
    return () => {
      aborted = true
      unlisten?.()
    }
  }, [actions])

  // ── Scroll-panel window lifecycle ─────────────────────────────────────────
  // Manages a decoration-free WebviewWindow that shows the two scroll-step
  // sliders. The window opens without stealing focus (focused: false) and
  // immediately re-focuses this window on every mousedown (see ScrollPanelApp).

  // Re-emit slider values whenever they change so the panel stays in sync.
  useEffect(() => {
    if (!state.showScrollPanel) return
    emit('scroll-settings', {
      framesPerScrollTick:       state.framesPerScrollTick,
      secondsPerShiftScrollTick: state.secondsPerShiftScrollTick,
    }).catch(() => {})
  }, [state.showScrollPanel, state.framesPerScrollTick, state.secondsPerShiftScrollTick])

  // Listen for slider changes originating in the panel window.
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let aborted = false

    listen<ScrollSettingsChangePayload>('scroll-settings-change', e => {
      if (e.payload.kind === 'frames') {
        actions.setFramesPerScrollTick(e.payload.value)
      } else {
        actions.setSecondsPerShiftScrollTick(e.payload.value)
      }
    }).then(ul => {
      if (aborted) ul()
      else unlisten = ul
    })

    return () => {
      aborted = true
      unlisten?.()
    }
  }, [actions])

  // Listen for the panel's close button — the panel emits scroll-panel-close
  // to keep main state in sync.
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let aborted = false

    listen('scroll-panel-close', () => {
      actions.setShowScrollPanel(false)
    }).then(ul => {
      if (aborted) ul()
      else unlisten = ul
    })

    return () => {
      aborted = true
      unlisten?.()
    }
  }, [actions])

  // Open or close the scroll-panel window when showScrollPanel toggles.
  useEffect(() => {
    if (!state.showScrollPanel) {
      WebviewWindow.getByLabel('scroll-panel').then(win => win?.close())
      return
    }

    WebviewWindow.getByLabel('scroll-panel').then(existing => {
      if (existing) return  // already open — don't steal focus by re-opening

      const win = new WebviewWindow('scroll-panel', {
        url:           'index.html#scroll-panel',
        title:         'Scroll Step',
        decorations:   false,
        alwaysOnTop:   true,
        skipTaskbar:   true,
        focus:         false,
        width:         280,
        height:        168,
        resizable:     false,
        center:        true,
      })

      win.once('tauri://error', (e) => {
        console.error('Scroll-panel window error:', e)
      })

      // Syncs state when user closes via OS (Alt+F4). If the window was already
      // closed programmatically, the lifecycle effect's win?.close() is a no-op.
      win.once('tauri://destroyed', () => {
        actions.setShowScrollPanel(false)
      })

      // Push current values as soon as the window is ready.
      win.once('tauri://created', () => {
        emit('scroll-settings', {
          framesPerScrollTick:       state.framesPerScrollTick,
          secondsPerShiftScrollTick: state.secondsPerShiftScrollTick,
        }).catch(() => {})
      })
    })
  // framesPerScrollTick / secondsPerShiftScrollTick intentionally excluded —
  // this effect only manages window open/close. Slider sync has its own effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.showScrollPanel, actions])

  // Open the downloader as a separate Tauri window; focus it if already open
  const openDownloaderWindow = useCallback(async () => {
    const existing = await WebviewWindow.getByLabel('downloader')
    if (existing) {
      existing.setFocus()
      return
    }
    const win = new WebviewWindow('downloader', {
      url: 'index.html#downloader',
      title: 'Video Downloader',
      width: 600,
      height: 560,
      minWidth: 460,
      minHeight: 440,
      resizable: true,
      center: true,
    })
    win.once('tauri://error', (e) => {
      console.error('Downloader window error:', e)
    })
  }, [])

  // Seek: update both mpv and local playhead state
  const handleSeek = useCallback((time: number) => {
    playback.seek(time)
    actions.setPlayheadPosition(time)
  }, [playback, actions])

  // Play/pause with state sync
  const handlePlay = useCallback(() => {
    playback.play()
    actions.setIsPlaying(true)
  }, [playback, actions])

  const handlePause = useCallback(() => {
    playback.pause()
    actions.setIsPlaying(false)
  }, [playback, actions])

  // Mute toggle — set optimistically, mpv's "mute" property observation in
  // useMpv will confirm the new value (matches the play/pause pattern).
  const handleToggleMute = useCallback(() => {
    const next = !state.isMuted
    playback.setMute(next)
    actions.setIsMuted(next)
  }, [playback, actions, state.isMuted])

  // Timeline zoom — local UI state, not persisted across sessions. 1 = fit
  // entire video; higher values show a window of `duration / zoom` seconds
  // centered on the playhead.
  const [timelineZoom, setTimelineZoom] = useState<number>(1)

  // Single sorted copy shared by the segment indicator and handleSelectNext.
  const sortedSegments = useMemo(
    () => [...state.segments].sort((a, b) => a.start - b.start),
    [state.segments],
  )

  // Selected segment's 1-based position in start order + total count, for the
  // segment indicator.
  const { selectedSegmentNumber, segmentCount } = useMemo(() => {
    const idx = state.selectedSegmentId
      ? sortedSegments.findIndex(seg => seg.id === state.selectedSegmentId)
      : -1
    return {
      selectedSegmentNumber: idx >= 0 ? idx + 1 : null,
      segmentCount: sortedSegments.length,
    }
  }, [sortedSegments, state.selectedSegmentId])

  // Next ▸ : select the next segment in start order (wrap last→first; first
  // when nothing selected) AND move the playhead to its start.
  const handleSelectNext = useCallback(() => {
    if (sortedSegments.length === 0) return
    const curr = state.selectedSegmentId
      ? sortedSegments.findIndex(seg => seg.id === state.selectedSegmentId)
      : -1
    const next = sortedSegments[curr === -1 ? 0 : (curr + 1) % sortedSegments.length]
    actions.selectSegment(next.id)
    handleSeek(next.start)
  }, [sortedSegments, state.selectedSegmentId, actions, handleSeek])

  return (
    <div className="app-shell">

      {/* ── Top bar ── */}
      <div className="top-bar">
        <span className="app-title">Video Trimmer</span>
        <button className="btn btn-chrome" onClick={handleOpenFile}>
          Open File
        </button>
        <button
          className="btn btn-chrome"
          style={{ marginLeft: 'auto' }}
          onClick={openDownloaderWindow}
          title="Download video with yt-dlp"
          aria-label="Download video"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 12l-5-5h3V2h4v5h3L8 12z"/>
            <rect x="2" y="13" width="12" height="1.5" rx="0.75"/>
          </svg>
        </button>
        <button
          className="btn btn-chrome"
          onClick={actions.openSettingsModal}
          title="Settings"
        >
          Settings
        </button>
        <button
          className="btn btn-primary"
          disabled={state.segments.length === 0 || state.duration === 0}
          onClick={actions.openExportModal}
          title="Export segments (requires at least one segment)"
        >
          Export
        </button>
      </div>

      {/* ── Video panel ── */}
      {/* Transparent slot — libmpv renders behind the WebView, constrained to
          this rect by setVideoMarginRatio (see useMpv.ts). The banners below
          provide an opaque background when no file is loaded or mpv errored. */}
      <div
        className={`video-panel${isDragOver ? ' drag-over' : ''}`}
        id="video-panel"
        ref={videoPanelRef}
      >
        {state.mpvError && (
          <div className="video-banner video-banner--error">
            <span style={{ whiteSpace: 'pre-wrap' }}>{state.mpvError}</span>
          </div>
        )}
        {!state.filePath && !state.mpvError && (
          <div className="video-banner video-banner--empty">
            <span>Drop a video file here, or use Open File</span>
            <span className="hint">Supported: MP4, WebM, MKV, MOV</span>
          </div>
        )}
      </div>

      {/* ── Unified control bar (transport + segment edit/nav + zoom) ── */}
      <PlaybackControls
        currentTime={state.playheadPosition}
        duration={state.duration}
        isPlaying={state.isPlaying}
        isMuted={state.isMuted}
        onPlay={handlePlay}
        onPause={handlePause}
        onFrameStep={playback.frameStep}
        onFrameBackStep={playback.frameBackStep}
        onToggleMute={handleToggleMute}
        selectedSegmentId={state.selectedSegmentId}
        selectedSegmentNumber={selectedSegmentNumber}
        segmentCount={segmentCount}
        onSetStart={() => {
          if (state.selectedSegmentId) {
            actions.setSelectedStart(state.playheadPosition)
          }
        }}
        onSetEnd={() => {
          if (state.selectedSegmentId) {
            actions.setSelectedEnd(state.playheadPosition)
          }
        }}
        onAddSegment={actions.addSegment}
        onDeleteSegment={() => {
          if (state.selectedSegmentId) {
            actions.deleteSegment(state.selectedSegmentId)
          }
        }}
        onSelectNext={handleSelectNext}
        zoom={timelineZoom}
        onChangeZoom={setTimelineZoom}
      />

      {/* ── Timeline ── */}
      <div className="timeline-strip">
        <Timeline
          duration={state.duration}
          segments={state.segments}
          selectedSegmentId={state.selectedSegmentId}
          playheadPosition={state.playheadPosition}
          zoom={timelineZoom}
          onSeek={handleSeek}
          onSelectSegment={actions.selectSegment}
          onUpdateSegmentStart={actions.setSegmentStart}
          onUpdateSegmentEnd={actions.setSegmentEnd}
        />
      </div>

      {/* ── Export modal ── */}
      {state.showExportModal && state.filePath && (
        <ExportModal
          filePath={state.filePath}
          segments={state.segments}
          hwEncoder={state.hwEncoder}
          onClose={actions.closeExportModal}
          onExportComplete={actions.closeExportModal}
          onExportError={actions.setExportError}
        />
      )}

      {/* ── Settings modal ── */}
      {state.showSettingsModal && (
        <SettingsModal
          framesPerScrollTick={state.framesPerScrollTick}
          secondsPerShiftScrollTick={state.secondsPerShiftScrollTick}
          hwEncoder={state.hwEncoder}
          hwSupport={hwSupport}
          showScrollPanel={state.showScrollPanel}
          onChangeFrames={actions.setFramesPerScrollTick}
          onChangeSeconds={actions.setSecondsPerShiftScrollTick}
          onChangeHwEncoder={actions.setHwEncoder}
          onToggleScrollPanel={actions.setShowScrollPanel}
          onClose={actions.closeSettingsModal}
        />
      )}

    </div>
  )
}
