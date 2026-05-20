type SegmentControlsProps = {
  selectedSegmentId: string | null
  duration: number
  zoom: number
  selectedSegmentNumber: number | null  // 1-based position in start order, null = nothing selected
  segmentCount: number
  onSetStart: () => void
  onSetEnd: () => void
  onAddSegment: () => void
  onDeleteSegment: () => void
  onSelectNext: () => void
  onChangeZoom: (n: number) => void
}

export function SegmentControls({
  selectedSegmentId,
  duration,
  zoom,
  selectedSegmentNumber,
  segmentCount,
  onSetStart,
  onSetEnd,
  onAddSegment,
  onDeleteSegment,
  onSelectNext,
  onChangeZoom,
}: SegmentControlsProps) {
  const hasFile     = duration > 0
  const hasSelected = !!selectedSegmentId

  return (
    <div className="segment-controls">
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

      <button
        className="btn btn-primary"
        disabled={!hasFile}
        onClick={onAddSegment}
        title="Add a new 5-second segment at the playhead position"
      >
        + Add Segment
      </button>

      <button
        className="btn btn-danger"
        disabled={!hasSelected}
        onClick={onDeleteSegment}
        title="Delete selected segment (Delete)"
      >
        Delete Segment
      </button>

      {/* Next-segment cycler + selection indicator */}
      <button
        className="btn"
        disabled={segmentCount === 0}
        onClick={onSelectNext}
        title="Select next segment (wraps to the first)"
      >
        Next ▸
      </button>

      <span className="segment-indicator" title="Currently selected segment">
        {segmentCount === 0
          ? 'No segments'
          : `Segment ${selectedSegmentNumber ?? '–'} / ${segmentCount}`}
      </span>

      {/* Zoom slider — right-aligned via margin-left:auto on the wrapper.
          The <label> wraps only the visible "Zoom" text + slider so click on
          the text focuses the slider (default label behavior). The reset
          button is a sibling — keeping a <button> inside a <label> would let
          some browsers route label clicks to the wrapped input, which is
          the wrong UX for a reset action. */}
      <div
        className="timeline-zoom"
        style={{ marginLeft: 'auto' }}
        title="Magnify the visible portion of the timeline; centered on the playhead"
      >
        <label className="timeline-zoom-control">
          <span className="timeline-zoom-label">Zoom</span>
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
          />
        </label>
        <span className="timeline-zoom-value">{zoom.toFixed(1)}×</span>
        <button
          className="btn btn-icon"
          disabled={!hasFile || zoom === 1}
          onClick={() => onChangeZoom(1)}
          title="Reset zoom to fit"
          aria-label="Reset zoom to fit"
          style={{ marginLeft: 4 }}
        >
          ⟲
        </button>
      </div>
    </div>
  )
}
