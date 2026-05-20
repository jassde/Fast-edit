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
] as const satisfies MpvObservableProperty[]

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
            case 'time-pos':
              a.setPlayheadPosition(data ?? 0)
              break
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
  const play          = useCallback(() => { setProperty('pause', false).catch(console.warn) }, [])
  const pause         = useCallback(() => { setProperty('pause', true ).catch(console.warn) }, [])
  const seek          = useCallback((pos: number) => { command('seek', [pos, 'absolute']).catch(console.warn) }, [])
  const frameStep     = useCallback(() => { command('frame-step').catch(console.warn) }, [])
  const frameBackStep = useCallback(() => { command('frame-back-step').catch(console.warn) }, [])
  const setMute       = useCallback((muted: boolean) => { setProperty('mute', muted).catch(console.warn) }, [])

  return useMemo(
    () => ({ play, pause, seek, frameStep, frameBackStep, setMute }),
    [play, pause, seek, frameStep, frameBackStep, setMute],
  )
}
