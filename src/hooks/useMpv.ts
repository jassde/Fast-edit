import { useEffect, useRef, useCallback, useMemo, useState, RefObject } from 'react'
import {
  init,
  observeProperties,
  command,
  setProperty,
  setVideoMarginRatio,
  type MpvObservableProperty,
  type MpvConfig,
} from 'tauri-plugin-libmpv-api'
import { AppActions } from './useAppState'

// ── Properties observed via the libmpv plugin ────────────────────────────────
// The third element 'none' marks values that can be null (e.g. before any file
// has been loaded), giving us narrowed types in the callback below.

const OBSERVED_PROPERTIES = [
  ['time-pos',     'double', 'none'],
  ['duration',     'double', 'none'],
  ['pause',        'flag'],
  ['eof-reached',  'flag',   'none'],
  ['mute',         'flag'],
  ['container-fps', 'double', 'none'],
  ['width',        'int64',  'none'],
  ['height',       'int64',  'none'],
] as const satisfies MpvObservableProperty[]

// Build the `video-crop` value (`WxH+x+y`) for a zoom-in of `scale`× panned by
// (panX, panY), each a fraction in [-1, 1] where 0 is centred and ±1 pins the
// crop to a frame edge. Crop out the middle `1/scale` of the frame and offset
// it by the pan fraction; mpv rescales that crop to fill the #video-panel rect.
// Because the output is the panel-sized crop (not an enlarged frame), it can
// never paint outside the panel — dragging moves which part of the frame shows,
// not where the video sits on screen. The pan sign is inverted so the content
// follows the cursor (drag right → reveal the left of the frame).
function zoomCrop(w: number, h: number, scale: number, panX: number, panY: number): string {
  const cw = Math.max(2, Math.round(w / scale))
  const ch = Math.max(2, Math.round(h / scale))
  const maxX = w - cw           // total horizontal travel available (px)
  const maxY = h - ch
  const cx = Math.min(maxX, Math.max(0, Math.round((maxX / 2) * (1 - panX))))
  const cy = Math.min(maxY, Math.max(0, Math.round((maxY / 2) * (1 - panY))))
  return `${cw}x${ch}+${cx}+${cy}`
}

const MPV_CONFIG: MpvConfig = {
  initialOptions: {
    'vo':           'gpu-next',
    'hwdec':        'auto-safe',
    'keep-open':    'yes',
    'force-window': 'yes',
    'pause':        'yes',     // start paused — UI flips it via setProperty
    'hr-seek':      'yes',     // sub-keyframe seek accuracy for trim points
  },
  observedProperties: OBSERVED_PROPERTIES,
}

/**
 * Manages the libmpv plugin lifecycle:
 *   - init() once on mount, destroy() on unmount
 *   - observe time-pos / duration / pause / eof-reached and push into AppState
 *   - sync `setVideoMarginRatio` from the #video-panel div's bounding rect so
 *     mpv only renders inside that region (the rest of the transparent window
 *     shows the WebView chrome on top)
 *   - call `loadfile` when `filePath` changes
 *
 * Returns the playback command helpers consumed by App and useKeyboard.
 */
export function useMpv(
  actions: AppActions,
  videoPanelRef: RefObject<HTMLDivElement | null>,
  filePath: string | null,
) {
  const [initialized, setInitialized] = useState(false)

  // Stable ref so the init effect doesn't redo work when actions identity
  // changes (mirrors the pattern used in useKeyboard).
  const actionsRef = useRef(actions)
  actionsRef.current = actions

  // Current video pixel size and applied scale — read by setScale (which needs
  // real dimensions to compute the centred crop) and re-applied whenever the
  // dimensions change (new file / aspect switch), since the crop is in pixels.
  const dimsRef  = useRef({ w: 0, h: 0 })
  const scaleRef = useRef(1)
  const panRef   = useRef({ x: 0, y: 0 })
  const applyPlacementRef = useRef<() => void>(() => {})

  // ── Pending-seek guard ────────────────────────────────────────────────
  // When we issue a `seek`, mpv may take a while to process it — especially
  // for backward seeks on long videos with sparse keyframes, where mpv has to
  // seek to the prior keyframe (potentially many seconds earlier) and decode
  // forward to the exact target under `hr-seek=yes`. During that window the
  // plugin can emit intermediate `time-pos` values (pre-seek position, or
  // keyframe-decode progress), which would clobber our caller's optimistic
  // playhead update with stale data.
  //
  // Strategy: track the requested seek target. For every time-pos report:
  //   - within `SEEK_CONVERGE_TOL` of target → mpv arrived, clear the guard
  //   - past hard cap `SEEK_GUARD_MAX_MS` → assume stuck, clear and accept
  //     (so the UI never freezes on a phantom position from a truly failed seek)
  //   - otherwise → stale report; drop it AND extend the soft deadline so the
  //     guard stays armed as long as mpv is making progress (or emitting
  //     anything at all). The soft deadline also catches silence — if mpv stops
  //     emitting for `SEEK_GUARD_EXTEND_MS`, we accept the next event whatever
  //     it is.
  const pendingSeekRef = useRef<{ target: number; armedAt: number; until: number } | null>(null)
  const SEEK_GUARD_EXTEND_MS = 800   // bump deadline this far on each stale report
  const SEEK_GUARD_MAX_MS    = 8000  // absolute cap — handles multi-second hr-seeks on 1hr+ files
  const SEEK_CONVERGE_TOL    = 0.05  // seconds; "we got there" threshold

  // ── Init mpv once, observe properties ─────────────────────────────────
  // The plugin's init() is idempotent — calling it for a window that already
  // has an instance is a no-op success. So in StrictMode dev the second mount
  // just re-uses the instance from the first mount. We never call destroy()
  // here; the plugin tears down via WindowEvent::CloseRequested. (Calling
  // destroy() in cleanup races with in-flight commands like loadfile.)
  useEffect(() => {
    let cancelled  = false
    let unobserve: (() => void) | null = null

    ;(async () => {
      try {
        await init(MPV_CONFIG)
        if (cancelled) return

        const ul = await observeProperties(OBSERVED_PROPERTIES, ({ name, data }) => {
          const a = actionsRef.current
          switch (name) {
            case 'time-pos': {
              const pos = data ?? 0
              const pending = pendingSeekRef.current
              if (pending) {
                const now = Date.now()
                if (Math.abs(pos - pending.target) <= SEEK_CONVERGE_TOL) {
                  // mpv arrived at the target — accept and disarm.
                  pendingSeekRef.current = null
                } else if (now - pending.armedAt > SEEK_GUARD_MAX_MS) {
                  // Hard cap — assume the seek stalled or was preempted.
                  // Accept whatever mpv last reported so the UI doesn't freeze.
                  pendingSeekRef.current = null
                } else if (now > pending.until) {
                  // Soft deadline expired with no progress signal. Accept this
                  // report (a non-converged but recent update is better than
                  // refusing forever).
                  pendingSeekRef.current = null
                } else {
                  // Still pending — extend the soft deadline so we keep waiting
                  // as long as mpv is emitting (even if not yet converged).
                  pending.until = now + SEEK_GUARD_EXTEND_MS
                  break  // drop this stale report
                }
              }
              a.setPlayheadPosition(pos)
              break
            }
            case 'duration':
              if (data && data > 0) a.setDuration(data)
              break
            case 'pause':
              // pause === true → not playing
              a.setIsPlaying(!data)
              break
            case 'eof-reached':
              if (data) a.setIsPlaying(false)
              break
            case 'mute':
              a.setIsMuted(!!data)
              break
            case 'container-fps':
              if (data && data > 0) a.setFps(data)
              break
            case 'width':
              if (data && data > 0) { dimsRef.current.w = data; applyPlacementRef.current() }
              break
            case 'height':
              if (data && data > 0) { dimsRef.current.h = data; applyPlacementRef.current() }
              break
          }
        })

        if (cancelled) {
          ul()
          return
        }

        unobserve = ul
        setInitialized(true)
      } catch (e) {
        actionsRef.current.setMpvError(
          `Failed to initialize mpv: ${e}\n\n` +
          'Make sure libmpv-2.dll and libmpv-wrapper.dll are present in src-tauri/lib/. ' +
          'Run: npx tauri-plugin-libmpv-api setup-lib'
        )
      }
    })()

    return () => {
      cancelled = true
      unobserve?.()
    }
  }, [])

  // ── Constrain mpv's render rect to the #video-panel div ──────────────
  // The window is transparent; mpv paints behind the WebView. Margin ratios
  // tell mpv how much of each edge to leave un-rendered, so the video
  // appears exactly where #video-panel is.
  useEffect(() => {
    if (!initialized) return
    const panel = videoPanelRef.current
    if (!panel) return

    let rafId = 0
    const update = () => {
      const r = panel.getBoundingClientRect()
      const w = window.innerWidth
      const h = window.innerHeight
      if (w === 0 || h === 0) return
      setVideoMarginRatio({
        left:   Math.max(0, r.left / w),
        right:  Math.max(0, 1 - (r.right / w)),
        top:    Math.max(0, r.top / h),
        bottom: Math.max(0, 1 - (r.bottom / h)),
      }).catch(() => {/* non-fatal */})
    }
    const schedule = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(update)
    }

    schedule()
    const ro = new ResizeObserver(schedule)
    ro.observe(panel)
    window.addEventListener('resize', schedule)

    return () => {
      cancelAnimationFrame(rafId)
      ro.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [initialized, videoPanelRef])

  // ── Load file when filePath changes (and after init) ─────────────────
  useEffect(() => {
    if (!initialized || !filePath) return
    command('loadfile', [filePath]).catch(e =>
      actionsRef.current.setMpvError(`Failed to load file: ${e}`)
    )
  }, [initialized, filePath])

  // ── Playback command helpers (stable identities) ─────────────────────
  const play          = useCallback(() => { setProperty('pause', false).catch(console.error) }, [])
  const pause         = useCallback(() => { setProperty('pause', true ).catch(console.error) }, [])
  const seek          = useCallback((pos: number) => {
    // Arm the pending-seek guard BEFORE dispatching the command so any
    // in-flight stale time-pos events arriving between now and seek completion
    // are filtered out (see pendingSeekRef comment above).
    const now = Date.now()
    pendingSeekRef.current = {
      target:  pos,
      armedAt: now,
      until:   now + SEEK_GUARD_EXTEND_MS,
    }
    command('seek', [pos, 'absolute']).catch(console.error)
  }, [])
  const frameStep     = useCallback(() => { command('frame-step').catch(console.error) }, [])
  const frameBackStep = useCallback(() => { command('frame-back-step').catch(console.error) }, [])
  const setMute       = useCallback((muted: boolean) => { setProperty('mute', muted).catch(console.error) }, [])
  const setSpeed      = useCallback((v: number) => { setProperty('speed', v).catch(console.error) }, [])
  // Apply the current scale + pan (from refs) without letting the video spill
  // outside the #video-panel rect.
  //   scale > 1 (zoom in): use `video-crop` — crop a `1/scale` window of the
  //     frame, offset by the pan fraction, and let mpv rescale that crop to fill
  //     the panel. The output is panel-sized, so it can never paint over the
  //     surrounding UI, and dragging pans within the frame instead of moving the
  //     whole video off-panel (which is what video-pan-x/y did).
  //   scale ≤ 1 (shrink / 1:1): `video-zoom` (log2 scale) keeps the video inside
  //     the panel; there's no hidden frame to pan into, so pan is a no-op.
  const applyPlacement = useCallback(() => {
    const { w, h } = dimsRef.current
    const scale = scaleRef.current
    if (scale > 1 && w > 0 && h > 0) {
      setProperty('video-zoom', 0).catch(console.error)
      setProperty('video-crop', zoomCrop(w, h, scale, panRef.current.x, panRef.current.y)).catch(console.error)
    } else {
      setProperty('video-crop', '').catch(console.error)
      setProperty('video-zoom', Math.log2(scale)).catch(console.error)
    }
  }, [])
  applyPlacementRef.current = applyPlacement
  const setScale      = useCallback((scale: number) => {
    scaleRef.current = scale
    applyPlacement()
  }, [applyPlacement])
  const setPan        = useCallback((x: number, y: number) => {
    panRef.current = { x, y }
    applyPlacement()
  }, [applyPlacement])
  const resetPlacement = useCallback(() => {
    scaleRef.current = 1
    panRef.current = { x: 0, y: 0 }
    setProperty('video-crop', '').catch(console.error)
    setProperty('video-zoom',  0).catch(console.error)
    setProperty('video-pan-x', 0).catch(console.error)
    setProperty('video-pan-y', 0).catch(console.error)
  }, [])

  return useMemo(
    () => ({ play, pause, seek, frameStep, frameBackStep, setMute, setSpeed, setScale, setPan, resetPlacement }),
    [play, pause, seek, frameStep, frameBackStep, setMute, setSpeed, setScale, setPan, resetPlacement],
  )
}
