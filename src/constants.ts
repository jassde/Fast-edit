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

// Fallback frame rate for scroll-wheel frame-stepping, used until mpv reports
// the loaded clip's container-fps (observed in useMpv and held in AppState.fps).
export const DEFAULT_FPS = 30

// ── User-configurable scroll-wheel stepping (persisted to localStorage) ──────
export const DEFAULT_FRAMES_PER_SCROLL_TICK        = 5
export const MIN_FRAMES_PER_SCROLL_TICK            = 1
export const MAX_FRAMES_PER_SCROLL_TICK            = 30

export const DEFAULT_SECONDS_PER_SHIFT_SCROLL_TICK = 1
export const MIN_SECONDS_PER_SHIFT_SCROLL_TICK     = 1
export const MAX_SECONDS_PER_SHIFT_SCROLL_TICK     = 20

export const SETTINGS_STORAGE_KEY = 'video-trimmer-settings'

// ── Accent color presets ─────────────────────────────────────────────────────
// The actual OKLCH values live in App.css under `:root[data-accent="..."]`.
// Keep this list in sync with that selector set and the swatch UI in SettingsModal.
export const ACCENT_COLORS = ['red', 'gold', 'green', 'blue', 'purple'] as const
export type AccentColor = (typeof ACCENT_COLORS)[number]
export const DEFAULT_ACCENT_COLOR: AccentColor = 'red'

export const ACCENT_PREVIEW: Record<AccentColor, string> = {
  red:    'oklch(0.68 0.19 25)',
  gold:   'oklch(0.78 0.16 65)',
  green:  'oklch(0.74 0.17 150)',
  blue:   'oklch(0.68 0.16 250)',
  purple: 'oklch(0.65 0.20 310)',
}

export const ACCENT_LABELS: Record<AccentColor, string> = {
  red:    'Red',
  gold:   'Gold',
  green:  'Green',
  blue:   'Blue',
  purple: 'Purple',
}

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

// ── Timeline zoom ────────────────────────────────────────────────────────────
// Max raised from the original 50 so 1hr+ videos can still default to a true
// 60s visible window (e.g. 2hr file → zoom 120). Slider step stays at 0.5 in
// PlaybackControls, so the dynamic range is large enough to be useful but the
// slider is still draggable smoothly.
export const MIN_TIMELINE_ZOOM = 1
export const MAX_TIMELINE_ZOOM = 500

// On file load, the default zoom is chosen so roughly this many seconds of the
// timeline are visible, clamped to [MIN, MAX]. 60s is the common video-editor
// default — wide enough to see context, tight enough for frame-level edits.
export const DEFAULT_TARGET_VISIBLE_SECONDS = 15
