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

// mangofetch downloader types

/** Quality tier passed to `mangofetch download -q`. `best` omits the flag. */
export type MangofetchQuality = 'best' | '1080p' | '720p' | '480p' | '360p' | 'audio'

/** Coarse phase tag emitted by the Rust backend; mangofetch CLI does not
    expose per-chunk progress so we show an indeterminate bar between phases. */
export type MangofetchProgress = {
  phase: 'fetching' | 'downloading' | 'muxing' | 'done'
}

/** Phases emitted by `update_mangofetch` for the background-update indicator. */
export type MangofetchUpdate =
  | { phase: 'running' }
  | { phase: 'done' }
  | { phase: 'error'; message: string }

/** Phases emitted by `install_mangofetch` while `cargo install mangofetch` runs.
    `cargoMissing` means the user has no Rust toolchain — we surface a rustup link. */
export type MangofetchInstall =
  | { phase: 'running' }
  | { phase: 'done' }
  | { phase: 'cargoMissing' }
  | { phase: 'error'; message: string }

export type MangofetchConfig = {
  installed:      boolean   // false if `mangofetch` was not found on PATH or in ~/.cargo/bin
  mangofetchPath: string    // absolute path; empty if not installed
  tempDir:        string    // absolute path to the Temp download folder
}

export type ProjectFile = {
  version: number
  savedAt: string
  filePath: string
  duration: number
  playheadPosition: number
  segments: Segment[]
}
