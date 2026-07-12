mod args;
mod process;
mod temp;
mod types;

pub use process::probe_hw_support;
pub use types::{FfmpegState, HwSupport};

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State};

use args::{build_merge_args, build_segment_args};
use process::run_ffmpeg_with_progress;
use temp::{expand_filename, TempCleanup};
use types::{Codec, CodecMode, Container, ExportMode, ExportParams, ExportProgressPayload};

/// Returns the path to the bundled `ffmpeg.exe`.
///
/// Search order:
///   1. `<app_dir>/ffmpeg/bin/ffmpeg.exe` — resource_dir (production bundle)
///   2. Walk up from the current exe — covers dev mode where the project's
///      `ffmpeg/bin/ffmpeg.exe` is several directories above the debug binary.
pub fn find_ffmpeg(app_dir: &Path) -> Result<PathBuf, String> {
    let bundled = app_dir.join("ffmpeg").join("bin").join("ffmpeg.exe");
    if bundled.exists() {
        return Ok(bundled);
    }

    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(Path::to_path_buf);
        while let Some(d) = dir {
            let candidate = d.join("ffmpeg").join("bin").join("ffmpeg.exe");
            if candidate.exists() {
                return Ok(candidate);
            }
            let candidate_flat = d.join("ffmpeg").join("ffmpeg.exe");
            if candidate_flat.exists() {
                return Ok(candidate_flat);
            }
            dir = d.parent().map(Path::to_path_buf);
        }
    }

    eprintln!(
        "ffmpeg not found. Searched: {} (and parent directories of the current exe).",
        bundled.display()
    );
    Err("ffmpeg not found. See README for setup instructions.".to_string())
}

/// Remove Windows' `\\?\` verbatim prefix. Returns the input unchanged on
/// non-Windows platforms or when no prefix is present.
fn strip_unc_prefix(p: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            // Don't strip the longer UNC form `\\?\UNC\…` — that one needs the
            // prefix to remain a valid network path.
            if !rest.starts_with("UNC\\") {
                return PathBuf::from(rest.to_string());
            }
        }
    }
    p.to_path_buf()
}

fn run_export(
    ffmpeg_path: &Path,
    hw_support: &HwSupport,
    params: &ExportParams,
    app: &AppHandle,
) -> Result<(), String> {
    let input_path = Path::new(&params.file_path);
    let stem = input_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let source_ext = input_path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_else(|| ".mp4".to_string());

    let container = params.container.unwrap_or(Container::Source);
    let out_ext   = container.extension(&source_ext);

    // Defense-in-depth codec/container compatibility check.
    if params.codec_mode == CodecMode::Reencode {
        let lo        = out_ext.to_ascii_lowercase();
        let is_mp4ish = lo == ".mp4" || lo == ".mov" || lo == ".m4v";
        let codec     = params.codec.clone().unwrap_or(Codec::H264);
        match codec {
            Codec::Vp9 if is_mp4ish => {
                return Err(
                    "VP9 can't be stored in an MP4/MOV container. \
                     Choose MKV or WebM as the format, or pick a different codec."
                        .to_string(),
                );
            }
            Codec::H264 | Codec::H265 if lo == ".webm" => {
                return Err(
                    "WebM only supports VP9 video. \
                     Choose MKV or MP4 as the format, or switch the codec to VP9."
                        .to_string(),
                );
            }
            _ => {}
        }
    }

    // Canonicalise and verify the output directory before doing any work.
    // Strip Windows' \\?\ verbatim prefix that `canonicalize` adds — some ffmpeg
    // builds (and the concat demuxer) choke on UNC-style paths.
    let canon = Path::new(&params.output_dir)
        .canonicalize()
        .map_err(|e| format!("Output directory invalid: {e}"))?;
    let output_dir = strip_unc_prefix(&canon);
    if !output_dir.is_dir() {
        return Err(format!(
            "Output path is not a directory: {}",
            output_dir.display()
        ));
    }

    let total_segs = params.segments.len();

    if params.export_mode == ExportMode::Separate {
        for (i, seg) in params.segments.iter().enumerate() {
            let filename = expand_filename(&params.filename_pattern, &stem, i + 1, &out_ext)?;
            let output   = output_dir.join(&filename);
            let args     = build_segment_args(
                &params.file_path,
                &output.to_string_lossy(),
                seg,
                params,
                &source_ext,
                hw_support,
            );
            run_ffmpeg_with_progress(
                ffmpeg_path,
                &args,
                seg.end - seg.start,
                i,
                total_segs,
                app,
            )?;
        }
        let _ = app.emit("export-progress", ExportProgressPayload { percent: 100.0 });
        return Ok(());
    }

    // --- Merge mode ---
    let mut cleanup = TempCleanup::new();
    let tmp_ext: String = out_ext.clone();
    let mut temp_files: Vec<PathBuf> = Vec::new();

    for (i, seg) in params.segments.iter().enumerate() {
        let tmp_name = format!("__trimmer_seg_{i}{tmp_ext}");
        let tmp_path = output_dir.join(&tmp_name);
        cleanup.track(tmp_path.clone());
        let args     = build_segment_args(
            &params.file_path,
            &tmp_path.to_string_lossy(),
            seg,
            params,
            &source_ext,
            hw_support,
        );
        run_ffmpeg_with_progress(
            ffmpeg_path,
            &args,
            seg.end - seg.start,
            i,
            total_segs + 1,
            app,
        )?;
        temp_files.push(tmp_path);
    }

    // ffmpeg's concat demuxer treats backslashes inside `'...'` as escape
    // characters, so Windows paths break unless we use forward slashes; and
    // single quotes inside the path must be escaped as `'\''`.
    let list_path = output_dir.join("__trimmer_concat_list.txt");
    cleanup.track(list_path.clone());
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&list_path)
            .map_err(|e| format!("Failed to create concat list: {e}"))?;
        for p in &temp_files {
            let escaped = p.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
            writeln!(f, "file '{escaped}'")
                .map_err(|e| format!("Write error: {e}"))?;
        }
    }

    let merged_name = expand_filename(&params.filename_pattern, &stem, 1, &out_ext)?;
    let merged_out  = output_dir.join(&merged_name);
    let merge_args  = build_merge_args(
        &list_path.to_string_lossy(),
        &merged_out.to_string_lossy(),
    );
    run_ffmpeg_with_progress(ffmpeg_path, &merge_args, 0.0, total_segs, total_segs + 1, app)?;

    let _ = app.emit("export-progress", ExportProgressPayload { percent: 100.0 });
    Ok(())
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn export_segments(
    params: ExportParams,
    state: State<'_, Mutex<FfmpegState>>,
    app: AppHandle,
) -> Result<(), String> {
    if params.segments.is_empty() {
        return Err("Nothing to export: no segments selected.".to_string());
    }

    for (i, seg) in params.segments.iter().enumerate() {
        let n = i + 1;
        if !seg.start.is_finite() || !seg.end.is_finite() {
            return Err(format!("Segment {n} has a non-finite time value."));
        }
        if seg.start < 0.0 {
            return Err(format!("Segment {n} starts before zero."));
        }
        if seg.end <= seg.start {
            return Err(format!("Segment {n} ends at or before its start."));
        }
        if seg.end - seg.start < 0.001 {
            return Err(format!("Segment {n} is shorter than 1 ms."));
        }
    }

    let (ffmpeg_path, hw_support) = {
        let guard = state.lock().unwrap_or_else(|e| e.into_inner());
        (guard.ffmpeg_path.clone(), guard.hw_support.clone())
    };
    let ffmpeg_path = ffmpeg_path
        .ok_or_else(|| "ffmpeg not found. See README for setup instructions.".to_string())?;

    if !ffmpeg_path.exists() {
        return Err(
            "ffmpeg.exe was located at startup but is no longer present. \
             Please verify the file exists and restart the app."
                .to_string(),
        );
    }

    tauri::async_runtime::spawn_blocking(move || {
        run_export(&ffmpeg_path, &hw_support, &params, &app)
    })
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_hw_support(state: State<'_, Mutex<FfmpegState>>) -> HwSupport {
    state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .hw_support
        .clone()
}

/// Extract `count` evenly-spaced thumbnail frames from `file_path`, running
/// ffmpeg seeks in batches of `MAX_THUMB_WORKERS` so we don't overwhelm the
/// system with dozens of concurrent ffmpeg subprocesses.
fn extract_thumbnails_sync(
    ffmpeg_path: &Path,
    file_path: &str,
    duration: f64,
    count: usize,
) -> Result<Vec<String>, String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use std::process::Stdio;
    use std::sync::Arc;

    const MAX_THUMB_WORKERS: usize = 6;

    if duration <= 0.0 || count == 0 {
        return Ok(vec![]);
    }

    let tmp_dir = std::env::temp_dir().join("fast_edit_thumbs");
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create thumb dir: {e}"))?;

    let ffmpeg_path = Arc::new(ffmpeg_path.to_path_buf());
    let file_path   = Arc::new(file_path.to_string());
    let tmp_dir     = Arc::new(tmp_dir);

    let mut results = vec![String::new(); count];

    for batch_start in (0..count).step_by(MAX_THUMB_WORKERS) {
        let batch_end = (batch_start + MAX_THUMB_WORKERS).min(count);
        let handles: Vec<_> = (batch_start..batch_end)
            .map(|i| {
                let t           = (i as f64 + 0.5) * duration / count as f64;
                let ffmpeg_path = Arc::clone(&ffmpeg_path);
                let file_path   = Arc::clone(&file_path);
                let tmp_dir     = Arc::clone(&tmp_dir);

                std::thread::spawn(move || {
                    let out_path = tmp_dir.join(format!("thumb_{i:03}.jpg"));
                    let mut cmd  = std::process::Command::new(ffmpeg_path.as_ref());
                    cmd.args([
                        "-y",
                        "-ss", &format!("{t:.3}"),
                        "-i", file_path.as_str(),
                        "-vframes", "1",
                        "-vf", "scale=160:-2",
                        "-q:v", "5",
                        "-an",
                    ])
                    .arg(out_path.as_os_str())
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                    process::hide_console(&mut cmd);

                    let ok = cmd.status().map(|s| s.success()).unwrap_or(false);
                    if ok {
                        if let Ok(bytes) = std::fs::read(&out_path) {
                            return (i, format!("data:image/jpeg;base64,{}", STANDARD.encode(&bytes)));
                        }
                    }
                    (i, String::new())
                })
            })
            .collect();

        for handle in handles {
            if let Ok((i, data)) = handle.join() {
                results[i] = data;
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub async fn generate_thumbnails(
    file_path: String,
    duration: f64,
    count: usize,
    state: State<'_, Mutex<FfmpegState>>,
) -> Result<Vec<String>, String> {
    let count = count.clamp(1, 60);
    let ffmpeg_path = {
        let guard = state.lock().unwrap_or_else(|e| e.into_inner());
        guard.ffmpeg_path.clone()
    };
    let ffmpeg_path = ffmpeg_path
        .ok_or_else(|| "ffmpeg not found".to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        extract_thumbnails_sync(&ffmpeg_path, &file_path, duration, count)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pick_output_dir(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let folder = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;

    // Use into_path() rather than to_string() — on some platforms FilePath's
    // Display/ToString gives a URI ("file:///…") instead of a filesystem path.
    let path = folder
        .map(|p| p.into_path().map(|pb| pb.to_string_lossy().into_owned()))
        .transpose()
        .map_err(|e| e.to_string())?;
    Ok(path)
}
