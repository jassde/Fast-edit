import './App.css'
import { useRef, useCallback, useEffect, useState, useMemo } from 'react'
import { formatTime } from './utils'
import { open, save } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

import { useAppState } from './hooks/useAppState'
import { useMpv } from './hooks/useMpv'
import { useFileDrop } from './hooks/useFileDrop'
import { useKeyboard } from './hooks/useKeyboard'
import { useShortcuts } from './hooks/useShortcuts'
import { useWheelSeek } from './hooks/useWheelSeek'
import { HwSupport, ProjectFile } from './types'

import { PlaybackControls } from './components/PlaybackControls'
import { Timeline } from './components/Timeline'
import { ExportModal } from './components/ExportModal'
import { SettingsModal } from './components/SettingsModal'
import { ShortcutsModal } from './components/ShortcutsModal'

type ScrollSettingsChangePayload = { kind: 'frames' | 'seconds'; value: number }

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

  // mpv backend hook — pass the ref object, not .current, so useMpv reads the
  // live DOM element after mount (videoPanelRef.current is null on first render).
  const playback = useMpv(actions, videoPanelRef, state.filePath)

  // File drop onto the video panel
  const handleFileDrop = useCallback((path: string) => {
    actions.setFilePath(path)
  }, [actions])

  const isDragOver = useFileDrop(handleFileDrop)

  // Rebindable keyboard shortcuts
  const shortcuts = useShortcuts()
  const [showShortcutsModal, setShowShortcutsModal] = useState(false)

  // Global keyboard shortcuts
  useKeyboard(state, actions, playback, shortcuts.keyToAction, showShortcutsModal)

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

  // ── Save / Load project ────────────────────────────────────────────────
  // Project files (.vtproj.json) persist filePath + segments + playhead so a
  // session can be resumed later. Default dir is Documents\Video Trimmer\saves.
  const pendingSeekRef = useRef<number | null>(null)

  const handleSaveProject = useCallback(async () => {
    if (!state.filePath) return
    let defaultDir = ''
    try {
      defaultDir = await invoke<string>('default_save_dir')
    } catch { /* fall through with empty default */ }
    const baseName = state.filePath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
    const suggested = defaultDir
      ? `${defaultDir}\\${baseName || 'untitled'}.vtproj.json`
      : `${baseName || 'untitled'}.vtproj.json`
    const target = await save({
      defaultPath: suggested,
      filters: [{ name: 'Video Trimmer Project', extensions: ['vtproj.json', 'json'] }],
    })
    if (!target) return
    const project: ProjectFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      filePath: state.filePath,
      duration: state.duration,
      playheadPosition: state.playheadPosition,
      segments: state.segments,
    }
    try {
      await invoke('save_project', { path: target, project })
    } catch (e) {
      console.error('Save failed:', e)
    }
  }, [state.filePath, state.duration, state.playheadPosition, state.segments])

  const handleLoadProject = useCallback(async () => {
    let defaultDir: string | undefined
    try {
      defaultDir = await invoke<string>('default_save_dir')
    } catch { /* ignore */ }
    const picked = await open({
      multiple: false,
      defaultPath: defaultDir,
      filters: [{ name: 'Video Trimmer Project', extensions: ['vtproj.json', 'json'] }],
    })
    if (!picked || typeof picked !== 'string') return
    try {
      const project = await invoke<ProjectFile>('load_project', { path: picked })
      pendingSeekRef.current = project.playheadPosition
      actions.loadProject(project)
    } catch (e) {
      console.error('Load failed:', e)
    }
  }, [actions])

  // Apply the pending seek once mpv reports a duration for the loaded file.
  useEffect(() => {
    if (pendingSeekRef.current === null || state.duration <= 0) return
    const pos = pendingSeekRef.current
    pendingSeekRef.current = null
    playback.seek(pos)
    actions.setPlayheadPosition(pos)
  }, [state.duration, playback, actions])

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

  // ── Scroll-panel window ────────────────────────────────────────────────
  // A decoration-free WebviewWindow shows the two scroll-step sliders. The
  // panel takes focus normally (no refocus hack) — keyboard shortcuts only
  // need to work when the main window is focused anyway.

  // Push current slider values out whenever they change in main state, so the
  // panel reflects edits made via the Settings modal.
  useEffect(() => {
    emit('scroll-settings', {
      framesPerScrollTick:       state.framesPerScrollTick,
      secondsPerShiftScrollTick: state.secondsPerShiftScrollTick,
    }).catch(() => { /* panel not open — event is dropped */ })
  }, [state.framesPerScrollTick, state.secondsPerShiftScrollTick])

  // Receive slider changes originating in the panel window.
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

  // Open/close the scroll-panel window in response to the showScrollPanel flag.
  // The panel closes itself via getCurrentWindow().close() (× button) or Alt+F4;
  // the tauri://destroyed handler then syncs the flag back to false.
  useEffect(() => {
    if (!state.showScrollPanel) {
      WebviewWindow.getByLabel('scroll-panel').then(win => win?.close())
      return
    }

    WebviewWindow.getByLabel('scroll-panel').then(existing => {
      if (existing) return

      const win = new WebviewWindow('scroll-panel', {
        url:           'index.html#scroll-panel',
        title:         'Scroll Step',
        decorations:   false,
        alwaysOnTop:   true,
        skipTaskbar:   true,
        width:         280,
        height:        168,
        resizable:     false,
      })

      win.once('tauri://error', e => {
        console.error('Scroll-panel window error:', e)
      })

      win.once('tauri://destroyed', () => {
        actions.setShowScrollPanel(false)
      })

      // Push current values once the window's listener is ready. The
      // ScrollPanelApp also seeds from localStorage so this is just a freshness
      // guarantee.
      win.once('tauri://created', () => {
        emit('scroll-settings', {
          framesPerScrollTick:       state.framesPerScrollTick,
          secondsPerShiftScrollTick: state.secondsPerShiftScrollTick,
        }).catch(() => {})
      })
    })
  // Slider values intentionally excluded — this effect only manages window
  // open/close. The dedicated emit effect above handles slider sync.
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

  // Top-bar centre dropdown — click-toggled, closes on Escape or outside click.
  const [showDropdown, setShowDropdown] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!showDropdown) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowDropdown(false) }
    const onPointer = (e: PointerEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [showDropdown])

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
        <div className="top-bar-sep" />
        <button className="btn btn-chrome" onClick={handleOpenFile}>
          Open File
        </button>

        {state.duration > 0 && (
          <span className="top-bar-time" title="Current position / total duration">
            <span>{formatTime(state.playheadPosition)}</span>
            <span className="sep">/</span>
            <span className="total">{formatTime(state.duration)}</span>
          </span>
        )}

        {/* ── Centre dropdown ── */}
        <div className="top-bar-dropdown" ref={dropdownRef}>
          <button
            className="btn btn-chrome top-bar-dropdown-trigger"
            aria-label="Menu"
            aria-haspopup="true"
            aria-expanded={showDropdown}
            onClick={() => setShowDropdown(v => !v)}
          >
            •••
          </button>
          <div className={`top-bar-dropdown-menu${showDropdown ? ' open' : ''}`} role="menu">
            <button className="dropdown-item" role="menuitem" aria-label="Keyboard shortcuts" onClick={() => { setShowDropdown(false); setShowShortcutsModal(true) }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M14 5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM2 4a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/>
                <path d="M13 10.25a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm0-2a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm-5 0A.25.25 0 0 1 8.25 8h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 8 8.75zm2 0a.25.25 0 0 1 .25-.25h1.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-1.5a.25.25 0 0 1-.25-.25zm1 2a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm-5-2A.25.25 0 0 1 6.25 8h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 6 8.75zm-2 0A.25.25 0 0 1 4.25 8h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 4 8.75zm-2 0A.25.25 0 0 1 2.25 8h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 2 8.75zm11-2a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm-2 0a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm-2 0A.25.25 0 0 1 9.25 6h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 9 6.75zm-2 0A.25.25 0 0 1 7.25 6h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 7 6.75zm-2 0A.25.25 0 0 1 5.25 6h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 5 6.75zm-3 0A.25.25 0 0 1 2.25 6h1.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-1.5A.25.25 0 0 1 2 6.75zm0 4a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm2 0a.25.25 0 0 1 .25-.25h5.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-5.5a.25.25 0 0 1-.25-.25z"/>
              </svg>
              <span>Shortcuts</span>
            </button>
            <button className="dropdown-item" role="menuitem" aria-label="Save project" disabled={!state.filePath} onClick={() => { setShowDropdown(false); handleSaveProject() }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M0 1a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1zm4 0v6h8V1zm8 8H4v6h8zM1 1v2h2V1zm2 3H1v2h2zM1 7v2h2V7zm2 3H1v2h2zm-2 3v2h2v-2zM15 1h-2v2h2zm-2 3v2h2V4zm2 3h-2v2h2zm-2 3v2h2v-2zm2 3h-2v2h2z"/>
              </svg>
              <span>Save</span>
            </button>
            <button className="dropdown-item" role="menuitem" aria-label="Load project" onClick={() => { setShowDropdown(false); handleLoadProject() }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M.54 3.87.5 3a2 2 0 0 1 2-2h3.672a2 2 0 0 1 1.414.586l.828.828A2 2 0 0 0 9.828 3h3.982a2 2 0 0 1 1.992 2.181l-.637 7A2 2 0 0 1 13.174 14H2.826a2 2 0 0 1-1.991-1.819l-.637-7a2 2 0 0 1 .342-1.31zM2.19 4a1 1 0 0 0-.996 1.09l.637 7a1 1 0 0 0 .995.91h10.348a1 1 0 0 0 .995-.91l.637-7A1 1 0 0 0 13.81 4zm4.69-1.707A1 1 0 0 0 6.172 2H2.5a1 1 0 0 0-1 .981l.006.139q.323-.119.684-.12h5.396z"/>
              </svg>
              <span>Load</span>
            </button>
            <button className="dropdown-item" role="menuitem" aria-label="Input time codes" onClick={() => setShowDropdown(false)}>
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2.5 15a.5.5 0 1 1 0-1h1v-1a4.5 4.5 0 0 1 2.557-4.06c.29-.139.443-.377.443-.59v-.7c0-.213-.154-.451-.443-.59A4.5 4.5 0 0 1 3.5 3V2h-1a.5.5 0 0 1 0-1h11a.5.5 0 0 1 0 1h-1v1a4.5 4.5 0 0 1-2.557 4.06c-.29.139-.443.377-.443.59v.7c0 .213.154.451.443.59A4.5 4.5 0 0 1 12.5 13v1h1a.5.5 0 0 1 0 1zm2-13v1c0 .537.12 1.045.337 1.5h6.326c.216-.455.337-.963.337-1.5V2zm3 6.35c0 .701-.478 1.236-1.011 1.492A3.5 3.5 0 0 0 4.5 13s.866-1.299 3-1.48zm1 0v3.17c2.134.181 3 1.48 3 1.48a3.5 3.5 0 0 0-1.989-3.158C8.978 9.586 8.5 9.052 8.5 8.351z"/>
              </svg>
              <span>Times</span>
            </button>
            <button className="dropdown-item" role="menuitem" aria-label="Download video" onClick={() => { openDownloaderWindow(); setShowDropdown(false) }}>
              <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 12l-5-5h3V2h4v5h3L8 12z"/>
                <rect x="2" y="13" width="12" height="1.5" rx="0.75"/>
              </svg>
              <span>Download</span>
            </button>
            <button className="dropdown-item" role="menuitem" aria-label="Scroll step settings" aria-pressed={state.showScrollPanel} onClick={() => { actions.setShowScrollPanel(!state.showScrollPanel); setShowDropdown(false) }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 5a5 5 0 0 1 10 0v6a5 5 0 0 1-10 0zm5.5-1.5a.5.5 0 0 0-1 0v2a.5.5 0 0 0 1 0z"/>
              </svg>
              <span>Scroll</span>
            </button>
            <button className="dropdown-item" role="menuitem" aria-label="Settings" onClick={() => { actions.openSettingsModal(); setShowDropdown(false) }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492M5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0"/>
                <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115z"/>
              </svg>
              <span>Settings</span>
            </button>
          </div>
        </div>

        <button
          className="btn btn-primary btn-export"
          style={{ marginLeft: 'auto' }}
          disabled={state.segments.length === 0 || state.duration === 0}
          onClick={actions.openExportModal}
          title="Export segments (requires at least one segment)"
          aria-label="Export segments"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 8a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0m7.5-1.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3"/>
            <path d="M0 1.5A.5.5 0 0 1 .5 1h1a.5.5 0 0 1 .5.5V4h13.5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5H2v2.5a.5.5 0 0 1-1 0V2H.5a.5.5 0 0 1-.5-.5m5.5 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M9 8a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0"/>
            <path d="M3 12.5h3.5v1a.5.5 0 0 1-.5.5H3.5a.5.5 0 0 1-.5-.5zm4 1v-1h4v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5"/>
          </svg>
          <span>Export</span>
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

      {/* ── Shortcuts modal ── */}
      {showShortcutsModal && (
        <ShortcutsModal
          bindings={shortcuts.bindings}
          onRebind={shortcuts.setBinding}
          onReset={shortcuts.reset}
          onClose={() => setShowShortcutsModal(false)}
        />
      )}

      {/* ── Settings modal ── */}
      {state.showSettingsModal && (
        <SettingsModal
          framesPerScrollTick={state.framesPerScrollTick}
          secondsPerShiftScrollTick={state.secondsPerShiftScrollTick}
          hwEncoder={state.hwEncoder}
          hwSupport={hwSupport}
          onChangeFrames={actions.setFramesPerScrollTick}
          onChangeSeconds={actions.setSecondsPerShiftScrollTick}
          onChangeHwEncoder={actions.setHwEncoder}
          onClose={actions.closeSettingsModal}
        />
      )}

    </div>
  )
}
