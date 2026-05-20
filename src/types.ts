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

/**
 * Scope of the Explorer right-click menu integration.
 * - `user`: HKCU registration, current user only, no admin needed
 * - `machine`: HKLM registration, all users, requires UAC elevation
 */
export type ContextMenuScope = 'user' | 'machine'

/** Whether the right-click menu verb is currently registered for each scope. */
export type ContextMenuStatus = {
  user:    boolean
  machine: boolean
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

// Panel bounds sent to Rust for child window positioning.
export type PanelBounds = {
  x: number
  y: number
  width: number
  height: number
}

// Tauri event payloads — field names must match Rust struct field names exactly.
export type PlaybackPositionPayload = { position: number }
export type VideoLoadedPayload      = { duration: number }
export type ExportProgressPayload   = { percent: number }
