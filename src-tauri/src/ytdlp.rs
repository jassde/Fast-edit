use std::{
    collections::HashSet,
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

// ── State ─────────────────────────────────────────────────────────────────────

pub struct YtdlpState {
    pub ytdlp_path: Option<PathBuf>,
    pub temp_dir: PathBuf,
}

// ── Config file on disk ───────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default)]
struct YtdlpConfigFile {
    ytdlp_path: Option<String>,
}

fn config_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("ytdlp_config.json"))
}

fn load_config(app: &AppHandle) -> YtdlpConfigFile {
    config_file_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, cfg: &YtdlpConfigFile) -> Result<(), String> {
    let path = config_file_path(app)?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

// ── State initialiser (called from lib.rs setup) ──────────────────────────────

pub fn init_state(app: &AppHandle) -> YtdlpState {
    let cfg = load_config(app);
    let ytdlp_path = cfg.ytdlp_path.map(PathBuf::from);

    let temp_dir = app
        .path()
        .app_local_data_dir()
        .map(|d| d.join("Temp"))
        .unwrap_or_else(|_| PathBuf::from("Temp"));

    YtdlpState { ytdlp_path, temp_dir }
}

// ── Windows: suppress console window ─────────────────────────────────────────

fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

/// Returns the current yt-dlp config (exe path + temp dir path).
#[tauri::command]
pub fn get_ytdlp_config(
    state: State<'_, Mutex<YtdlpState>>,
) -> Result<serde_json::Value, String> {
    let guard = state.lock().unwrap_or_else(|e| e.into_inner());
    Ok(serde_json::json!({
        "ytdlpPath": guard.ytdlp_path.as_deref()
            .and_then(|p| p.to_str())
            .unwrap_or(""),
        "tempDir": guard.temp_dir.to_string_lossy(),
    }))
}

/// Validates and persists a new yt-dlp.exe path, then updates running state.
///
/// Validation order: file exists → responds to `--version` → write to disk →
/// update state. This ensures in-memory state is only changed when the full
/// save succeeds; a disk-write failure leaves the previous value intact.
#[tauri::command]
pub fn save_ytdlp_path(
    path: String,
    state: State<'_, Mutex<YtdlpState>>,
    app: AppHandle,
) -> Result<(), String> {
    let new_path = PathBuf::from(&path);
    if !new_path.exists() {
        return Err(format!("File not found: {path}"));
    }

    // Run `<path> --version` as a quick smoke-test to confirm it's actually
    // yt-dlp (or at least a CLI tool that accepts that flag).
    let mut cmd = Command::new(&new_path);
    cmd.arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("Could not run the file to verify it: {e}"))?;
    if !out.status.success() || String::from_utf8_lossy(&out.stdout).trim().is_empty() {
        return Err(
            "The selected file does not appear to be yt-dlp \
             (it did not respond to --version)."
                .to_string(),
        );
    }

    // Write config to disk BEFORE mutating in-memory state so a disk error
    // leaves the previous value intact.
    save_config(&app, &YtdlpConfigFile { ytdlp_path: Some(path) })?;

    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    guard.ytdlp_path = Some(new_path);
    Ok(())
}

/// Runs `yt-dlp -j <url>` and returns a curated list of quality tiers.
///
/// Moved to `async` and wrapped in `spawn_blocking` so yt-dlp network I/O
/// (which can take 10+ seconds) doesn't park a Tauri IPC worker thread.
#[tauri::command]
pub async fn fetch_formats(
    url: String,
    state: State<'_, Mutex<YtdlpState>>,
) -> Result<Vec<serde_json::Value>, String> {
    let ytdlp = {
        let guard = state.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .ytdlp_path
            .clone()
            .ok_or("yt-dlp path not set. Click the \u{2699} button to configure it.")?
    };

    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&ytdlp);
        // `--` separates flags from the URL, preventing a URL starting with `-`
        // from being parsed as a yt-dlp option (e.g. `--exec`).
        cmd.args(["-j", "--no-playlist", "--", &url])
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        hide_console(&mut cmd);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run yt-dlp: {e}"))?;
        if !output.status.success() {
            return Err(
                "yt-dlp failed to fetch video info. Check the URL and try again.".into(),
            );
        }

        let json: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("JSON parse error: {e}"))?;

        let formats_raw = json["formats"].as_array().cloned().unwrap_or_default();

        let heights: HashSet<u64> = formats_raw
            .iter()
            .filter(|f| f["vcodec"].as_str().map(|c| c != "none").unwrap_or(false))
            .filter_map(|f| f["height"].as_u64())
            .collect();

        let quality_tiers: &[(u64, &str)] = &[
            (2160, "4K Ultra HD"),
            (1440, "1440p QHD"),
            (1080, "1080p Full HD"),
            (720, "720p HD"),
            (480, "480p"),
            (360, "360p"),
        ];

        let mut result: Vec<serde_json::Value> = quality_tiers
            .iter()
            .filter(|(h, _)| heights.contains(h))
            .map(|(h, label)| {
                serde_json::json!({
                    "formatId": format!("{h}p"),
                    "label": format!("{label} ({h}p)"),
                    "ytdlpSelector": format!("bestvideo[height<={h}]+bestaudio/best[height<={h}]"),
                    "hasVideo": true,
                    "hasAudio": true,
                })
            })
            .collect();

        result.push(serde_json::json!({
            "formatId": "audio",
            "label": "Audio only (best quality)",
            "ytdlpSelector": "bestaudio",
            "hasVideo": false,
            "hasAudio": true,
        }));

        if result.len() == 1 {
            result.insert(
                0,
                serde_json::json!({
                    "formatId": "best",
                    "label": "Best available",
                    "ytdlpSelector": "bv*+ba/b",
                    "hasVideo": true,
                    "hasAudio": true,
                }),
            );
        }

        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Downloads the video in the given format, emitting `ytdlp-progress` events.
/// Returns the path of the downloaded file on success.
///
/// The entire blocking I/O section runs inside `spawn_blocking` so the long
/// download doesn't park a Tokio worker. The stderr progress thread is spawned
/// from within `spawn_blocking` — both the OS thread and the Tokio thread are
/// released to do other work while yt-dlp runs.
#[tauri::command]
pub async fn download_video(
    url: String,
    format_selector: String,
    state: State<'_, Mutex<YtdlpState>>,
    app: AppHandle,
) -> Result<String, String> {
    let (ytdlp, temp_dir) = {
        let guard = state.lock().unwrap_or_else(|e| e.into_inner());
        let p = guard
            .ytdlp_path
            .clone()
            .ok_or("yt-dlp path not set. Click the \u{2699} button to configure it.")?;
        (p, guard.temp_dir.clone())
    };

    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&temp_dir).map_err(|e| format!("Cannot create Temp dir: {e}"))?;

        let output_template = temp_dir.join("%(title)s.%(ext)s");
        let output_str = output_template.to_string_lossy().to_string();

        let mut cmd = Command::new(&ytdlp);
        cmd.args([
            "--progress",
            "--newline",
            "--no-playlist",
            "-f",
            &format_selector,
            "-o",
            &output_str,
            "--print",
            "after_move:filepath",
            "--",   // separates flags from the URL
            &url,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        hide_console(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start yt-dlp: {e}"))?;

        let stderr = child.stderr.take()
            .ok_or_else(|| "yt-dlp stderr not available (internal error)".to_string())?;
        let app_clone = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().filter_map(|l| l.ok()) {
                if let Some(pct) = parse_download_percent(&line) {
                    let speed = parse_download_speed(&line).unwrap_or_default();
                    let eta = parse_download_eta(&line).unwrap_or_default();
                    let _ = app_clone.emit(
                        "ytdlp-progress",
                        serde_json::json!({ "percent": pct, "speed": speed, "eta": eta }),
                    );
                }
            }
        });

        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(
                "yt-dlp download failed. Check the URL and format, then try again.".into(),
            );
        }

        let final_path = String::from_utf8_lossy(&output.stdout)
            .trim()
            .lines()
            .last()
            .unwrap_or("")
            .to_string();

        let _ = app.emit(
            "ytdlp-progress",
            serde_json::json!({ "percent": 100.0_f64, "speed": "", "eta": "" }),
        );

        Ok(final_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Returns the absolute path of the Temp download folder.
#[tauri::command]
pub fn get_temp_dir(state: State<'_, Mutex<YtdlpState>>) -> String {
    let guard = state.lock().unwrap_or_else(|e| e.into_inner());
    guard.temp_dir.to_string_lossy().to_string()
}

/// Deletes all files and subdirectories inside the Temp folder (keeps the folder itself).
#[tauri::command]
pub fn clear_temp_dir(state: State<'_, Mutex<YtdlpState>>) -> Result<(), String> {
    let temp_dir = {
        let guard = state.lock().unwrap_or_else(|e| e.into_inner());
        guard.temp_dir.clone()
    };

    if !temp_dir.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(&temp_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file() {
            fs::remove_file(&path)
                .map_err(|e| format!("Could not delete {}: {e}", path.display()))?;
        } else if path.is_dir() {
            fs::remove_dir_all(&path)
                .map_err(|e| format!("Could not delete directory {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// Focuses and un-minimises the main window (called after "Load into Editor").
#[tauri::command]
pub fn focus_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Progress parsing helpers ──────────────────────────────────────────────────

fn parse_download_percent(line: &str) -> Option<f64> {
    if !line.contains("[download]") {
        return None;
    }
    let after = line.trim().strip_prefix("[download]")?.trim();
    let pct_str = after.split('%').next()?.trim();
    pct_str.parse::<f64>().ok()
}

/// Extract the transfer speed from a yt-dlp progress line.
/// Splits on " at " (with surrounding spaces) to avoid matching "at" inside
/// filenames or other substrings.
fn parse_download_speed(line: &str) -> Option<String> {
    line.split(" at ")
        .nth(1)?
        .split(" ETA ")
        .next()
        .map(|s| s.trim().to_string())
}

/// Extract the ETA from a yt-dlp progress line.
fn parse_download_eta(line: &str) -> Option<String> {
    line.split(" ETA ")
        .nth(1)
        .map(|s| s.trim().to_string())
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_percent_standard_line() {
        let line = "[download]  45.3% of 123.45MiB at  1.23MiB/s ETA 00:30";
        assert_eq!(parse_download_percent(line), Some(45.3));
    }

    #[test]
    fn parse_percent_100() {
        let line = "[download] 100% of 200.00MiB at  5.00MiB/s ETA 00:00";
        assert_eq!(parse_download_percent(line), Some(100.0));
    }

    #[test]
    fn parse_percent_non_download_line() {
        let line = "[youtube] Downloading webpage";
        assert_eq!(parse_download_percent(line), None);
    }

    #[test]
    fn parse_speed_extracted() {
        let line = "[download]  10.0% of 100MiB at  2.50MiB/s ETA 01:00";
        assert_eq!(
            parse_download_speed(line).as_deref(),
            Some("2.50MiB/s")
        );
    }

    #[test]
    fn parse_eta_extracted() {
        let line = "[download]  10.0% of 100MiB at  2.50MiB/s ETA 01:00";
        assert_eq!(parse_download_eta(line).as_deref(), Some("01:00"));
    }

    #[test]
    fn parse_speed_with_at_in_filename() {
        // Speed parser uses " at " with spaces, not bare "at", so a filename
        // containing "at" doesn't confuse it.
        let line = "[download]  20.0% of combat_video.mp4 at  3.00MiB/s ETA 00:15";
        assert_eq!(
            parse_download_speed(line).as_deref(),
            Some("3.00MiB/s")
        );
    }
}
