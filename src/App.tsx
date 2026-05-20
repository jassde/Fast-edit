import './App.css'
import { useRef, useCallback, useEffect, useState, useMemo } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { useAppState } from './hooks/useAppState'
import { useMpv } from './hooks/useMpv'
import { useFileDrop } from './hooks/useFileDrop'
import { useKeyboard } from './hooks/useKeyboard'
import { HwSupport, ContextMenuScope, ContextMenuStatus } from './types'

import { PlaybackControls } from './components/PlaybackControls'
import { Timeline } from './components/Timeline'
import { ExportModal } from './components/ExportModal'
import { SettingsModal } from './components/SettingsModal'

const NO_HW_SUPPORT: HwSupport = { nvenc: false, qsv: false, amf: false }

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

  // Initial-launch file (Explorer "Edit with..." on a closed app) + subsequent
  // launches routed through the single-instance plugin's "launch-file" event.
  // The `aborted` flag handles the unmount-before-subscribe race: if listen()
  // resolves after cleanup, we immediately invoke the unsubscribe instead of
  // leaking the subscription. Same pattern used in ExportModal.tsx.
  useEffect(() => {
    let aborted = false
    let unlisten: (() => void) | null = null

    invoke<string | null>('take_launch_file')
      .then(path => { if (path && !aborted) actions.setFilePath(path) })
      .catch(() => { /* command unavailable — ignore */ })

    listen<string>('launch-file', e => {
      if (e.payload) actions.setFilePath(e.payload)
    }).then(fn => {
      if (aborted) fn()
      else unlisten = fn
    })

    return () => {
      aborted = true
      unlisten?.()
    }
  }, [actions])

  // Context-menu registration state for the Settings modal toggles, separate
  // booleans for each scope. `null` = still loading (buttons disabled).
  // Refresh after each toggle so the labels flip to match reality.
  const [contextMenuStatus, setContextMenuStatus] = useState<ContextMenuStatus | null>(null)

  const refreshContextMenuStatus = useCallback(() => {
    invoke<ContextMenuStatus>('context_menu_status')
      .then(setContextMenuStatus)
      .catch(() => setContextMenuStatus(null))
  }, [])

  useEffect(() => { refreshContextMenuStatus() }, [refreshContextMenuStatus])

  const toggleContextMenuScope = useCallback(async (scope: ContextMenuScope) => {
    const isRegistered = scope === 'user'
      ? contextMenuStatus?.user
      : contextMenuStatus?.machine
    try {
      if (isRegistered) {
        await invoke('unregister_context_menu', { scope })
      } else {
        await invoke('register_context_menu', { scope })
      }
    } catch (e) {
      // The most common failure mode is "Elevation was canceled." for the
      // machine scope when the user dismisses the UAC prompt — log and refresh.
      console.error(`Context menu ${scope} toggle failed:`, e)
    }
    refreshContextMenuStatus()
  }, [contextMenuStatus, refreshContextMenuStatus])

  // mpv backend hook — pass the ref object, not .current, so useMpv reads the
  // live DOM element after mount (videoPanelRef.current is null on first render).
  const playback = useMpv(actions, videoPanelRef, state.filePath)

  // File drop onto the video panel
  const handleFileDrop = useCallback((path: string) => {
    actions.setFilePath(path)
  }, [actions])

  useFileDrop(handleFileDrop)

  // Global keyboard shortcuts
  useKeyboard(state, actions, playback)

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

  // Selected segment's 1-based position in start order + total count, for the
  // segment indicator. Same sort key as handleSelectNext so they agree.
  const { selectedSegmentNumber, segmentCount } = useMemo(() => {
    const sorted = [...state.segments].sort((a, b) => a.start - b.start)
    const idx = state.selectedSegmentId
      ? sorted.findIndex(seg => seg.id === state.selectedSegmentId)
      : -1
    return {
      selectedSegmentNumber: idx >= 0 ? idx + 1 : null,
      segmentCount: sorted.length,
    }
  }, [state.segments, state.selectedSegmentId])

  // Next ▸ : select the next segment in start order (wrap last→first; first
  // when nothing selected) AND move the playhead to its start.
  const handleSelectNext = useCallback(() => {
    if (state.segments.length === 0) return
    const sorted = [...state.segments].sort((a, b) => a.start - b.start)
    const curr = state.selectedSegmentId
      ? sorted.findIndex(seg => seg.id === state.selectedSegmentId)
      : -1
    const next = sorted[curr === -1 ? 0 : (curr + 1) % sorted.length]
    actions.selectSegment(next.id)
    handleSeek(next.start)
  }, [state.segments, state.selectedSegmentId, actions, handleSeek])

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
      <div className="video-panel" id="video-panel" ref={videoPanelRef}>
        {state.mpvError && (
          <div className="mpv-error-banner">
            <span style={{ whiteSpace: 'pre-wrap' }}>{state.mpvError}</span>
          </div>
        )}
        {!state.filePath && !state.mpvError && (
          <div className="mpv-error-banner" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            <span>Drop a video file here, or use Open File</span>
            <span style={{ fontSize: 11 }}>Supported: MP4, WebM, MKV, MOV</span>
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
          framesPerScrollTick={state.framesPerScrollTick}
          secondsPerShiftScrollTick={state.secondsPerShiftScrollTick}
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
          contextMenuStatus={contextMenuStatus}
          onChangeFrames={actions.setFramesPerScrollTick}
          onChangeSeconds={actions.setSecondsPerShiftScrollTick}
          onChangeHwEncoder={actions.setHwEncoder}
          onToggleContextMenuScope={toggleContextMenuScope}
          onClose={actions.closeSettingsModal}
        />
      )}

    </div>
  )
}
