type PlaybackControlsProps = {
  // transport
  duration: number
  isPlaying: boolean
  isMuted: boolean
  onPlay: () => void
  onPause: () => void
  onFrameStep: () => void
  onFrameBackStep: () => void
  onToggleMute: () => void
  // segment edit + nav
  selectedSegmentId: string | null
  selectedSegmentNumber: number | null
  segmentCount: number
  onSetStart: () => void
  onSetEnd: () => void
  onAddSegment: () => void
  onDeleteSegment: () => void
  onSelectNext: () => void
  // zoom
  zoom: number
  onChangeZoom: (n: number) => void
}

// ── Inline icons ──────────────────────────────────────────────────────────────
// Monochrome SVGs keep the bar visually consistent. The frame-step icons are
// distinct from fast-forward double-triangles: a vertical bar + a triangle
// reads as "step one frame," matching pro NLE conventions.

const IconFrameBack = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="2" y="3" width="2" height="10" />
    <polygon points="14,3 14,13 6,8" />
  </svg>
)
const IconFrameFwd = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="12" y="3" width="2" height="10" />
    <polygon points="2,3 2,13 10,8" />
  </svg>
)
const IconPlay = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <polygon points="3.5,2.5 13,8 3.5,13.5" />
  </svg>
)
const IconPause = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="3.5" y="3" width="3" height="10" rx="1" />
    <rect x="9.5" y="3" width="3" height="10" rx="1" />
  </svg>
)
const IconVolume = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <polygon points="2,6 5,6 9,3 9,13 5,10 2,10" />
    <path d="M11 5.5 Q13 8 11 10.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M12.5 4 Q15.5 8 12.5 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)
const IconMuted = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <polygon points="2,6 5,6 9,3 9,13 5,10 2,10" />
    <line x1="11" y1="5.5" x2="15" y2="10.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <line x1="15" y1="5.5" x2="11" y2="10.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)
const IconAdd = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <line x1="8" y1="3" x2="8" y2="13" />
    <line x1="3" y1="8" x2="13" y2="8" />
  </svg>
)
const IconTrash = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 4.5 H13" />
    <path d="M6 4.5 V3 H10 V4.5" />
    <path d="M4.5 4.5 L5.2 13 H10.8 L11.5 4.5" />
    <line x1="7" y1="7" x2="7" y2="11" />
    <line x1="9" y1="7" x2="9" y2="11" />
  </svg>
)

export function PlaybackControls({
  duration,
  isPlaying,
  isMuted,
  onPlay,
  onPause,
  onFrameStep,
  onFrameBackStep,
  onToggleMute,
  selectedSegmentId,
  selectedSegmentNumber,
  segmentCount,
  onSetStart,
  onSetEnd,
  onAddSegment,
  onDeleteSegment,
  onSelectNext,
  zoom,
  onChangeZoom,
}: PlaybackControlsProps) {
  const hasFile     = duration > 0
  const hasSelected = !!selectedSegmentId

  return (
    <div className="playback-controls">

      {/* ── Left: Add / Delete, then Set In / Set Out ── */}
      <div className="pc-group pc-group--left">
        <button
          className="btn btn-icon btn-add-delete"
          disabled={!hasFile}
          onClick={onAddSegment}
          title="Add a new 5-second segment at the playhead position"
          aria-label="Add segment"
        >
          <IconAdd />
        </button>
        <button
          className="btn btn-icon btn-add-delete btn-danger-icon"
          disabled={!hasSelected}
          onClick={onDeleteSegment}
          title="Delete selected segment (Delete)"
          aria-label="Delete segment"
        >
          <IconTrash />
        </button>

        <div className="pc-inout">
          <button
            className="btn btn-inout"
            disabled={!hasSelected || !hasFile}
            onClick={onSetStart}
            title="Set start of selected segment to playhead (I)"
            aria-label="Set in point"
          >
            In
          </button>
          <button
            className="btn btn-inout"
            disabled={!hasSelected || !hasFile}
            onClick={onSetEnd}
            title="Set end of selected segment to playhead (O)"
            aria-label="Set out point"
          >
            Out
          </button>
        </div>
      </div>

      {/* ── Center: pure transport — absolutely locked to horizontal center ── */}
      <div className="pc-group pc-group--center">
        <button
          className="btn btn-icon"
          disabled={!hasFile}
          onClick={onFrameBackStep}
          title="Step back one frame (←)"
          aria-label="Step back one frame"
        >
          <IconFrameBack />
        </button>

        <button
          className="btn btn-primary btn-icon btn-icon-lg btn-play-lg"
          disabled={!hasFile}
          onClick={isPlaying ? onPause : onPlay}
          title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <IconPause /> : <IconPlay />}
        </button>

        <button
          className="btn btn-icon"
          disabled={!hasFile}
          onClick={onFrameStep}
          title="Step forward one frame (→)"
          aria-label="Step forward one frame"
        >
          <IconFrameFwd />
        </button>
      </div>

      {/* ── Right: mute, segment nav, zoom ── */}
      <div className="pc-group pc-group--right">
        <button
          className="btn btn-icon"
          disabled={!hasFile}
          onClick={onToggleMute}
          title={isMuted ? 'Unmute' : 'Mute'}
          aria-label={isMuted ? 'Unmute' : 'Mute'}
          aria-pressed={isMuted}
        >
          {isMuted ? <IconMuted /> : <IconVolume />}
        </button>

        <div className="pc-sep" />

        <span className="segment-indicator" title="Currently selected segment">
          {segmentCount === 0
            ? '– / 0'
            : <><b>{selectedSegmentNumber ?? '–'}</b>{' / '}{segmentCount}</>}
        </span>

        <button
          className="btn btn-icon"
          disabled={segmentCount === 0}
          onClick={onSelectNext}
          title="Select next segment (wraps to the first)"
          aria-label="Next segment"
        >
          ▸
        </button>

        <div className="pc-sep" />

        <span className="pc-label">Zoom</span>
        <input
          type="range"
          className="timeline-zoom-slider"
          min={1}
          max={50}
          step={0.5}
          value={zoom}
          onChange={e => onChangeZoom(Number(e.target.value))}
          disabled={!hasFile}
          aria-label="Timeline zoom"
          title="Zoom: magnify the visible portion of the timeline (centered on the playhead)"
        />
      </div>

    </div>
  )
}

