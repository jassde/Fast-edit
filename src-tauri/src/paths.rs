use std::{
    fs,
    io,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

// ── State ─────────────────────────────────────────────────────────────────────

pub struct AppPaths {
    pub fast_edit_root: PathBuf,
}

impl AppPaths {
    pub fn cookies_dir(&self) -> PathBuf { self.fast_edit_root.join("Cookies") }
    pub fn saves_dir(&self)   -> PathBuf { self.fast_edit_root.join("saves") }
    // Temp dir lives on YtdlpState directly (mirrored at startup and on root
    // change) so download_video can read it under a single mutex lock.
}

// ── Persistence ───────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default)]
struct AppPathsFile {
    fast_edit_root: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("app_paths.json"))
}

fn load_file(app: &AppHandle) -> AppPathsFile {
    config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_file(app: &AppHandle, root: &Path) -> Result<(), String> {
    let path = config_path(app)?;
    let file = AppPathsFile { fast_edit_root: Some(root.to_string_lossy().into_owned()) };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn default_root(app: &AppHandle) -> PathBuf {
    app.path()
        .document_dir()
        .map(|d| d.join("Fast-edit"))
        .unwrap_or_else(|_| PathBuf::from("Fast-edit"))
}

pub fn init_state(app: &AppHandle) -> AppPaths {
    let saved = load_file(app).fast_edit_root.map(PathBuf::from);
    let root = saved.unwrap_or_else(|| default_root(app));
    // Ensure the root exists so downstream `.join(...)` paths can be created
    // without surprises on first launch.
    let _ = fs::create_dir_all(&root);
    AppPaths { fast_edit_root: root }
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_fast_edit_root(state: State<'_, Mutex<AppPaths>>) -> String {
    let guard = state.lock().unwrap_or_else(|e| e.into_inner());
    guard.fast_edit_root.to_string_lossy().into_owned()
}

/// Move the Fast-edit folder to a new location and switch all derived dirs.
///
/// Validation: absolute, non-empty, not equal to or nested inside the current
/// root. If the new path already exists and is non-empty, the call is rejected
/// to avoid silent merges.
#[tauri::command]
pub fn set_fast_edit_root(
    new_path: String,
    paths_state: State<'_, Mutex<AppPaths>>,
    ytdlp_state: State<'_, Mutex<crate::ytdlp::YtdlpState>>,
    app: AppHandle,
) -> Result<String, String> {
    let trimmed = new_path.trim();
    if trimmed.is_empty() {
        return Err("Folder path cannot be empty.".to_string());
    }
    let target = PathBuf::from(trimmed);
    if !target.is_absolute() {
        return Err(format!("Folder must be an absolute path (got: {trimmed})."));
    }

    let old_root = {
        let guard = paths_state.lock().unwrap_or_else(|e| e.into_inner());
        guard.fast_edit_root.clone()
    };

    if paths_equal(&target, &old_root) {
        // Nothing to do — silently succeed so the caller can treat it as a no-op.
        return Ok(old_root.to_string_lossy().into_owned());
    }
    if is_inside(&target, &old_root) {
        return Err("New location cannot be inside the current Fast-edit folder.".to_string());
    }
    if target.exists() && dir_has_entries(&target).unwrap_or(true) {
        return Err(format!(
            "Target folder already exists and is not empty: {}",
            target.display(),
        ));
    }

    // Move (or, on fresh install where old_root has no content, just create).
    if old_root.exists() {
        move_dir(&old_root, &target)
            .map_err(|e| format!("Could not move Fast-edit folder: {e}"))?;
    } else if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    }

    // Persist BEFORE swapping in-memory state, so a disk error leaves the
    // running app pointing at the (now-moved) old root rather than a path that
    // won't survive a restart.
    save_file(&app, &target)?;

    {
        let mut guard = paths_state.lock().unwrap_or_else(|e| e.into_inner());
        guard.fast_edit_root = target.clone();
    }
    {
        let mut guard = ytdlp_state.lock().unwrap_or_else(|e| e.into_inner());
        guard.temp_dir = target.join("Temp video files");
    }

    Ok(target.to_string_lossy().into_owned())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn paths_equal(a: &Path, b: &Path) -> bool {
    a.canonicalize().ok().as_deref() == b.canonicalize().ok().as_deref() || a == b
}

fn is_inside(candidate: &Path, ancestor: &Path) -> bool {
    let c = candidate.canonicalize().unwrap_or_else(|_| candidate.to_path_buf());
    let a = ancestor.canonicalize().unwrap_or_else(|_| ancestor.to_path_buf());
    c.starts_with(&a) && c != a
}

fn dir_has_entries(p: &Path) -> io::Result<bool> {
    Ok(fs::read_dir(p)?.next().is_some())
}

/// Move `src` to `dst`. Tries `rename` first (atomic on same volume); falls back
/// to recursive copy + delete on cross-volume `EXDEV`.
fn move_dir(src: &Path, dst: &Path) -> io::Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Windows uses raw OS error 17 (ERROR_NOT_SAME_DEVICE); Unix uses EXDEV.
            // Either way it's reported via io::ErrorKind::CrossesDevices on recent Rust,
            // but we also see PermissionDenied / Other from older toolchains. Fall back
            // unconditionally — the cost is a single attempted rename.
            let _ = e;
            copy_dir_recursive(src, dst)?;
            fs::remove_dir_all(src)
        }
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to   = dst.join(entry.file_name());
        let ft   = entry.file_type()?;
        if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ft.is_symlink() {
            // Skip symlinks rather than dereference-and-copy. Surfaces as a
            // missing file at the new location; user can recreate if needed.
            continue;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

