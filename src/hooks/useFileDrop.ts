import { useEffect, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'

const SUPPORTED_EXTENSIONS = ['mp4', 'webm', 'mkv', 'mov']

/**
 * Listen for drag-and-drop file events on the Tauri webview.
 * Returns whether a drag is currently over the window so the UI can show
 * a drop-target highlight. Only calls `onFileDrop` for supported video
 * file extensions.
 */
export function useFileDrop(onFileDrop: (path: string) => void): boolean {
  const [isDragOver, setIsDragOver] = useState(false)

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
            onFileDrop(path)
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
  }, [onFileDrop])

  return isDragOver
}
