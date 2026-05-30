use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

// ── Cookie source ─────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CookieSource {
    #[default]
    None,
    /// `browser` is the yt-dlp browser name (e.g. "chrome").
    /// `profile` is the optional profile name appended as `browser:profile`
    /// (e.g. "chrome:Default"). Empty string means use the default profile.
    Browser { browser: String, #[serde(default)] profile: String },
    File    { path: String },
}

// ── State ─────────────────────────────────────────────────────────────────────

pub struct YtdlpState {
    pub ytdlp_path:    Option<PathBuf>,
    pub temp_dir:      PathBuf,
    pub cookie_source: CookieSource,
}

// ── Config file on disk ───────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default)]
struct YtdlpConfigFile {
    ytdlp_path:    Option<String>,
    temp_dir:      Option<String>,
    #[serde(default)]
    cookie_source: CookieSource,
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

    let temp_dir = cfg.temp_dir
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            app.path()
                .app_local_data_dir()
                .map(|d| d.join("Temp"))
                .unwrap_or_else(|_| PathBuf::from("Temp"))
        });

    YtdlpState { ytdlp_path, temp_dir, cookie_source: cfg.cookie_source }
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
        "ytdlpPath":    guard.ytdlp_path.as_deref().and_then(|p| p.to_str()).unwrap_or(""),
        "tempDir":      guard.temp_dir.to_string_lossy(),
        "cookieSource": guard.cookie_source,
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
    // leaves the previous value intact. Read existing config first to preserve
    // cookie_source — constructing a fresh struct would zero it out.
    let mut cfg = load_config(&app);
    cfg.ytdlp_path = Some(path);
    save_config(&app, &cfg)?;

    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    guard.ytdlp_path = Some(new_path);
    Ok(())
}

/// Persists the cookie source selection and updates running state.
#[tauri::command]
pub fn save_cookie_settings(
    cookie_source: CookieSource,
    state: State<'_, Mutex<YtdlpState>>,
    app: AppHandle,
) -> Result<(), String> {
    let mut cfg = load_config(&app);
    cfg.cookie_source = cookie_source.clone();
    save_config(&app, &cfg)?;
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    guard.cookie_source = cookie_source;
    Ok(())
}

/// Validates the given path (creates it if needed), persists it as the temp
/// directory, and updates running state so the next download uses it.
#[tauri::command]
pub fn save_temp_dir(
    path: String,
    state: State<'_, Mutex<YtdlpState>>,
    app: AppHandle,
) -> Result<(), String> {
    let new_path = PathBuf::from(&path);
    fs::create_dir_all(&new_path).map_err(|e| format!("Cannot create directory: {e}"))?;

    let mut cfg = load_config(&app);
    cfg.temp_dir = Some(path);
    save_config(&app, &cfg)?;

    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    guard.temp_dir = new_path;
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
    let (ytdlp, cookie_source) = {
        let guard = state.lock().unwrap_or_else(|e| e.into_inner());
        let p = guard
            .ytdlp_path
            .clone()
            .ok_or("yt-dlp path not set. Click the \u{2699} button to configure it.")?;
        (p, guard.cookie_source.clone())
    };

    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&ytdlp);
        // `--` separates flags from the URL, preventing a URL starting with `-`
        // from being parsed as a yt-dlp option (e.g. `--exec`).
        cmd.args(["-j", "--no-playlist"])
            .args(build_cookie_args(&cookie_source))
            .args(["--", &url])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut cmd);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run yt-dlp: {e}"))?;
        if !output.status.success() {
            return Err(interpret_ytdlp_error(
                "yt-dlp failed to fetch video info. Check the URL and try again.",
                &String::from_utf8_lossy(&output.stderr),
            ));
        }

        let json: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("JSON parse error: {e}"))?;

        let formats_raw = json["formats"].as_array().cloned().unwrap_or_default();

        // ── Build per-stream format rows ───────────────────────────────────────
        //
        // Deduplicate video streams by (height, fps, short_codec, dynamic_range),
        // keeping the highest-bitrate representative for each unique combination.
        // This mirrors yt-dlp-gui-v2's approach: show individual streams, not
        // curated quality tiers.

        let mut best_by_key: HashMap<String, serde_json::Value> = HashMap::new();

        for f in &formats_raw {
            let vcodec = f["vcodec"].as_str().unwrap_or("none");
            if vcodec == "none" { continue; }
            let height = f["height"].as_u64().unwrap_or(0);
            if height == 0 { continue; }

            let fps = f["fps"].as_f64().map(|v| v.round() as u64).unwrap_or(0);
            let codec = vcodec.split('.').next().unwrap_or(vcodec);
            let dr    = f["dynamic_range"].as_str().unwrap_or("SDR");
            let key   = format!("{height}:{fps}:{codec}:{dr}");

            let tbr_new = f["tbr"].as_f64().unwrap_or(0.0);
            let tbr_old = best_by_key.get(&key)
                .and_then(|e| e["tbr"].as_f64())
                .unwrap_or(-1.0);
            if tbr_new > tbr_old {
                best_by_key.insert(key, f.clone());
            }
        }

        // Sort: height desc, then fps desc
        let mut deduped: Vec<serde_json::Value> = best_by_key.into_values().collect();
        deduped.sort_by(|a, b| {
            let ha = a["height"].as_u64().unwrap_or(0);
            let hb = b["height"].as_u64().unwrap_or(0);
            let fa = a["fps"].as_f64().map(|v| v as u64).unwrap_or(0);
            let fb = b["fps"].as_f64().map(|v| v as u64).unwrap_or(0);
            hb.cmp(&ha).then(fb.cmp(&fa))
        });

        let video_rows: Vec<serde_json::Value> = deduped.iter().map(|f| {
            let height   = f["height"].as_u64().unwrap_or(0);
            let width    = f["width"].as_u64().unwrap_or(0);
            let fps_raw  = f["fps"].as_f64().map(|v| v.round() as u64).unwrap_or(0);
            let vcodec   = f["vcodec"].as_str().unwrap_or("");
            let codec    = vcodec.split('.').next().unwrap_or(vcodec);
            let dr       = f["dynamic_range"].as_str().unwrap_or("SDR");
            let ext      = f["ext"].as_str().unwrap_or("");
            let fmt_id   = f["format_id"].as_str().unwrap_or("");

            // A format is muxed (contains audio) when acodec is set and not "none".
            let is_muxed = f["acodec"].as_str().map(|c| c != "none").unwrap_or(false);
            let selector = if is_muxed {
                fmt_id.to_string()
            } else {
                // Pair video stream with best available audio.
                // Fallback selector handles sites where format IDs are fragile.
                format!("{fmt_id}+bestaudio/bestvideo[height<={height}]+bestaudio")
            };

            let resolution = if width > 0 {
                format!("{width}\u{00D7}{height}")   // × (U+00D7 multiplication sign)
            } else {
                format!("{height}p")
            };
            let fps_str = if fps_raw > 0 { fps_raw.to_string() } else { String::new() };

            // Filesize: prefer exact, fall back to approximate with a ~ prefix.
            let filesize = if let Some(b) = f["filesize"].as_u64() {
                format_filesize(b)
            } else if let Some(b) = f["filesize_approx"].as_u64() {
                format!("~{}", format_filesize(b))
            } else {
                String::new()
            };

            // Compact label used as accessible title / fallback display text.
            let mut parts = vec![resolution.clone()];
            if !fps_str.is_empty() { parts.push(format!("{fps_str}fps")); }
            if !codec.is_empty()   { parts.push(codec.to_string()); }
            if dr != "SDR" && !dr.is_empty() { parts.push(dr.to_string()); }

            serde_json::json!({
                "formatId":      fmt_id,
                "label":         parts.join(" · "),
                "ytdlpSelector": selector,
                "hasVideo":      true,
                "hasAudio":      true,
                "resolution":    resolution,
                "fps":           fps_str,
                "codec":         codec,
                "filesize":      filesize,
                "dynamicRange":  dr,
                "ext":           ext,
                "sampleRate":    "",
            })
        }).collect();

        // Assemble final list: Best available → video streams → Audio only
        let empty_meta = serde_json::json!({
            "hasVideo": true, "hasAudio": true,
            "resolution": "", "fps": "", "codec": "",
            "filesize": "", "dynamicRange": "", "ext": "", "sampleRate": "",
        });

        let mut result = vec![{
            let mut v = empty_meta.clone();
            v["formatId"]      = "best".into();
            v["label"]         = "Best available".into();
            v["ytdlpSelector"] = "bv*+ba/b".into();
            v
        }];
        result.extend(video_rows);
        result.push(serde_json::json!({
            "formatId":      "audio",
            "label":         "Audio only (best quality)",
            "ytdlpSelector": "bestaudio",
            "hasVideo":      false,
            "hasAudio":      true,
            "resolution":    "",
            "fps":           "",
            "codec":         "",
            "filesize":      "",
            "dynamicRange":  "",
            "ext":           "",
            "sampleRate":    "",
        }));

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
    let (ytdlp, temp_dir, cookie_source) = {
        let guard = state.lock().unwrap_or_else(|e| e.into_inner());
        let p = guard
            .ytdlp_path
            .clone()
            .ok_or("yt-dlp path not set. Click the \u{2699} button to configure it.")?;
        (p, guard.temp_dir.clone(), guard.cookie_source.clone())
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
        ])
        .args(build_cookie_args(&cookie_source))
        .args(["--", &url])   // separates flags from the URL
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        hide_console(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start yt-dlp: {e}"))?;

        let stderr = child.stderr.take()
            .ok_or_else(|| "yt-dlp stderr not available (internal error)".to_string())?;
        let app_clone = app.clone();

        // Non-progress lines (warnings, errors) are collected so we can surface
        // them in the error message if the download fails.
        let error_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let error_lines_clone = Arc::clone(&error_lines);

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
                } else if let Ok(mut v) = error_lines_clone.lock() {
                    v.push(line);
                }
            }
        });

        // wait_with_output waits for the process and all IO to close, so the
        // stderr thread above is guaranteed to finish before we read error_lines.
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            let collected = error_lines.lock().map(|v| v.clone()).unwrap_or_default();
            return Err(interpret_ytdlp_error(
                "yt-dlp download failed. Check the URL and format, then try again.",
                &collected.join("\n"),
            ));
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

/// Sends `load-video-file` directly to the main webview and brings it to the
/// foreground.
///
/// Using `win.emit()` from Rust is the reliable cross-window path in Tauri v2.
/// A frontend `emit()` call only guarantees delivery to the Rust backend; from
/// there re-delivery to another webview is not synchronously guaranteed.
/// `win.emit()` bypasses that by targeting the specific webview directly.
#[tauri::command]
pub fn load_video_in_main(path: String, app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.emit("load-video-file", &path).map_err(|e| e.to_string())?;
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Cookie / stderr helpers ───────────────────────────────────────────────────

fn build_cookie_args(source: &CookieSource) -> Vec<String> {
    match source {
        CookieSource::None => vec![],
        CookieSource::Browser { browser, profile } => {
            // yt-dlp accepts `--cookies-from-browser chrome` or `--cookies-from-browser chrome:ProfileName`
            let arg = if profile.trim().is_empty() {
                browser.clone()
            } else {
                format!("{browser}:{}", profile.trim())
            };
            vec!["--cookies-from-browser".into(), arg]
        }
        CookieSource::File { path } => vec!["--cookies".into(), path.clone()],
    }
}

/// Human-readable file size string.
fn format_filesize(bytes: u64) -> String {
    if bytes >= 1_073_741_824 {
        format!("{:.1} GB", bytes as f64 / 1_073_741_824.0)
    } else if bytes >= 1_048_576 {
        format!("{:.0} MB", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1_024 {
        format!("{:.0} KB", bytes as f64 / 1_024.0)
    } else {
        format!("{bytes} B")
    }
}

/// Inspect yt-dlp stderr for known failure patterns and build an error string
/// with an actionable hint followed by the raw yt-dlp output.
///
/// Pattern matching uses lowercase so it catches any capitalisation variant.
fn interpret_ytdlp_error(default_msg: &str, stderr_text: &str) -> String {
    let lower = stderr_text.to_lowercase();

    let hint: Option<&str> = if lower.contains("javascript runtime")
        || lower.contains("challenge solver")
        || lower.contains("po_token")
        || lower.contains("potoken")
    {
        Some(
            "Hint: YouTube requires a JavaScript challenge solver. \
             Set Cookie source → Browser to pass your logged-in browser session to yt-dlp, \
             or install Node.js so yt-dlp can solve the challenge itself.",
        )
    } else if lower.contains("sign in to confirm")
        || lower.contains("sign in to access")
        || lower.contains("age-restricted")
        || lower.contains("age restricted")
        || lower.contains("members-only")
        || lower.contains("member-only")
    {
        Some(
            "Hint: This video requires authentication (age restriction or members-only). \
             Set Cookie source → Browser so yt-dlp can use your logged-in session.",
        )
    } else if lower.contains("private video") {
        Some("Hint: This video is private and cannot be downloaded.")
    } else if lower.contains("video unavailable") {
        Some(
            "Hint: This video is unavailable (deleted, region-blocked, or taken down).",
        )
    } else if lower.contains("only images are available") {
        Some(
            "Hint: No video formats found — yt-dlp only sees images at this URL. \
             The URL may point to a photo post, or the video requires cookies to access. \
             Try setting Cookie source → Browser.",
        )
    } else if lower.contains("requested format is not available") {
        Some(
            "Hint: The selected quality is not available for this video. \
             Try fetching formats again — the list may contain different options.",
        )
    } else {
        None
    };

    // Always append the raw yt-dlp output (truncated) so users can see what went wrong.
    let trimmed = stderr_text.trim();
    let raw = if trimmed.is_empty() {
        String::new()
    } else {
        let snippet = if trimmed.len() > 400 { &trimmed[trimmed.len() - 400..] } else { trimmed };
        format!("\n\nyt-dlp output:\n{snippet}")
    };

    match hint {
        Some(h) => format!("{default_msg}\n\n{h}{raw}"),
        None    => format!("{default_msg}{raw}"),
    }
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

    #[test]
    fn cookie_args_none() {
        assert!(build_cookie_args(&CookieSource::None).is_empty());
    }

    #[test]
    fn cookie_args_browser_no_profile() {
        assert_eq!(
            build_cookie_args(&CookieSource::Browser { browser: "chrome".into(), profile: String::new() }),
            ["--cookies-from-browser", "chrome"]
        );
    }

    #[test]
    fn cookie_args_browser_with_profile() {
        assert_eq!(
            build_cookie_args(&CookieSource::Browser { browser: "chrome".into(), profile: "Default".into() }),
            ["--cookies-from-browser", "chrome:Default"]
        );
    }

    #[test]
    fn cookie_args_file() {
        assert_eq!(
            build_cookie_args(&CookieSource::File { path: "/cookies.txt".into() }),
            ["--cookies", "/cookies.txt"]
        );
    }

    #[test]
    fn format_filesize_mb() {
        assert_eq!(format_filesize(150 * 1_048_576), "150 MB");
    }

    #[test]
    fn format_filesize_gb() {
        assert!(format_filesize(2 * 1_073_741_824).contains("GB"));
    }

    #[test]
    fn interpret_js_challenge_hint() {
        let err = interpret_ytdlp_error("Fetch failed.", "You need to have a supported JavaScript runtime and challenge solver");
        assert!(err.contains("Hint:"));
        assert!(err.contains("Cookie source"));
        assert!(err.contains("Node.js"));
    }

    #[test]
    fn interpret_age_restricted_hint() {
        let err = interpret_ytdlp_error("Fetch failed.", "ERROR: Sign in to confirm your age");
        assert!(err.contains("Hint:"));
        assert!(err.contains("Cookie source"));
    }

    #[test]
    fn interpret_only_images_hint() {
        let err = interpret_ytdlp_error("Fetch failed.", "WARNING: Only images are available for download");
        assert!(err.contains("Hint:"));
        assert!(err.contains("Cookie source"));
    }

    #[test]
    fn interpret_unknown_shows_raw() {
        let err = interpret_ytdlp_error("Fetch failed.", "some unexpected error XYZ");
        assert!(!err.contains("Hint:"));
        assert!(err.contains("yt-dlp output:"));
        assert!(err.contains("some unexpected error XYZ"));
    }

    #[test]
    fn interpret_empty_stderr_no_snippet() {
        let err = interpret_ytdlp_error("Fetch failed.", "");
        assert_eq!(err, "Fetch failed.");
    }
}
