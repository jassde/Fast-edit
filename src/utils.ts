import {
  SEGMENT_COLORS,
  MIN_TIMELINE_ZOOM,
  MAX_TIMELINE_ZOOM,
  DEFAULT_TARGET_VISIBLE_SECONDS,
} from './constants'

/** Format seconds to HH:MM:SS.mmm */
export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0
  const h  = Math.floor(seconds / 3600)
  const m  = Math.floor((seconds % 3600) / 60)
  const s  = Math.floor(seconds % 60)
  const ms = Math.round((seconds % 1) * 1000)
  return (
    String(h).padStart(2, '0') + ':' +
    String(m).padStart(2, '0') + ':' +
    String(s).padStart(2, '0') + '.' +
    String(ms).padStart(3, '0')
  )
}

/** Clamp value between min and max */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Default timeline zoom for a freshly-loaded video. Targets a visible window
 * of `DEFAULT_TARGET_VISIBLE_SECONDS` seconds, clamped to slider bounds. So a
 * 10s clip stays at 1x (full view), a 10min file opens at 10x, and a 2hr file
 * opens at 120x. Returns 1 (no zoom) if duration isn't known yet.
 */
export function defaultZoomForDuration(duration: number): number {
  if (!isFinite(duration) || duration <= DEFAULT_TARGET_VISIBLE_SECONDS) {
    return MIN_TIMELINE_ZOOM
  }
  return clamp(duration / DEFAULT_TARGET_VISIBLE_SECONDS, MIN_TIMELINE_ZOOM, MAX_TIMELINE_ZOOM)
}

/** Convert pixel offset on timeline to time in seconds */
export function pixelToTime(px: number, containerWidth: number, duration: number): number {
  if (containerWidth === 0 || duration === 0) return 0
  return clamp((px / containerWidth) * duration, 0, duration)
}

/** Convert time in seconds to pixel offset on timeline */
export function timeToPixel(time: number, containerWidth: number, duration: number): number {
  if (duration === 0) return 0
  return (time / duration) * containerWidth
}

/** Generate a unique segment id */
export function newId(): string {
  return crypto.randomUUID()
}

/**
 * Pick a segment color, avoiding any colors currently in use. Falls back to
 * cycling through the palette if every color is already taken (more than 8
 * segments). Keying off used-set instead of segment count keeps the next-added
 * segment visually distinct after a delete-then-add sequence.
 */
export function pickColor(existingColors: readonly string[]): string {
  const used = new Set(existingColors)
  return (
    SEGMENT_COLORS.find(c => !used.has(c)) ??
    SEGMENT_COLORS[existingColors.length % SEGMENT_COLORS.length]
  )
}

// Characters Windows forbids in filenames + path separators. Mirrors the Rust
// `ILLEGAL_FILENAME_CHARS` constant in ffmpeg.rs so the preview matches the
// actual on-disk filename produced by the backend.
const ILLEGAL_FILENAME_RE = /[/\\:|<>?*"\x00-\x1f]/g

/**
 * Expand a filename pattern and sanitize the result the same way the Rust
 * backend does, so the preview in ExportModal exactly matches what lands on
 * disk. Returns `"output"` (+ ext) if the pattern expands to an empty or
 * reserved name rather than throwing.
 *
 * Substitutions: {original} → stem, {n} → 1-based index (string)
 */
export function expandFilename(
  pattern: string,
  originalStem: string,
  index: number,
  ext: string,
): string {
  const raw = pattern
    .replace(/\{original\}/g, originalStem)
    .replace(/\{n\}/g, String(index))

  const sanitized = raw.replace(ILLEGAL_FILENAME_RE, '_')
  const trimmed = sanitized.trim().replace(/\.+$/, '')

  if (!trimmed || trimmed === '.' || trimmed === '..') {
    return 'output' + ext
  }
  return trimmed + ext
}

// ── Tiny localStorage helpers ────────────────────────────────────────────────
// Swallow exceptions (Safari private mode, disabled storage, quota errors)
// and normalize the "0"/"1" boolean encoding used across the app.

export function loadBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v === '1') return true
    if (v === '0') return false
    return fallback
  } catch {
    return fallback
  }
}

export function saveBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    /* storage unavailable — preference won't persist this session */
  }
}
