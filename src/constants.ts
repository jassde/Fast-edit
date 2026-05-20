// App-wide constants. Import from here — never hardcode these values inline.

export const SEGMENT_COLORS = [
  '#4287f5',
  '#e94560',
  '#a0c4ff',
  '#f5a623',
  '#7ed321',
  '#bd10e0',
  '#50e3c2',
  '#ff6b6b',
] as const

export const TIMELINE_HEIGHT      = 90   // px — total height of timeline strip
export const TIMELINE_RULER_HEIGHT = 18  // px — top ruler band
export const HANDLE_WIDTH         = 12   // px — drag handle width on each segment side
export const PLAYHEAD_HEAD_WIDTH  = 19   // px — triangle base width

// Assumed frame rate used for scroll-wheel stepping when no file is loaded.
// Updated at runtime via useMpv once a file loads (via video-loaded event).
export const DEFAULT_FPS = 30

// ── User-configurable scroll-wheel stepping (persisted to localStorage) ──────
export const DEFAULT_FRAMES_PER_SCROLL_TICK        = 5
export const MIN_FRAMES_PER_SCROLL_TICK            = 1
export const MAX_FRAMES_PER_SCROLL_TICK            = 30

export const DEFAULT_SECONDS_PER_SHIFT_SCROLL_TICK = 1
export const MIN_SECONDS_PER_SHIFT_SCROLL_TICK     = 1
export const MAX_SECONDS_PER_SHIFT_SCROLL_TICK     = 20

export const SETTINGS_STORAGE_KEY = 'video-trimmer-settings'

// Default hardware-encoder choice. `auto` picks the best available HW encoder
// at export time (NVENC > QSV > AMF), falling back to software if none.
export const DEFAULT_HW_ENCODER = 'auto' as const

// Minimum visible width for a segment block on the timeline. Without this,
// segments with start ≈ end disappear and become un-grabbable.
export const MIN_SEGMENT_PX = 4

// Smallest "addable" segment in seconds. addSegment no-ops if the available
// gap between the playhead and the next neighbour is below this.
export const MIN_SEGMENT_DURATION_S = 0.1

// Smallest enforced gap between a segment's start and end during drag/clamp.
// Roughly one frame at 30fps; prevents zero-length and inverted segments.
export const MIN_FRAME_GAP_S = 0.033
