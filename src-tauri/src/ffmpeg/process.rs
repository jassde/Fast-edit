use std::io::{BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};

use tauri::{AppHandle, Emitter};

use super::types::{ExportProgressPayload, HwSupport};

/// On Windows, prevent a spawned subprocess from opening a console window
/// (CREATE_NO_WINDOW = 0x0800_0000). No-op on other platforms.
pub(crate) fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Run `ffmpeg -hide_banner -encoders` and inspect the output for known HW
/// encoder names. Returns an all-false `HwSupport` if ffmpeg fails to launch.
pub fn probe_hw_support(ffmpeg_path: &Path) -> HwSupport {
    let mut cmd = Command::new(ffmpeg_path);
    cmd.args(["-hide_banner", "-encoders"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console(&mut cmd);
    let out = cmd.output();

    let Ok(out) = out else { return HwSupport::default() };
    let text = String::from_utf8_lossy(&out.stdout);

    HwSupport {
        // Only check the H.264 variant per family — if h264_<family> is
        // compiled in, the corresponding hevc_<family> almost always is too.
        nvenc: text.contains("h264_nvenc"),
        qsv:   text.contains("h264_qsv"),
        amf:   text.contains("h264_amf"),
    }
}

/// Parse `time=HH:MM:SS.mmm` from a line of ffmpeg stderr output.
fn parse_time_pos(line: &str) -> Option<f64> {
    let prefix = "time=";
    let start  = line.find(prefix)? + prefix.len();
    let rest   = &line[start..];
    let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
    let ts  = &rest[..end];

    let parts: Vec<&str> = ts.splitn(3, ':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h:  f64 = parts[0].parse().ok()?;
    let m:  f64 = parts[1].parse().ok()?;
    let s:  f64 = parts[2].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

pub(crate) fn run_ffmpeg_with_progress(
    ffmpeg: &Path,
    args: &[String],
    seg_duration: f64,
    seg_index: usize,
    total_segs: usize,
    app: &AppHandle,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(args)
        .stderr(Stdio::piped())
        .stdout(Stdio::null());
    hide_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ffmpeg: {e}"))?;

    // ffmpeg writes progress as `frame=… time=…\r` (no newline until segment
    // end). Read raw bytes and split on either terminator so we see updates.
    let stderr = child.stderr.take()
        .ok_or_else(|| "ffmpeg stderr not available (internal error)".to_string())?;
    let mut reader = BufReader::new(stderr);
    let mut line_buf: Vec<u8> = Vec::with_capacity(256);

    // Rolling buffer of the last N non-progress stderr lines, so that on
    // failure we can surface ffmpeg's actual error message to the UI instead
    // of just the opaque exit code.
    const TAIL_LINES: usize = 20;
    let mut tail: std::collections::VecDeque<String> =
        std::collections::VecDeque::with_capacity(TAIL_LINES);

    let mut chunk = [0u8; 4096];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                for &c in &chunk[..n] {
                    if c == b'\r' || c == b'\n' {
                        if !line_buf.is_empty() {
                            let line = String::from_utf8_lossy(&line_buf);
                            if let Some(t) = parse_time_pos(&line) {
                                let seg_pct = if seg_duration > 0.0 {
                                    (t / seg_duration).clamp(0.0, 1.0)
                                } else {
                                    0.0
                                };
                                let overall =
                                    ((seg_index as f64 + seg_pct) / total_segs as f64) * 100.0;
                                let _ = app.emit(
                                    "export-progress",
                                    ExportProgressPayload { percent: overall },
                                );
                            } else {
                                let trimmed = line.trim();
                                if !trimmed.is_empty() {
                                    if tail.len() == TAIL_LINES {
                                        tail.pop_front();
                                    }
                                    tail.push_back(trimmed.to_string());
                                }
                            }
                            line_buf.clear();
                        }
                    } else {
                        line_buf.push(c);
                    }
                }
            }
            Err(_) => break,
        }
    }

    let status = child.wait().map_err(|e| format!("ffmpeg wait failed: {e}"))?;
    if !status.success() {
        let detail = if tail.is_empty() {
            "(no stderr output captured)".to_string()
        } else {
            tail.into_iter().collect::<Vec<_>>().join("\n")
        };
        return Err(format!("ffmpeg exited with status {status}\n{detail}"));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_time_pos_works() {
        let line = "frame=  100 fps= 30 q=-1.0 size=    512kB time=00:00:03.333 bitrate=1234.5kbits/s";
        let t = parse_time_pos(line).unwrap();
        assert!((t - 3.333).abs() < 0.001, "expected ~3.333, got {t}");
    }

    #[test]
    fn parse_time_pos_returns_none_on_missing() {
        assert!(parse_time_pos("no time field here").is_none());
    }

    #[test]
    fn parse_time_pos_handles_carriage_return_line() {
        let line = "frame=  10 fps=30 q=-1.0 size=N/A time=00:00:01.500 bitrate=N/A speed=1x";
        let t = parse_time_pos(line).unwrap();
        assert!((t - 1.5).abs() < 0.001, "got {t}");
    }
}
