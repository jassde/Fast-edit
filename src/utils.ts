import {
  SEGMENT_COLORS,
  MIN_TIMELINE_ZOOM,
  MAX_TIMELINE_ZOOM,
  DEFAULT_TARGET_VISIBLE_SECONDS,
} from './constants'
import type { Segment } from './types'

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

// ── Source ↔ kept-timeline mapping ───────────────────────────────────────────
// Segments hold SOURCE positions (start, end). The visual timeline lays them
// out cumulatively by duration so the user only sees "kept content" — the
// space between kept ranges is collapsed away. These helpers translate
// between the two.

/** Sort segments by source-start, stable. */
export function sortedByStart(segs: readonly Segment[]): Segment[] {
  return [...segs].sort((a, b) => a.start - b.start)
}

/** Total kept-content duration (sum of per-segment durations). */
export function keptDuration(segs: readonly Segment[]): number {
  let t = 0
  for (const s of segs) t += s.end - s.start
  return t
}

/**
 * Kept-time offset of the start of segment `index` in a sorted segment list.
 * O(n). The caller passes a pre-sorted list so this stays cheap on the hot path.
 */
export function keptOffsetOfSegment(sorted: readonly Segment[], index: number): number {
  let t = 0
  for (let i = 0; i < index; i++) t += sorted[i].end - sorted[i].start
  return t
}

/**
 * Map a SOURCE time to the corresponding kept-timeline time. Returns null when
 * the source time falls in a gap (a deleted region). Sorted segments required.
 */
export function sourceToKept(srcT: number, sorted: readonly Segment[]): number | null {
  let acc = 0
  for (const s of sorted) {
    if (srcT >= s.start && srcT <= s.end) return acc + (srcT - s.start)
    acc += s.end - s.start
  }
  return null
}

/**
 * Map a kept-timeline time to the corresponding SOURCE time plus the id of the
 * segment that owns it. Clamps to the nearest segment edge if `keptT` falls
 * outside the kept range.
 */
export function keptToSource(
  keptT: number,
  sorted: readonly Segment[],
): { sourceT: number; clipId: string } | null {
  if (sorted.length === 0) return null
  let acc = 0
  for (const s of sorted) {
    const d = s.end - s.start
    if (keptT <= acc + d) {
      const rel = Math.max(0, keptT - acc)
      return { sourceT: s.start + rel, clipId: s.id }
    }
    acc += d
  }
  // Past the end: clamp to last segment's end.
  const last = sorted[sorted.length - 1]
  return { sourceT: last.end, clipId: last.id }
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
