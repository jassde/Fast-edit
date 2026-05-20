import { useEffect } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'

const SUPPORTED_EXTENSIONS = ['mp4', 'webm', 'mkv', 'mov']

/**
 * Listen for drag-and-drop file events on the Tauri webview.
 * Only calls `onFileDrop` for supported video file extensions.
 */
export function useFileDrop(onFileDrop: (path: string) => void) {
  useEffect(() => {
    // The `aborted` flag handles the unmount-before-subscribe race: if the
    // promise resolves after cleanup, we immediately invoke the unsubscribe
    // instead of leaking the subscription. Same pattern as ExportModal.tsx.
    let aborted  = false
    let unlisten: (() => void) | null = null

    getCurrentWebview()
      .onDragDropEvent(e => {
        if (e.payload.type === 'drop') {
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
}
