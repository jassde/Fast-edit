// Shared TypeScript types — single source of truth for all components and hooks.

export type Segment = {
  id: string       // crypto.randomUUID()
  start: number    // seconds (float)
  end: number      // seconds (float)
  color: string    // hex string from SEGMENT_COLORS palette
}

export type ExportMode = 'separate' | 'merge'
export type CodecMode  = 'copy' | 'reencode'
export type Codec      = 'h264' | 'h265' | 'vp9'

/** Output container. `source` keeps the input's container/extension. */
export type Container  = 'source' | 'mp4' | 'mkv' | 'webm'

/**
 * Hardware encoder choice. `none` forces software (libx264/libx265/libvpx-vp9).
 * `auto` picks the best available based on probed HwSupport, with priority
 * NVENC > QSV > AMF. CRF 0 (lossless) always uses software regardless.
 */
export type HwEncoder = 'none' | 'auto' | 'nvenc' | 'qsv' | 'amf'

/** Which HW encoder families this build of ffmpeg has compiled in. */
export type HwSupport = {
  nvenc: boolean
  qsv:   boolean
  amf:   boolean
}

export type ExportParams = {
  filePath: string
  outputDir: string
  segments: Array<{ start: number; end: number }>
  exportMode: ExportMode
  codecMode: CodecMode
  codec?: Codec
  crf?: number
  container?: Container
  filenamePattern: string
  hwEncoder?: HwEncoder
}

// Tauri event payload — field names must match the Rust struct fields exactly.
export type ExportProgressPayload = { percent: number }

// yt-dlp downloader types
export type CookieSource =
  | { type: 'none' }
  | { type: 'browser'; browser: string; profile: string }
  | { type: 'file';    path: string }

export type VideoFormat = {
  formatId: string       // raw yt-dlp format ID or sentinel like "best"/"audio"
  label: string          // human-readable compact label
  ytdlpSelector: string  // yt-dlp format selector passed to -f
  hasVideo: boolean
  hasAudio: boolean
  // metadata columns for the format table (empty string when not applicable)
  resolution:   string   // e.g. "1920×1080" or "720p"
  fps:          string   // e.g. "60" or ""
  codec:        string   // e.g. "av1", "avc1", "vp09"
  filesize:     string   // e.g. "150 MB", "~80 MB" or ""
  dynamicRange: string   // e.g. "SDR", "HDR10", "HLG" or ""
  ext:          string   // container extension e.g. "webm", "mp4"
  sampleRate:   string   // audio sample rate, e.g. "48000 Hz" or ""
}

export type YtdlpProgress = {
  percent: number  // 0–100
  speed: string    // e.g. "1.23MiB/s"
  eta: string      // e.g. "00:45"
}

export type ProjectFile = {
  version: number
  savedAt: string
  filePath: string
  duration: number
  playheadPosition: number
  segments: Segment[]
}

export type YtdlpConfig = {
  ytdlpPath:    string        // absolute path to yt-dlp.exe; empty string if not set
  tempDir:      string        // absolute path to the Temp download folder
  cookieSource: CookieSource
}
