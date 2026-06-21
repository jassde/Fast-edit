use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

// ── State ─────────────────────────────────────────────────────────────────────

pub struct MangofetchState {
    pub mangofetch_path: Option<PathBuf>,
    pub temp_dir: PathBuf,
}

/// Locate `mangofetch` (or `mangofetch.exe` on Windows) on the user's PATH.
///
/// Cargo installs it to `~/.cargo/bin`, which is on PATH for any shell that
/// sourced the cargo env — but a desktop app launched from Explorer may not
/// see PATH additions made after first login. We fall back to checking
/// `~/.cargo/bin/mangofetch{.exe}` directly so the app still finds it.
fn which_mangofetch() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "mangofetch.exe" } else { "mangofetch" };

    // PATH lookup
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // Cargo default install location
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let cargo_bin = PathBuf::from(home).join(".cargo").join("bin").join(exe);
        if cargo_bin.is_file() {
            return Some(cargo_bin);
        }
    }

    None
}

pub fn init_state(fast_edit_root: &Path) -> MangofetchState {
    MangofetchState {
        mangofetch_path: which_mangofetch(),
        temp_dir: fast_edit_root.join("Temp video files"),
    }
}

// ── Windows: suppress console window ─────────────────────────────────────────

fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

// ── Update event payloads ─────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(tag = "phase", rename_all = "lowercase")]
pub enum UpdatePhase {
    Running,
    Done,
    Error { message: String },
}

#[derive(Serialize, Clone)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum InstallPhase {
    Running,
    Done,
    /// `cargo` itself is not on PATH — the user has no Rust toolchain. The UI
    /// surfaces a rustup.rs link instead of pretending we can install anything.
    CargoMissing,
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

fn cargo_on_path() -> bool {
    let exe = if cfg!(windows) { "cargo.exe" } else { "cargo" };
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            if dir.join(exe).is_file() {
                return true;
            }
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        if PathBuf::from(home).join(".cargo").join("bin").join(exe).is_file() {
            return true;
        }
    }
    false
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_mangofetch_config(
    state: State<'_, Mutex<MangofetchState>>,
) -> serde_json::Value {
    let g = state.lock().unwrap_or_else(|e| e.into_inner());
    serde_json::json!({
        "installed":      g.mangofetch_path.is_some(),
        "mangofetchPath": g.mangofetch_path.as_deref().and_then(|p| p.to_str()).unwrap_or(""),
        "tempDir":        g.temp_dir.to_string_lossy(),
    })
}

/// Runs `cargo install mangofetch` and emits `mangofetch-install` events
/// (`{phase:"running"}`, `{phase:"done"}`, `{phase:"cargoMissing"}`,
/// `{phase:"error",message:…}`). On success, re-resolves the mangofetch path
/// into shared state so subsequent commands work without an app restart.
///
/// First run takes several minutes (full Rust compile). The UI is responsible
/// for showing a clear "this can take a while" status during the `running`
/// phase — this command only emits coarse phase events, not percent progress.
#[tauri::command]
pub async fn install_mangofetch(
    state: State<'_, Mutex<MangofetchState>>,
    app: AppHandle,
) -> Result<(), String> {
    // Already installed? Just refresh state and emit done.
    if let Some(p) = which_mangofetch() {
        let mut g = state.lock().unwrap_or_else(|e| e.into_inner());
        g.mangofetch_path = Some(p);
        let _ = app.emit("mangofetch-install", InstallPhase::Done);
        return Ok(());
    }

    if !cargo_on_path() {
        let _ = app.emit("mangofetch-install", InstallPhase::CargoMissing);
        return Err(
            "Rust (cargo) is not installed. Install it from https://rustup.rs/ and restart the app."
                .to_string(),
        );
    }

    let _ = app.emit("mangofetch-install", InstallPhase::Running);

    let result = tauri::async_runtime::spawn_blocking(move || {
        let cargo = if cfg!(windows) { "cargo.exe" } else { "cargo" };
        let mut cmd = Command::new(cargo);
        cmd.args(["install", "mangofetch"])
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        hide_console(&mut cmd);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run `cargo install mangofetch`: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let snippet = tail_chars(&stderr, 800);
            return Err(format!("cargo install mangofetch failed:\n{}", snippet.trim()));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?;

    match &result {
        Ok(()) => {
            // Re-resolve the binary path so the rest of the session can use it.
            let new_path = which_mangofetch();
            {
                let mut g = state.lock().unwrap_or_else(|e| e.into_inner());
                g.mangofetch_path = new_path.clone();
            }
            if new_path.is_none() {
                let msg = "cargo install reported success but mangofetch was not found on PATH or in ~/.cargo/bin.".to_string();
                let _ = app.emit("mangofetch-install", InstallPhase::Error { message: msg.clone() });
                return Err(msg);
            }
            let _ = app.emit("mangofetch-install", InstallPhase::Done);
        }
        Err(e) => {
            let _ = app.emit("mangofetch-install", InstallPhase::Error { message: e.clone() });
        }
    }
    result
}

/// Runs `mangofetch update` and emits `mangofetch-update` events
/// (`{phase:"running"}`, `{phase:"done"}`, `{phase:"error",message:…}`).
///
/// Non-blocking from the UI's perspective: the long-running cargo subprocess
/// is moved onto the blocking pool, leaving the Tauri IPC worker free.
#[tauri::command]
pub async fn update_mangofetch(
    state: State<'_, Mutex<MangofetchState>>,
    app: AppHandle,
) -> Result<(), String> {
    let mango = {
        let g = state.lock().unwrap_or_else(|e| e.into_inner());
        g.mangofetch_path.clone()
    };
    let Some(mango) = mango else {
        return Err(
            "mangofetch is not installed. Run `cargo install mangofetch` and restart the app."
                .to_string(),
        );
    };

    let _ = app.emit("mangofetch-update", UpdatePhase::Running);

    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&mango);
        cmd.arg("update")
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        hide_console(&mut cmd);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run `mangofetch update`: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "mangofetch update failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?;

    match &result {
        Ok(()) => { let _ = app.emit("mangofetch-update", UpdatePhase::Done); }
        Err(e) => { let _ = app.emit("mangofetch-update", UpdatePhase::Error { message: e.clone() }); }
    }
    result
}

/// Downloads `url` into the temp dir at the requested quality tier, emitting
/// `mangofetch-progress` events. Returns the final file path on success.
///
/// Progress is indeterminate: mangofetch draws its progress bar directly to the
/// terminal via cursor control, so no per-chunk percent reaches stderr. We
/// stream verbose log lines so the UI can show life signs, and detect
/// completion via process exit. The final filename is resolved by scanning the
/// temp dir for the newest file created during the run.
#[tauri::command]
pub async fn download_video(
    url: String,
    quality: String,
    audio_only: bool,
    state: State<'_, Mutex<MangofetchState>>,
    app: AppHandle,
) -> Result<String, String> {
    let (mango, temp_dir) = {
        let g = state.lock().unwrap_or_else(|e| e.into_inner());
        let p = g.mangofetch_path.clone().ok_or(
            "mangofetch is not installed. Run `cargo install mangofetch` and restart the app.",
        )?;
        (p, g.temp_dir.clone())
    };

    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&temp_dir).map_err(|e| format!("Cannot create Temp dir: {e}"))?;
        let temp_str = temp_dir.to_string_lossy().to_string();

        // Snapshot files in temp dir BEFORE the run so we can identify the new
        // one(s) afterwards. mangofetch has no `--print-filepath` equivalent.
        let before: std::collections::HashSet<PathBuf> = fs::read_dir(&temp_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .collect();

        let mut cmd = Command::new(&mango);
        cmd.arg("-v")
            .arg("download")
            .arg("-o").arg(&temp_str)
            .arg("-y");
        if audio_only {
            cmd.arg("-a");
        }
        // `best` means "let mangofetch pick" — omit `-q` entirely. `audio` is
        // not a valid quality value; the audio-only mode is already selected
        // via `-a` above, so skip `-q` for it too. Any other value is passed
        // through (e.g. "1080p", "720p").
        if quality != "best" && quality != "audio" && !audio_only {
            cmd.arg("-q").arg(&quality);
        }
        cmd.arg("--").arg(&url)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start mangofetch: {e}"))?;

        let stderr = child.stderr.take()
            .ok_or_else(|| "mangofetch stderr not available".to_string())?;

        // Stream verbose log lines for a heartbeat-style progress indicator.
        // We can detect coarse phase transitions from log markers:
        //   "[yt-dlp] info fetch"  → fetching metadata
        //   "[queue] download N started"
        //   "[queue] download N completed"
        let app_clone = app.clone();
        let stderr_thread = std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let mut last_phase: &'static str = "";
            for line in reader.lines().filter_map(|l| l.ok()) {
                let clean = strip_ansi(&line);
                let phase = classify_phase(&clean);
                if !phase.is_empty() && phase != last_phase {
                    last_phase = phase;
                    let _ = app_clone.emit(
                        "mangofetch-progress",
                        serde_json::json!({ "phase": phase }),
                    );
                }
            }
        });

        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        let _ = stderr_thread.join();

        if !output.status.success() {
            let stderr_text = String::from_utf8_lossy(&output.stderr);
            let cleaned = strip_ansi(&stderr_text);
            let snippet = tail_chars(&cleaned, 800);
            return Err(format!(
                "mangofetch download failed.\n\nmangofetch output:\n{}",
                snippet.trim()
            ));
        }

        // Identify the new file(s). Pick the largest one created during the
        // run — mangofetch may leave behind small sidecars (descriptions,
        // thumbnails) but the video/audio is typically the biggest.
        let new_files: Vec<(PathBuf, u64)> = fs::read_dir(&temp_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let p = e.path();
                if before.contains(&p) { return None; }
                let meta = e.metadata().ok()?;
                if !meta.is_file() { return None; }
                Some((p, meta.len()))
            })
            .collect();

        let final_path = new_files.into_iter()
            .max_by_key(|(_, len)| *len)
            .map(|(p, _)| p.to_string_lossy().into_owned())
            .ok_or_else(|| {
                "Download appeared to succeed but no new file was found in the Temp folder."
                    .to_string()
            })?;

        let _ = app.emit("mangofetch-progress", serde_json::json!({ "phase": "done" }));
        Ok(final_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_temp_dir(state: State<'_, Mutex<MangofetchState>>) -> String {
    let g = state.lock().unwrap_or_else(|e| e.into_inner());
    g.temp_dir.to_string_lossy().to_string()
}

#[tauri::command]
pub fn clear_temp_dir(state: State<'_, Mutex<MangofetchState>>) -> Result<(), String> {
    let temp_dir = {
        let g = state.lock().unwrap_or_else(|e| e.into_inner());
        g.temp_dir.clone()
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Take the last `max_chars` characters of `s` (char-safe; never splits a
/// multi-byte UTF-8 sequence). Used to truncate long stderr snippets for the UI.
fn tail_chars(s: &str, max_chars: usize) -> String {
    let total = s.chars().count();
    if total <= max_chars {
        return s.to_string();
    }
    s.chars().skip(total - max_chars).collect()
}

/// Strip ANSI CSI sequences (colour, cursor, etc.) so log lines parse cleanly.
/// Iterates over chars (not raw bytes) so multi-byte UTF-8 sequences in the
/// surrounding text are preserved instead of being truncated to garbage.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next(); // consume '['
            // Skip parameter/intermediate bytes until a final byte in 0x40..=0x7E.
            while let Some(&nc) = chars.peek() {
                chars.next();
                if (0x40u32..=0x7E).contains(&(nc as u32)) {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Map a (cleaned) mangofetch verbose line to a coarse phase tag for the UI.
/// Returns "" if the line doesn't match any phase we care about.
fn classify_phase(line: &str) -> &'static str {
    if line.contains("[yt-dlp] info fetch") || line.contains("Fetching info for") {
        "fetching"
    } else if line.contains("[queue] download") && line.contains("started") {
        "downloading"
    } else if line.contains("[queue] download") && line.contains("completed") {
        "muxing"
    } else {
        ""
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_color_codes() {
        let s = "\x1b[1;36mhello\x1b[0m world";
        assert_eq!(strip_ansi(s), "hello world");
    }

    #[test]
    fn strip_ansi_leaves_plain_text_alone() {
        assert_eq!(strip_ansi("plain text"), "plain text");
    }

    #[test]
    fn strip_ansi_preserves_multibyte_utf8() {
        // em-dash (—) and accented chars must survive intact.
        let s = "\x1b[31merror\x1b[0m: café — naïve";
        assert_eq!(strip_ansi(s), "error: café — naïve");
    }

    #[test]
    fn tail_chars_under_limit_returns_whole_string() {
        assert_eq!(tail_chars("hello", 10), "hello");
    }

    #[test]
    fn tail_chars_over_limit_keeps_last_n_chars() {
        assert_eq!(tail_chars("abcdefghij", 4), "ghij");
    }

    #[test]
    fn tail_chars_never_splits_multibyte() {
        // 5 chars, each 2 bytes in UTF-8 ("é" = 0xC3 0xA9). Taking last 3
        // characters should yield 3 chars / 6 bytes, never panicking.
        let s = "ééééé";
        let out = tail_chars(s, 3);
        assert_eq!(out.chars().count(), 3);
        assert_eq!(out, "ééé");
    }

    #[test]
    fn classify_phase_fetching() {
        assert_eq!(
            classify_phase("INFO mangofetch_core::core::ytdlp: [yt-dlp] info fetch attempt 1/2"),
            "fetching"
        );
    }

    #[test]
    fn classify_phase_downloading() {
        assert_eq!(
            classify_phase("INFO mangofetch_core::core::manager::queue: [queue] download 2 started"),
            "downloading"
        );
    }

    #[test]
    fn classify_phase_muxing() {
        assert_eq!(
            classify_phase("INFO [queue] download 2 completed in 26.7s"),
            "muxing"
        );
    }

    #[test]
    fn classify_phase_irrelevant() {
        assert_eq!(classify_phase("DEBUG some other line"), "");
    }
}
