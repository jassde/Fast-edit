import { formatTime } from '../utils'

type PlaybackControlsProps = {
  currentTime: number
  duration: number
  isPlaying: boolean
  isMuted: boolean
  onPlay: () => void
  onPause: () => void
  onFrameStep: () => void
  onFrameBackStep: () => void
  onToggleMute: () => void
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
}: PlaybackControlsProps) {
  const disabled = duration === 0

  return (
    <div className="playback-controls">
      <span className="time-display" title="Current position">
        {formatTime(currentTime)}
      </span>

      <button
        className="btn btn-icon"
        disabled={disabled}
        onClick={onFrameBackStep}
        title="Step back one frame (←)"
      >
        ◀◀
      </button>

      <button
        className="btn btn-primary btn-icon"
        disabled={disabled}
        onClick={isPlaying ? onPause : onPlay}
        title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
        style={{ minWidth: 40 }}
      >
        {isPlaying ? '⏸' : '▶'}
      </button>

      <button
        className="btn btn-icon"
        disabled={disabled}
        onClick={onFrameStep}
        title="Step forward one frame (→)"
      >
        ▶▶
      </button>

      <button
        className="btn btn-icon"
        disabled={disabled}
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
  )
}
