mod ffmpeg;
mod project;
mod ytdlp;

use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_libmpv::init())
        .manage(Mutex::new(ffmpeg::FfmpegState::default()))
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

            // Initialise yt-dlp state: loads persisted exe path and resolves the Temp dir.
            let ytdlp_state = ytdlp::init_state(&app.handle());
            app.manage(Mutex::new(ytdlp_state));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ffmpeg::export_segments,
            ffmpeg::pick_output_dir,
            ffmpeg::get_hw_support,
            ytdlp::get_ytdlp_config,
            ytdlp::save_ytdlp_path,
            ytdlp::save_cookie_settings,
            ytdlp::save_temp_dir,
            ytdlp::fetch_formats,
            ytdlp::download_video,
            ytdlp::get_temp_dir,
            ytdlp::clear_temp_dir,
            project::default_save_dir,
            project::save_project,
            project::load_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
