import { useEffect, useRef, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'

const SUPPORTED_EXTENSIONS = ['mp4', 'webm', 'mkv', 'mov']

/**
 * Listen for drag-and-drop file events on the Tauri webview.
 * Returns whether a drag is currently over the window so the UI can show
 * a drop-target highlight. Only calls `onFileDrop` for supported video
 * file extensions.
 *
 * Uses a ref for `onFileDrop` (mirrors useKeyboard / useWheelSeek) so the
 * Tauri listener is registered once and never torn down on each render —
 * getting/releasing the webview event listener is not free.
 */
export function useFileDrop(onFileDrop: (path: string) => void): boolean {
  const [isDragOver, setIsDragOver] = useState(false)
  const onFileDropRef = useRef(onFileDrop)
  onFileDropRef.current = onFileDrop

  useEffect(() => {
    let aborted  = false
    let unlisten: (() => void) | null = null

    getCurrentWebview()
      .onDragDropEvent(e => {
        const t = e.payload.type
        if (t === 'enter' || t === 'over') {
          setIsDragOver(true)
        } else if (t === 'leave') {
          setIsDragOver(false)
        } else if (t === 'drop') {
          setIsDragOver(false)
          const paths = e.payload.paths
          if (paths.length === 0) return
          const path = paths[0]
          const ext  = path.split('.').pop()?.toLowerCase() ?? ''
          if (SUPPORTED_EXTENSIONS.includes(ext)) {
            onFileDropRef.current(path)
          }
        }
      })
      .then(ul => {
        if (aborted) ul()
        else unlisten = ul
      })

    return () => {
      aborted = true
      unlisten?.()
    }
  }, []) // registered once; latest onFileDrop is read via ref

  return isDragOver
}
