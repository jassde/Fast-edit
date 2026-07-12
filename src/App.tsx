import "./App.css";
import { useRef, useCallback, useEffect, useState, useMemo } from "react";
import { defaultZoomForDuration, loadBool, saveBool, sourceToKept } from "./utils";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import { useAppState } from "./hooks/useAppState";
import { useMpv } from "./hooks/useMpv";
import { useFileDrop } from "./hooks/useFileDrop";
import { useKeyboard } from "./hooks/useKeyboard";
import { useShortcuts } from "./hooks/useShortcuts";
import { useWheelSeek } from "./hooks/useWheelSeek";
import { HwSupport, ProjectFile } from "./types";

import { Film } from "lucide-react";
import { PlaybackControls } from "./components/PlaybackControls";
import { Sidebar } from "./components/Sidebar";
import { Timeline } from "./components/Timeline";
import { ExportModal } from "./components/ExportModal";
import { SettingsModal } from "./components/SettingsModal";
import { ShortcutsModal } from "./components/ShortcutsModal";

type ScrollSettingsChangePayload = {
  kind: "frames" | "seconds";
  value: number;
};

const NO_HW_SUPPORT: HwSupport = { nvenc: false, qsv: false, amf: false };

// Pan drag snaps to center when within this fraction of the panel (≈ katana 0.025).
const PAN_SNAP = 0.03;

export default function App() {
  const [state, actions] = useAppState();
  const videoPanelRef = useRef<HTMLDivElement>(null);

  const [sidebarExpanded, setSidebarExpanded] = useState(() =>
    loadBool("sidebar-expanded", true),
  );
  const toggleSidebar = useCallback(() => {
    setSidebarExpanded((prev) => {
      const next = !prev;
      saveBool("sidebar-expanded", next);
      return next;
    });
  }, []);

  const [showEffectsPanel, setShowEffectsPanel] = useState(false);
  // Current effect values — kept so the effects window can be re-seeded on open.
  const [effScale, setEffScale] = useState(1);
  const [effSpeed, setEffSpeed] = useState(1);
  // Live pan (video-pan-x/y, fraction of video size) mutated during panel drag.
  const panRef = useRef({ x: 0, y: 0 });
  // Center snap-guide lines shown while dragging the video.
  const [snapGuide, setSnapGuide] = useState({ x: false, y: false, active: false });

  // Keep <html data-accent="..."> in sync with the persisted accent. main.tsx
  // sets the initial value pre-mount; this catches changes from the Settings
  // modal at runtime. Each window owns its own document — the downloader and
  // scroll-panel windows read the same localStorage key in their own main.tsx
  // pre-mount, so they stay consistent after a relaunch.
  useEffect(() => {
    document.documentElement.dataset.accent = state.accentColor;
  }, [state.accentColor]);

  // Probe HW-encoder support once at startup. The Settings modal uses this to
  // know which vendor options to expose. Defaults to "no support" so the
  // dropdown still renders Auto + Software if the probe fails.
  const [hwSupport, setHwSupport] = useState<HwSupport>(NO_HW_SUPPORT);
  useEffect(() => {
    invoke<HwSupport>("get_hw_support")
      .then(setHwSupport)
      .catch(() => {
        /* fall back to NO_HW_SUPPORT — Auto + Software remain selectable */
      });
  }, []);

  // ── Fast-edit root folder ────────────────────────────────────────────────
  // The configurable parent for cookies, saves, and yt-dlp temp downloads.
  // Backend owns persistence (app_paths.json); we just mirror the current
  // value for the Settings UI.
  const [fastEditRoot, setFastEditRoot] = useState<string>("");
  const [rootChangeError, setRootChangeError] = useState<string | null>(null);
  useEffect(() => {
    invoke<string>("get_fast_edit_root").then(setFastEditRoot).catch(() => {});
  }, []);

  const handleChangeFastEditRoot = useCallback(async () => {
    setRootChangeError(null);
    const picked = await open({
      directory: true,
      multiple: false,
      defaultPath: fastEditRoot || undefined,
    });
    if (!picked || typeof picked !== "string") return;
    try {
      const canonical = await invoke<string>("set_fast_edit_root", {
        newPath: picked,
      });
      setFastEditRoot(canonical);
    } catch (e) {
      setRootChangeError(String(e));
    }
  }, [fastEditRoot]);

  // mpv backend hook — pass the ref object, not .current, so useMpv reads the
  // live DOM element after mount (videoPanelRef.current is null on first render).
  const playback = useMpv(actions, videoPanelRef, state.filePath);

  // File drop onto the video panel
  const handleFileDrop = useCallback(
    (path: string) => {
      actions.setFilePath(path);
    },
    [actions],
  );

  const isDragOver = useFileDrop(handleFileDrop);

  // Rebindable keyboard shortcuts
  const shortcuts = useShortcuts();
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);

  // Global keyboard shortcuts
  useKeyboard(
    state,
    actions,
    playback,
    shortcuts.keyToAction,
    showShortcutsModal,
  );

  // Global scroll-wheel seeking (works anywhere in the window, not just the timeline)
  useWheelSeek(state, actions, playback, showShortcutsModal);

  // Native file picker (Open File button)
  const handleOpenFile = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: ["mp4", "webm", "mkv", "mov"] }],
    });
    if (selected && typeof selected === "string") {
      actions.setFilePath(selected);
    }
  }, [actions]);

  // ── Save / Load project ────────────────────────────────────────────────
  // Project files (.vtproj.json) persist filePath + segments + playhead so a
  // session can be resumed later. Default dir is Documents\Fast-edit\saves.
  const pendingSeekRef = useRef<number | null>(null);

  const handleSaveProject = useCallback(async () => {
    if (!state.filePath) return;
    let defaultDir = "";
    try {
      defaultDir = await invoke<string>("default_save_dir");
    } catch {
      /* fall through with empty default */
    }
    const baseName = state.filePath
      .replace(/^.*[\\/]/, "")
      .replace(/\.[^.]+$/, "");
    const suggested = defaultDir
      ? `${defaultDir}\\${baseName || "untitled"}.vtproj.json`
      : `${baseName || "untitled"}.vtproj.json`;
    const target = await save({
      defaultPath: suggested,
      filters: [
        { name: "Video Trimmer Project", extensions: ["vtproj.json", "json"] },
      ],
    });
    if (!target) return;
    const project: ProjectFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      filePath: state.filePath,
      duration: state.duration,
      playheadPosition: state.playheadPosition,
      segments: state.segments,
    };
    try {
      await invoke("save_project", { path: target, project });
    } catch (e) {
      console.error("Save failed:", e);
    }
  }, [state.filePath, state.duration, state.playheadPosition, state.segments]);

  const handleLoadProject = useCallback(async () => {
    let defaultDir: string | undefined;
    try {
      defaultDir = await invoke<string>("default_save_dir");
    } catch {
      /* ignore */
    }
    const picked = await open({
      multiple: false,
      defaultPath: defaultDir,
      filters: [
        { name: "Video Trimmer Project", extensions: ["vtproj.json", "json"] },
      ],
    });
    if (!picked || typeof picked !== "string") return;
    try {
      const project = await invoke<ProjectFile>("load_project", {
        path: picked,
      });
      pendingSeekRef.current = project.playheadPosition;
      actions.loadProject(project);
    } catch (e) {
      console.error("Load failed:", e);
    }
  }, [actions]);

  const handleLoadSaveProject = useCallback(() => {
    if (state.filePath) {
      handleSaveProject();
    } else {
      handleLoadProject();
    }
  }, [state.filePath, handleSaveProject, handleLoadProject]);

  // Apply the pending seek once mpv reports a duration for the loaded file.
  useEffect(() => {
    if (pendingSeekRef.current === null || state.duration <= 0) return;
    const pos = pendingSeekRef.current;
    pendingSeekRef.current = null;
    playback.seek(pos);
    actions.setPlayheadPosition(pos);
  }, [state.duration, playback, actions]);

  // ── Scroll-panel window ────────────────────────────────────────────────
  // A decoration-free WebviewWindow shows the two scroll-step sliders. The
  // panel takes focus normally (no refocus hack) — keyboard shortcuts only
  // need to work when the main window is focused anyway.

  // Push current slider values out whenever they change in main state, so the
  // panel reflects edits made via the Settings modal.
  useEffect(() => {
    emit("scroll-settings", {
      framesPerScrollTick: state.framesPerScrollTick,
      secondsPerShiftScrollTick: state.secondsPerShiftScrollTick,
    }).catch(() => {
      /* panel not open — event is dropped */
    });
  }, [state.framesPerScrollTick, state.secondsPerShiftScrollTick]);

  // Receive slider changes originating in the panel window.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let aborted = false;

    listen<ScrollSettingsChangePayload>("scroll-settings-change", (e) => {
      if (e.payload.kind === "frames") {
        actions.setFramesPerScrollTick(e.payload.value);
      } else {
        actions.setSecondsPerShiftScrollTick(e.payload.value);
      }
    }).then((ul) => {
      if (aborted) ul();
      else unlisten = ul;
    });

    return () => {
      aborted = true;
      unlisten?.();
    };
  }, [actions]);

  // Open/close the scroll-panel window in response to the showScrollPanel flag.
  // The panel closes itself via getCurrentWindow().close() (× button) or Alt+F4;
  // the tauri://destroyed handler then syncs the flag back to false.
  useEffect(() => {
    if (!state.showScrollPanel) {
      WebviewWindow.getByLabel("scroll-panel").then((win) => win?.close());
      return;
    }

    WebviewWindow.getByLabel("scroll-panel").then((existing) => {
      if (existing) return;

      const win = new WebviewWindow("scroll-panel", {
        url: "index.html#scroll-panel",
        title: "Scroll Step",
        decorations: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        width: 280,
        height: 168,
        resizable: false,
      });

      win.once("tauri://error", (e) => {
        console.error("Scroll-panel window error:", e);
      });

      win.once("tauri://destroyed", () => {
        actions.setShowScrollPanel(false);
      });

      // Push current values once the window's listener is ready. The
      // ScrollPanelApp also seeds from localStorage so this is just a freshness
      // guarantee.
      win.once("tauri://created", () => {
        emit("scroll-settings", {
          framesPerScrollTick: state.framesPerScrollTick,
          secondsPerShiftScrollTick: state.secondsPerShiftScrollTick,
        }).catch(() => {});
      });
    });
    // Slider values intentionally excluded — this effect only manages window
    // open/close. The dedicated emit effect above handles slider sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.showScrollPanel, actions]);

  useEffect(() => {
    if (!showEffectsPanel) {
      WebviewWindow.getByLabel("effects-panel").then((win) => win?.close());
      return;
    }

    WebviewWindow.getByLabel("effects-panel").then((existing) => {
      if (existing) return;

      const win = new WebviewWindow("effects-panel", {
        url: "index.html#effects-panel",
        title: "Effects",
        decorations: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        width: 600,
        height: 480,
        resizable: true,
      });

      win.once("tauri://error", (e) => {
        console.error("Effects-panel window error:", e);
      });

      win.once("tauri://destroyed", () => {
        setShowEffectsPanel(false);
      });

      // Seed the panel with current values once its listener is ready.
      win.once("tauri://created", () => {
        emit("effects-settings", { speed: effSpeed, scale: effScale }).catch(() => {});
      });
    });
    // effScale/effSpeed intentionally excluded — this effect only manages
    // window open/close; the seed uses whatever the values are at open time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showEffectsPanel]);

  // Receive slider changes from the effects panel window.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let aborted = false;

    listen<{ kind: "speed" | "scale" | "reset"; value?: number }>(
      "effects-change",
      (e) => {
        if (e.payload.kind === "speed") {
          playback.setSpeed(e.payload.value!);
          setEffSpeed(e.payload.value!);
        } else if (e.payload.kind === "scale") {
          playback.setScale(e.payload.value!);
          setEffScale(e.payload.value!);
        } else {
          playback.resetPlacement();
          panRef.current = { x: 0, y: 0 };
          setEffScale(1);
        }
      },
    ).then((ul) => {
      if (aborted) ul();
      else unlisten = ul;
    });

    return () => {
      aborted = true;
      unlisten?.();
    };
  }, [playback]);

  // Drag the video to reposition it (mpv video-pan-x/y), snapping to center.
  const panDragRef = useRef<{
    startX: number; startY: number; baseX: number; baseY: number; w: number; h: number;
  } | null>(null);

  const handleVideoPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!state.filePath) return;
    const panel = videoPanelRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    panDragRef.current = {
      startX: e.clientX, startY: e.clientY,
      baseX: panRef.current.x, baseY: panRef.current.y,
      w: r.width, h: r.height,
    };
    panel.setPointerCapture(e.pointerId);
    setSnapGuide((g) => ({ ...g, active: true }));
  }, [state.filePath]);

  const handleVideoPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = panDragRef.current;
    if (!d || d.w === 0 || d.h === 0) return;
    let x = d.baseX + (e.clientX - d.startX) / d.w;
    let y = d.baseY + (e.clientY - d.startY) / d.h;
    const snapX = Math.abs(x) < PAN_SNAP;
    const snapY = Math.abs(y) < PAN_SNAP;
    if (snapX) x = 0;
    if (snapY) y = 0;
    panRef.current = { x, y };
    playback.setPan(x, y);
    setSnapGuide({ x: snapX, y: snapY, active: true });
  }, [playback]);

  const handleVideoPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!panDragRef.current) return;
    panDragRef.current = null;
    videoPanelRef.current?.releasePointerCapture(e.pointerId);
    setSnapGuide({ x: false, y: false, active: false });
  }, []);

  // Open the downloader as a separate Tauri window; focus it if already open
  const openDownloaderWindow = useCallback(async () => {
    const existing = await WebviewWindow.getByLabel("downloader");
    if (existing) {
      existing.setFocus();
      return;
    }
    const win = new WebviewWindow("downloader", {
      url: "index.html#downloader",
      title: "Video Downloader",
      width: 600,
      height: 560,
      minWidth: 460,
      minHeight: 440,
      resizable: true,
      center: true,
    });
    win.once("tauri://error", (e) => {
      console.error("Downloader window error:", e);
    });
  }, []);

  // Seek: update both mpv and local playhead state
  const handleSeek = useCallback(
    (time: number) => {
      playback.seek(time);
      actions.setPlayheadPosition(time);
    },
    [playback, actions],
  );

  // Play/pause with state sync
  const handlePlay = useCallback(() => {
    playback.play();
    actions.setIsPlaying(true);
  }, [playback, actions]);

  const handlePause = useCallback(() => {
    playback.pause();
    actions.setIsPlaying(false);
  }, [playback, actions]);

  // Mute toggle — set optimistically, mpv's "mute" property observation in
  // useMpv will confirm the new value (matches the play/pause pattern).
  const handleToggleMute = useCallback(() => {
    const next = !state.isMuted;
    playback.setMute(next);
    actions.setIsMuted(next);
  }, [playback, actions, state.isMuted]);

  // Timeline zoom — local UI state, not persisted across sessions. 1 = fit
  // entire video; higher values show a window of `duration / zoom` seconds
  // centered on the playhead.
  //
  // On every new file load (once mpv has reported the duration), reset to
  // `defaultZoomForDuration` so longer videos open with a useful editing
  // window instead of a single squashed strip. Manual slider changes after
  // load aren't overridden — the ref guards against re-firing for the same
  // file when mpv re-reports duration mid-playback.
  const [timelineZoom, setTimelineZoom] = useState<number>(1);
  const lastZoomedFileRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state.filePath || state.duration === 0) return;
    if (lastZoomedFileRef.current === state.filePath) return;
    lastZoomedFileRef.current = state.filePath;
    setTimelineZoom(defaultZoomForDuration(state.duration));
  }, [state.filePath, state.duration]);

  // On a fresh file load, once mpv reports duration, seed the timeline with
  // one segment spanning the whole video so it acts as the starting point for
  // splits. ensureFullSegment is a no-op if segments already exist (e.g. when
  // a saved project loaded segments), so this is safe to run on every change.
  useEffect(() => {
    if (!state.filePath || state.duration <= 0) return;
    actions.ensureFullSegment();
  }, [state.filePath, state.duration, actions]);

  // Filmstrip thumbnails — extracted once per file when duration is known.
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const thumbFileRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state.filePath || state.duration <= 0) {
      if (!state.filePath) thumbFileRef.current = null;
      return;
    }
    if (thumbFileRef.current === state.filePath) return;
    thumbFileRef.current = state.filePath;
    setThumbnails([]);
    invoke<string[]>("generate_thumbnails", {
      filePath: state.filePath,
      duration: state.duration,
      count: 30,
    })
      .then(setThumbnails)
      .catch(() => {});
  }, [state.filePath, state.duration]);

  // Single sorted copy shared by the segment indicator and handleSelectNext.
  const sortedSegments = useMemo(
    () => [...state.segments].sort((a, b) => a.start - b.start),
    [state.segments],
  );

  // During playback, ripple-deleted segments leave a gap in SOURCE time that
  // mpv (which only knows the original, uncut file) will happily keep playing
  // through. Detect when the playhead has drifted into such a gap and jump
  // straight to the next kept segment — or pause if there isn't one — instead
  // of letting mpv play the removed footage.
  useEffect(() => {
    if (!state.isPlaying || sortedSegments.length === 0) return;
    if (sourceToKept(state.playheadPosition, sortedSegments) !== null) return;
    const next = sortedSegments.find((seg) => seg.start > state.playheadPosition);
    if (next) {
      handleSeek(next.start);
    } else {
      handlePause();
    }
  }, [state.isPlaying, state.playheadPosition, sortedSegments, handleSeek, handlePause]);

  // Selected segment's 1-based position in start order + total count, for the
  // segment indicator.
  const { selectedSegmentNumber, segmentCount } = useMemo(() => {
    const idx = state.selectedSegmentId
      ? sortedSegments.findIndex((seg) => seg.id === state.selectedSegmentId)
      : -1;
    return {
      selectedSegmentNumber: idx >= 0 ? idx + 1 : null,
      segmentCount: sortedSegments.length,
    };
  }, [sortedSegments, state.selectedSegmentId]);

  // Next ▸ : select the next segment in start order (wrap last→first; first
  // when nothing selected) AND move the playhead to its start.
  const handleSelectNext = useCallback(() => {
    if (sortedSegments.length === 0) return;
    const curr = state.selectedSegmentId
      ? sortedSegments.findIndex((seg) => seg.id === state.selectedSegmentId)
      : -1;
    const next =
      sortedSegments[curr === -1 ? 0 : (curr + 1) % sortedSegments.length];
    actions.selectSegment(next.id);
    handleSeek(next.start);
  }, [sortedSegments, state.selectedSegmentId, actions, handleSeek]);

  return (
    <div className="app-shell">
      {/* ── Top row: sidebar + video panel ── */}
      <div className="app-top">
        {/* ── Sidebar ── */}
        <Sidebar
          expanded={sidebarExpanded}
          showScrollPanel={state.showScrollPanel}
          showEffectsPanel={showEffectsPanel}
          exportEnabled={state.segments.length > 0 && state.duration > 0}
          hasFile={!!state.filePath}
          onToggle={toggleSidebar}
          onOpenFile={handleOpenFile}
          onDownload={openDownloaderWindow}
          onLoadSaveProject={handleLoadSaveProject}
          onToggleScrollPanel={() => actions.setShowScrollPanel(!state.showScrollPanel)}
          onToggleEffectsPanel={() => setShowEffectsPanel(!showEffectsPanel)}
          onOpenShortcuts={() => setShowShortcutsModal(true)}
          onOpenSettings={actions.openSettingsModal}
          onExport={actions.openExportModal}
        />

        {/* ── Video column (fills beside sidebar) ── */}
        <div className="video-column">
          {/* ── Video panel ── */}
          {/* Transparent slot — libmpv renders behind the WebView, constrained to
            this rect by setVideoMarginRatio (see useMpv.ts). The banners below
            provide an opaque background when no file is loaded or mpv errored. */}
          <div
            className={`video-panel${isDragOver ? " drag-over" : ""}${state.filePath ? " pannable" : ""}`}
            id="video-panel"
            ref={videoPanelRef}
            onPointerDown={handleVideoPointerDown}
            onPointerMove={handleVideoPointerMove}
            onPointerUp={handleVideoPointerUp}
            onPointerCancel={handleVideoPointerUp}
          >
            {snapGuide.active && snapGuide.x && (
              <div className="video-guide video-guide--v" aria-hidden="true" />
            )}
            {snapGuide.active && snapGuide.y && (
              <div className="video-guide video-guide--h" aria-hidden="true" />
            )}
            {state.mpvError && (
              <div className="video-banner video-banner--error">
                <span style={{ whiteSpace: "pre-wrap" }}>{state.mpvError}</span>
              </div>
            )}
            {!state.filePath && !state.mpvError && (
              <div className="video-banner video-banner--empty">
                <div className="empty-icon" aria-hidden="true">
                  <Film strokeWidth={1.5} />
                </div>
                <span>Drop a video file here, or use Open File</span>
                <span className="hint">MP4 · WebM · MKV · MOV</span>
                <div className="onboarding-steps">
                  <div className="onboarding-step">
                    <span className="onboarding-step-num">1</span>
                    <span className="onboarding-step-text">Open a video</span>
                  </div>
                  <div
                    className="onboarding-step-connector"
                    aria-hidden="true"
                  />
                  <div className="onboarding-step">
                    <span className="onboarding-step-num">2</span>
                    <span className="onboarding-step-text">
                      Mark with <kbd>I</kbd> / <kbd>O</kbd>
                    </span>
                  </div>
                  <div
                    className="onboarding-step-connector"
                    aria-hidden="true"
                  />
                  <div className="onboarding-step">
                    <span className="onboarding-step-num">3</span>
                    <span className="onboarding-step-text">Export</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        {/* end video-column */}
      </div>
      {/* end app-top */}

      {/* ── Unified control bar (full width) ── */}
      <PlaybackControls
        duration={state.duration}
        playheadPosition={state.playheadPosition}
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
            actions.setSelectedStart(state.playheadPosition);
          }
        }}
        onSetEnd={() => {
          if (state.selectedSegmentId) {
            actions.setSelectedEnd(state.playheadPosition);
          }
        }}
        onSplit={actions.splitSegment}
        onDeleteSegment={() => {
          if (state.selectedSegmentId) {
            actions.deleteSegment(state.selectedSegmentId);
          }
        }}
        onSelectNext={handleSelectNext}
        zoom={timelineZoom}
        onChangeZoom={setTimelineZoom}
      />

      {/* ── Timeline (full width) ── */}
      <div className="timeline-strip">
        <Timeline
          duration={state.duration}
          segments={state.segments}
          selectedSegmentId={state.selectedSegmentId}
          playheadPosition={state.playheadPosition}
          zoom={timelineZoom}
          thumbnails={thumbnails}
          onSeek={handleSeek}
          onSelectSegment={actions.selectSegment}
          onUpdateSegmentStart={actions.setSegmentStart}
          onUpdateSegmentEnd={actions.setSegmentEnd}
          onDragBegin={actions.beginDrag}
          onDragEnd={actions.endDrag}
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
          accentColor={state.accentColor}
          fastEditRoot={fastEditRoot}
          rootChangeError={rootChangeError}
          onChangeFrames={actions.setFramesPerScrollTick}
          onChangeSeconds={actions.setSecondsPerShiftScrollTick}
          onChangeHwEncoder={actions.setHwEncoder}
          onChangeAccentColor={actions.setAccentColor}
          onChangeFastEditRoot={handleChangeFastEditRoot}
          onClose={actions.closeSettingsModal}
        />
      )}
    </div>
  );
}
