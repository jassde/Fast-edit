import { useState, useEffect, useMemo, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Segment, ExportMode, CodecMode, Codec, Container, ExportParams, ExportProgressPayload, HwEncoder } from '../types'
import { expandFilename, formatTime } from '../utils'

// ── Props ─────────────────────────────────────────────────────────────────────

type ExportModalProps = {
  filePath: string
  segments: Segment[]
  hwEncoder: HwEncoder
  onClose: () => void
  onExportComplete: () => void
  onExportError: (msg: string) => void
}

// ── Internal form state ───────────────────────────────────────────────────────

type ModalPhase = 'form' | 'exporting' | 'error'

type ModalState = {
  phase: ModalPhase
  outputDir: string | null
  exportMode: ExportMode
  codecMode: CodecMode
  codec: Codec
  crf: number
  container: Container
  filenamePattern: string
  progress: number
  error: string | null
}

// Record forces exhaustiveness — adding a new HwEncoder variant becomes a TS error here.
const HW_ENCODER_LONG_LABEL: Record<HwEncoder, string> = {
  auto:  'Auto (best available GPU, falls back to CPU)',
  none:  'Software (CPU)',
  nvenc: 'NVIDIA NVENC',
  qsv:   'Intel Quick Sync',
  amf:   'AMD AMF',
}

function hwEncoderLabel(choice: HwEncoder, crf: number): string {
  if (crf === 0) return 'Software (lossless always uses CPU)'
  return HW_ENCODER_LONG_LABEL[choice]
}

// Video codecs valid for each container. WebM only carries VP9; MP4 is the
// H.26x family; MKV (and "same as source") accept anything we support.
function codecsFor(container: Container): Codec[] {
  switch (container) {
    case 'webm': return ['vp9']
    case 'mp4':  return ['h264', 'h265']
    case 'mkv':
    case 'source':
    default:     return ['h264', 'h265', 'vp9']
  }
}

const CODEC_LABEL: Record<Codec, string> = {
  h264: 'H.264',
  h265: 'H.265',
  vp9:  'VP9',
}

const CONTAINER_LABEL: Record<Container, string> = {
  source: 'Same as source',
  mp4:    'MP4',
  mkv:    'MKV',
  webm:   'WebM',
}

function crfQualityLabel(crf: number): { text: string; color: string } {
  if (crf === 0)  return { text: 'Lossless',            color: 'oklch(0.75 0.18 155)' }
  if (crf <= 14)  return { text: 'Visually lossless',   color: 'oklch(0.72 0.14 155)' }
  if (crf <= 22)  return { text: 'High quality',        color: 'oklch(0.72 0.14 155)' }
  if (crf <= 28)  return { text: 'Good',                color: 'oklch(0.78 0.16 65)' }
  if (crf <= 35)  return { text: 'Fair',                color: 'oklch(0.70 0.16 50)' }
  if (crf <= 45)  return { text: 'Low quality',         color: 'oklch(0.66 0.20 22)' }
  return                  { text: 'Very low',            color: 'oklch(0.60 0.22 22)' }
}

const CONTAINER_EXT: Record<Container, string | null> = {
  source: null,  // resolved against the input extension at render time
  mp4:    '.mp4',
  mkv:    '.mkv',
  webm:   '.webm',
}

/**
 * Resolve `source` to the concrete container implied by the input extension so
 * codec constraints are correct. e.g. an `.mp4` source under "Same as source"
 * must not offer VP9 (VP9-in-MP4 is rejected by ffmpeg's mp4 muxer).
 */
function resolveContainer(container: Container, inputExt: string): Exclude<Container, 'source'> {
  if (container !== 'source') return container
  const ext = inputExt.toLowerCase()
  if (ext === '.mkv')  return 'mkv'
  if (ext === '.webm') return 'webm'
  return 'mp4'  // .mp4 / .mov / unknown → the mp4-family codec set
}

const INITIAL: ModalState = {
  phase: 'form',
  outputDir: null,
  exportMode: 'separate',
  codecMode: 'copy',
  codec: 'h264',
  crf: 23,
  container: 'source',
  filenamePattern: '{original}_segment_{n}',
  progress: 0,
  error: null,
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ExportModal({
  filePath,
  segments,
  hwEncoder,
  onClose,
  onExportComplete,
  onExportError,
}: ExportModalProps) {
  const [s, setS] = useState<ModalState>(INITIAL)

  // Which segments to export. `segments` is stable while the modal is open
  // (it's a separate screen), so initialize once, all-checked — preserving the
  // historical "export everything" default.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(segments.map(seg => seg.id))
  )
  const sortedSegments = useMemo(
    () => [...segments].sort((a, b) => a.start - b.start),
    [segments]
  )
  const chosen = useMemo(
    () => sortedSegments.filter(seg => selectedIds.has(seg.id)),
    [sortedSegments, selectedIds]
  )
  const allSelected = chosen.length === sortedSegments.length && sortedSegments.length > 0

  const toggleSegment = (id: string) =>
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggleAll = () =>
    setSelectedIds(allSelected ? new Set() : new Set(sortedSegments.map(seg => seg.id)))

  // Completion is driven by the export_segments invoke resolving (the
  // authoritative "done" signal), not by a progress event — the last segment can
  // momentarily report 100% before ffmpeg finalizes. This timer lets the bar sit
  // at 100% briefly before the modal closes; it's held in a ref so unmount can
  // clear it and we never call onExportComplete on a torn-down parent.
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Subscribe to export-progress events (bar updates only) while modal is open.
  // The `aborted` flag handles the race where the component unmounts before the
  // async listen() promise resolves.
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let aborted = false

    listen<ExportProgressPayload>('export-progress', e => {
      setS(prev => ({ ...prev, progress: e.payload.percent }))
    }).then(ul => {
      if (aborted) {
        ul()  // Already unmounted — immediately unsubscribe
      } else {
        unlisten = ul
      }
    })

    return () => {
      aborted = true
      unlisten?.()
      if (completionTimerRef.current !== null) clearTimeout(completionTimerRef.current)
    }
  }, [])

  // Escape closes the modal (except mid-export, where Cancel is the only out).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && s.phase !== 'exporting') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, s.phase])

  const handlePickDir = async () => {
    const dir = await invoke<string | null>('pick_output_dir')
    if (dir) setS(prev => ({ ...prev, outputDir: dir }))
  }

  const handleExport = async () => {
    if (!s.outputDir) return
    setS(prev => ({ ...prev, phase: 'exporting', progress: 0, error: null }))

    const params: ExportParams = {
      filePath,
      outputDir: s.outputDir,
      segments: chosen.map(seg => ({ start: seg.start, end: seg.end })),
      exportMode: s.exportMode,
      codecMode: s.codecMode,
      codec: s.codecMode === 'reencode' ? s.codec : undefined,
      crf: s.codecMode === 'reencode' ? s.crf : undefined,
      container: s.container,
      filenamePattern: s.filenamePattern,
      hwEncoder: s.codecMode === 'reencode' ? hwEncoder : undefined,
    }

    try {
      await invoke('export_segments', { params })
      // Export finished — fill the bar, then close after a short beat.
      setS(prev => ({ ...prev, progress: 100 }))
      completionTimerRef.current = setTimeout(() => onExportComplete(), 400)
    } catch (e) {
      const msg = String(e)
      setS(prev => ({ ...prev, phase: 'error', error: msg }))
      onExportError(msg)
    }
  }

  // Output extension follows the chosen container; "same as source" keeps the
  // input file's extension.
  const inputStem = filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? 'video'
  const lastDot = filePath.lastIndexOf('.')
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const inputExt = lastDot > lastSep ? filePath.slice(lastDot) : '.mp4'
  const outExt    = CONTAINER_EXT[s.container] ?? inputExt
  const previewName = expandFilename(s.filenamePattern || '{original}_{n}', inputStem, 1, outExt)

  // Codec choices are constrained by the *resolved* container so "Same as
  // source" on an .mp4 input doesn't offer VP9 (invalid in the mp4 muxer).
  const allowedCodecs = codecsFor(resolveContainer(s.container, inputExt))
  const showRemuxWarning = s.codecMode === 'copy' && s.container !== 'source' && s.container !== 'mkv'
  const crfLabel = crfQualityLabel(s.crf)

  // Change the output container; if re-encoding and the current codec isn't
  // valid for the new (resolved) container, snap it to the first allowed codec.
  const handleContainerChange = (container: Container) => {
    setS(p => {
      const allowed = codecsFor(resolveContainer(container, inputExt))
      const codec = allowed.includes(p.codec) ? p.codec : allowed[0]
      return { ...p, container, codec }
    })
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Export">

        <div className="modal-title">Export Segments</div>

        {/* ── Form phase ── */}
        {s.phase === 'form' && (
          <>
            {/* Output directory */}
            <div className="modal-field">
              <span className="modal-label">Output Directory</span>
              <div className="modal-row">
                <span className="modal-path" style={{ flex: 1 }}>
                  {s.outputDir ?? <em style={{ color: 'var(--text-muted)' }}>Not selected</em>}
                </span>
                <button className="btn" onClick={handlePickDir}>Browse…</button>
              </div>
            </div>

            {/* Segments to export */}
            <div className="modal-field">
              <div className="modal-row" style={{ justifyContent: 'space-between' }}>
                <span className="modal-label">Segments to export</span>
                <button className="btn" onClick={toggleAll} disabled={sortedSegments.length === 0}>
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div className="segment-checklist">
                {sortedSegments.map((seg, i) => (
                  <label key={seg.id} className="segment-checklist-row">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(seg.id)}
                      onChange={() => toggleSegment(seg.id)}
                    />
                    <span className="segment-swatch" style={{ background: seg.color }} />
                    <span>Segment {i + 1}</span>
                    <span className="segment-checklist-time">
                      {formatTime(seg.start)} – {formatTime(seg.end)}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Format / container */}
            <div className="modal-field">
              <span className="modal-label">Format</span>
              <select
                className="modal-select"
                value={s.container}
                onChange={e => handleContainerChange(e.target.value as Container)}
              >
                {(['source', 'mp4', 'mkv', 'webm'] as Container[]).map(c => (
                  <option key={c} value={c}>{CONTAINER_LABEL[c]}</option>
                ))}
              </select>
              {showRemuxWarning && (
                <span className="modal-hint">
                  Stream copy into {CONTAINER_LABEL[s.container]} only works if the source codecs
                  fit this container, otherwise the export will fail. MKV accepts anything.
                </span>
              )}
            </div>

            {/* Export mode */}
            <div className="modal-field">
              <span className="modal-label">Export Mode</span>
              <div className="modal-radio-group">
                <label>
                  <input type="radio" name="exportMode" value="separate"
                    checked={s.exportMode === 'separate'}
                    onChange={() => setS(p => ({ ...p, exportMode: 'separate' }))} />
                  Separate files
                </label>
                <label>
                  <input type="radio" name="exportMode" value="merge"
                    checked={s.exportMode === 'merge'}
                    onChange={() => setS(p => ({ ...p, exportMode: 'merge' }))} />
                  Merge into one
                </label>
              </div>
            </div>

            {/* Codec mode */}
            <div className="modal-field">
              <span className="modal-label">Encoding</span>
              <div className="modal-radio-group">
                <label>
                  <input type="radio" name="codecMode" value="copy"
                    checked={s.codecMode === 'copy'}
                    onChange={() => setS(p => ({ ...p, codecMode: 'copy' }))} />
                  Stream copy (fast)
                </label>
                <label>
                  <input type="radio" name="codecMode" value="reencode"
                    checked={s.codecMode === 'reencode'}
                    onChange={() => setS(p => ({ ...p, codecMode: 'reencode' }))} />
                  Re-encode (frame-accurate)
                </label>
              </div>

              {/* Re-encode options */}
              {s.codecMode === 'reencode' && (
                <>
                  <div className="modal-row" style={{ marginTop: 8, gap: 12 }}>
                    <div>
                      <span className="modal-label" style={{ display: 'block', marginBottom: 4 }}>Codec</span>
                      <select className="modal-select" value={s.codec}
                        onChange={e => setS(p => ({ ...p, codec: e.target.value as Codec }))}>
                        {allowedCodecs.map(c => (
                          <option key={c} value={c}>{CODEC_LABEL[c]}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* CRF quality slider */}
                  <div style={{ marginTop: 10 }}>
                    <span className="modal-label" style={{ display: 'block', marginBottom: 4 }}>
                      Quality (CRF {s.crf})
                      <span
                        className="crf-quality-label"
                        style={{ background: `color-mix(in oklch, ${crfLabel.color} 18%, transparent)`, color: crfLabel.color }}
                      >
                        {crfLabel.text}
                      </span>
                    </span>
                    <div className="settings-slider-row" style={{ marginTop: 0 }}>
                      <span className="settings-slider-bound">0</span>
                      <input
                        type="range"
                        className="settings-slider"
                        min={0}
                        max={51}
                        step={1}
                        value={s.crf}
                        onChange={e => setS(p => ({ ...p, crf: Number(e.target.value) }))}
                        aria-label="CRF quality"
                      />
                      <span className="settings-slider-bound">51</span>
                    </div>
                    <div className="crf-marks">
                      <span>lossless</span>
                      <span>default</span>
                      <span>smallest</span>
                    </div>
                  </div>

                  <span className="modal-hint">
                    Encoder: {hwEncoderLabel(hwEncoder, s.crf)}. Change in Settings.
                  </span>
                </>
              )}
            </div>

            {/* Filename pattern */}
            <div className="modal-field">
              <span className="modal-label">Filename Pattern</span>
              <input
                className="modal-input"
                type="text"
                value={s.filenamePattern}
                onChange={e => setS(p => ({ ...p, filenamePattern: e.target.value }))}
                placeholder="{original}_segment_{n}"
              />
              <span className="modal-hint">
                Preview: <code>{previewName}</code>
              </span>
            </div>

            {/* Footer */}
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={!s.outputDir || chosen.length === 0}
                onClick={handleExport}
              >
                Export {chosen.length} segment{chosen.length !== 1 ? 's' : ''}
              </button>
            </div>
          </>
        )}

        {/* ── Exporting phase ── */}
        {s.phase === 'exporting' && (
          <div className="modal-progress">
            <div className="modal-progress-row">
              <span>Exporting…</span>
              <span>{Math.round(s.progress)}%</span>
            </div>
            <div className="progress-bar-track">
              <div className="progress-bar-fill" style={{ width: `${s.progress}%` }} />
            </div>
          </div>
        )}

        {/* ── Error phase ── */}
        {s.phase === 'error' && (
          <>
            <div className="modal-error">{s.error}</div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Close</button>
              <button className="btn btn-primary"
                onClick={() => setS(p => ({ ...p, phase: 'form', error: null }))}>
                Retry
              </button>
            </div>
          </>
        )}

      </div>
    </div>
  )
}
