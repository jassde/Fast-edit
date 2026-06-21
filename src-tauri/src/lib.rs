mod ffmpeg;
mod mangofetch;
mod paths;
mod project;

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

            // Initialise the configurable Fast-edit root FIRST — mangofetch's
            // temp dir derives from it.
            let app_paths = paths::init_state(&app.handle());
            let root = app_paths.fast_edit_root.clone();
            app.manage(Mutex::new(app_paths));

            // Initialise mangofetch state: detect the binary on PATH (or in
            // ~/.cargo/bin) and use the Fast-edit root for the Temp dir.
            let mangofetch_state = mangofetch::init_state(&root);
            app.manage(Mutex::new(mangofetch_state));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ffmpeg::export_segments,
            ffmpeg::pick_output_dir,
            ffmpeg::get_hw_support,
            mangofetch::get_mangofetch_config,
            mangofetch::install_mangofetch,
            mangofetch::update_mangofetch,
            mangofetch::download_video,
            mangofetch::get_temp_dir,
            mangofetch::clear_temp_dir,
            project::default_save_dir,
            project::save_project,
            project::load_project,
            paths::get_fast_edit_root,
            paths::set_fast_edit_root,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
