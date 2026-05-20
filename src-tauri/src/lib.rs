mod ffmpeg;
mod context_menu;

use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

/// Initial CLI argument captured at process start. Only set if argv[1] looks
/// like a supported video path. The frontend reads this once on mount via
/// `take_launch_file` and clears it.
struct LaunchArg(Mutex<Option<String>>);

fn looks_like_video_path(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    [".mp4", ".webm", ".mkv", ".mov"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

#[tauri::command]
fn take_launch_file(state: State<'_, LaunchArg>) -> Option<String> {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).take()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Capture this process's launch path before Tauri does anything else; the
    // single-instance plugin will handle subsequent invocations via the
    // callback below.
    let initial_arg = std::env::args()
        .nth(1)
        .filter(|a| looks_like_video_path(a));

    tauri::Builder::default()
        // Single-instance plugin must be registered FIRST, per its own docs:
        // it intercepts secondary launches before any other plugin runs.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second instance was launched (e.g. user picked "Edit with..."
            // on a new file while the app was already open). Forward the path
            // and bring the existing window to front.
            if let Some(file) = args.into_iter().nth(1).filter(|a| looks_like_video_path(a)) {
                let _ = app.emit("launch-file", file);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_libmpv::init())
        .manage(Mutex::new(ffmpeg::FfmpegState::default()))
        .manage(LaunchArg(Mutex::new(initial_arg)))
        .setup(|app| {
            // Resolve ffmpeg path at startup so export commands don't need to search at runtime.
            let res_dir = app.path().resource_dir().unwrap_or_default();
            if let Ok(path) = ffmpeg::find_ffmpeg(&res_dir) {
                // Probe HW encoder support once now, while we have the path —
                // the frontend Settings modal queries this to know which
                // encoder options to enable.
                let hw_support = ffmpeg::probe_hw_support(&path);
                // Tolerate a poisoned mutex: we're the only writer here, so there's
                // no real risk of inconsistent state.
                let state = app.state::<Mutex<ffmpeg::FfmpegState>>();
                let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
                guard.ffmpeg_path = Some(path);
                guard.hw_support  = hw_support;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ffmpeg::export_segments,
            ffmpeg::pick_output_dir,
            ffmpeg::get_hw_support,
            context_menu::register_context_menu,
            context_menu::unregister_context_menu,
            context_menu::context_menu_status,
            take_launch_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
