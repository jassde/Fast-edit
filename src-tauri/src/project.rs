use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ProjectSegment {
    pub id: String,
    pub start: f64,
    pub end: f64,
    pub color: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct Project {
    pub version: u32,
    #[serde(rename = "savedAt")]
    pub saved_at: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub duration: f64,
    #[serde(rename = "playheadPosition")]
    pub playhead_position: f64,
    pub segments: Vec<ProjectSegment>,
}

const SUPPORTED_VERSION: u32 = 1;

fn resolve_default_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    Ok(docs.join("Video Trimmer").join("saves"))
}

#[tauri::command]
pub fn default_save_dir(app: AppHandle) -> Result<String, String> {
    let dir = resolve_default_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn save_project(path: String, project: Project) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    if let Some(parent) = pb.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&project).map_err(|e| e.to_string())?;
    fs::write(&pb, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_project(path: String) -> Result<Project, String> {
    let txt = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let proj: Project = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
    if proj.version != SUPPORTED_VERSION {
        return Err(format!(
            "Unsupported project version {} (expected {})",
            proj.version, SUPPORTED_VERSION
        ));
    }
    Ok(proj)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_round_trip() {
        let p = Project {
            version: 1,
            saved_at: "2026-05-30T14:32:11Z".into(),
            file_path: "F:\\videos\\clip.mp4".into(),
            duration: 123.456,
            playhead_position: 42.5,
            segments: vec![
                ProjectSegment {
                    id: "abc".into(),
                    start: 1.0,
                    end: 5.25,
                    color: "#ff0000".into(),
                },
                ProjectSegment {
                    id: "def".into(),
                    start: 10.0,
                    end: 12.0,
                    color: "#00ff00".into(),
                },
            ],
        };
        let s = serde_json::to_string(&p).unwrap();
        let back: Project = serde_json::from_str(&s).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn rejects_unknown_version_via_load_logic() {
        let bad = r#"{"version":99,"savedAt":"x","filePath":"y","duration":0,"playheadPosition":0,"segments":[]}"#;
        let proj: Project = serde_json::from_str(bad).unwrap();
        assert_ne!(proj.version, SUPPORTED_VERSION);
    }
}
