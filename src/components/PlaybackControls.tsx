import { formatTime } from '../utils'

type PlaybackControlsProps = {
  // transport
  currentTime: number
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

export function PlaybackControls({
  currentTime,
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

      {/* ── Left: segment editing ── */}
      <div className="pc-group pc-group--left">
        <button
          className="btn btn-primary btn-icon"
          disabled={!hasFile}
          onClick={onAddSegment}
          title="Add a new 5-second segment at the playhead position"
          aria-label="Add segment"
        >
          +
        </button>
        <button
          className="btn btn-danger"
          disabled={!hasSelected}
          onClick={onDeleteSegment}
          title="Delete selected segment (Delete)"
        >
          Del
        </button>
        <button
          className="btn"
          disabled={!hasSelected || !hasFile}
          onClick={onSetStart}
          title="Set start of selected segment to playhead (I)"
        >
          Set Start
        </button>
        <button
          className="btn"
          disabled={!hasSelected || !hasFile}
          onClick={onSetEnd}
          title="Set end of selected segment to playhead (O)"
        >
          Set End
        </button>
      </div>

      {/* ── Center: transport ── */}
      <div className="pc-group pc-group--center">
        <span className="time-display" title="Current position">
          {formatTime(currentTime)}
        </span>

        <button
          className="btn btn-icon"
          disabled={!hasFile}
          onClick={onFrameBackStep}
          title="Step back one frame (←)"
        >
          ◀◀
        </button>

        <button
          className="btn btn-primary btn-icon"
          disabled={!hasFile}
          onClick={isPlaying ? onPause : onPlay}
          title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
          style={{ minWidth: 40 }}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>

        <button
          className="btn btn-icon"
          disabled={!hasFile}
          onClick={onFrameStep}
          title="Step forward one frame (→)"
        >
          ▶▶
        </button>

        <button
          className="btn btn-icon"
          disabled={!hasFile}
          onClick={onToggleMute}
          title={isMuted ? 'Unmute' : 'Mute'}
          aria-label={isMuted ? 'Unmute' : 'Mute'}
          aria-pressed={isMuted}
        >
          {isMuted ? '🔇' : '🔊'}
        </button>

        <span className="time-display" title="Total duration">
          {formatTime(duration)}
        </span>
      </div>

      {/* ── Right: segment nav + zoom ── */}
      <div className="pc-group pc-group--right">
        <span className="segment-indicator" title="Currently selected segment">
          {segmentCount === 0
            ? '– / 0'
            : `${selectedSegmentNumber ?? '–'} / ${segmentCount}`}
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
