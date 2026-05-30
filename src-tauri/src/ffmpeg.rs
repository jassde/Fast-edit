use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

/// On Windows, prevent a spawned subprocess from opening a console window
/// (CREATE_NO_WINDOW = 0x0800_0000). No-op on other platforms.
fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd; // avoid unused-parameter warning
    }
}

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SegmentRange {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportParams {
    pub file_path: String,
    pub output_dir: String,
    pub segments: Vec<SegmentRange>,
    pub export_mode: ExportMode,
    pub codec_mode: CodecMode,
    pub codec: Option<Codec>,
    #[serde(default)]
    pub crf: Option<u32>,
    #[serde(default)]
    pub container: Option<Container>,
    pub filename_pattern: String,
    #[serde(default)]
    pub hw_encoder: Option<HwEncoder>,
}

/// User's hardware-encoder preference. `Auto` picks the best available based
/// on the probed `HwSupport` at startup; `None` forces software encoding.
#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum HwEncoder {
    None,
    Auto,
    Nvenc,
    Qsv,
    Amf,
}

/// Which hardware encoder families this build of ffmpeg has compiled in.
/// Detected once at startup. Note: presence here means ffmpeg knows the
/// encoder exists, NOT that the GPU/driver is functional — actual encode
/// failures still surface to the user.
#[derive(Debug, Serialize, Clone, Default)]
pub struct HwSupport {
    pub nvenc: bool,
    pub qsv:   bool,
    pub amf:   bool,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ExportMode {
    Separate,
    Merge,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CodecMode {
    Copy,
    Reencode,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    H264,
    H265,
    Vp9,
}

impl Codec {
    fn software_encoder(&self) -> &'static str {
        match self {
            Codec::H264 => "libx264",
            Codec::H265 => "libx265",
            Codec::Vp9  => "libvpx-vp9",
        }
    }

    /// Hardware encoder name for a given family, or `None` if this codec has
    /// no encoder in that family available in modern ffmpeg builds.
    fn hw_encoder_name(&self, family: HwEncoder) -> Option<&'static str> {
        match (self, family) {
            (Codec::H264, HwEncoder::Nvenc) => Some("h264_nvenc"),
            (Codec::H265, HwEncoder::Nvenc) => Some("hevc_nvenc"),
            (Codec::H264, HwEncoder::Qsv)   => Some("h264_qsv"),
            (Codec::H265, HwEncoder::Qsv)   => Some("hevc_qsv"),
            (Codec::Vp9,  HwEncoder::Qsv)   => Some("vp9_qsv"),
            (Codec::H264, HwEncoder::Amf)   => Some("h264_amf"),
            (Codec::H265, HwEncoder::Amf)   => Some("hevc_amf"),
            // Vp9 has no widely-available NVENC/AMF encoder; fall back to software.
            _ => None,
        }
    }
}

/// Output container. `Source` keeps the input's container/extension (current
/// behavior); the others force a specific muxer. Drives both the output file
/// extension and — in re-encode mode — the audio codec.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Container {
    Source,
    Mp4,
    Mkv,
    Webm,
}

impl Container {
    /// Output file extension including the leading dot. `source_ext` is the
    /// input file's extension (with leading dot), used for `Source`.
    fn extension(&self, source_ext: &str) -> String {
        match self {
            Container::Source => source_ext.to_string(),
            Container::Mp4    => ".mp4".to_string(),
            Container::Mkv    => ".mkv".to_string(),
            Container::Webm   => ".webm".to_string(),
        }
    }

    /// Audio encoder for re-encode mode. WebM only accepts Opus/Vorbis, so it
    /// gets `libopus`; every other container takes `aac`. `Source` inspects the
    /// input extension to decide.
    fn audio_encoder(&self, source_ext: &str) -> &'static str {
        let is_webm = match self {
            Container::Webm   => true,
            Container::Source => source_ext.eq_ignore_ascii_case(".webm"),
            _                 => false,
        };
        if is_webm { "libopus" } else { "aac" }
    }
}

// ── Managed state ─────────────────────────────────────────────────────────────

pub struct FfmpegState {
    pub ffmpeg_path: Option<PathBuf>,
    pub hw_support:  HwSupport,
}

impl Default for FfmpegState {
    fn default() -> Self {
        Self {
            ffmpeg_path: None,
            hw_support:  HwSupport::default(),
        }
    }
}

// ── Hardware-encoder probing & selection ──────────────────────────────────────

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
        // compiled in, the corresponding hevc_<family> almost always is too,
        // and we'd fall back to software anyway if it isn't.
        nvenc: text.contains("h264_nvenc"),
        qsv:   text.contains("h264_qsv"),
        amf:   text.contains("h264_amf"),
    }
}

/// Auto priority order: NVENC → QSV → AMF. NVIDIA encoders give the best
/// quality/perf, Intel QSV is the most widely available iGPU encoder, AMF
/// covers AMD GPUs. Returns `None` (= software) if no HW family supports
/// the requested codec.
fn auto_pick_family(codec: &Codec, support: &HwSupport) -> Option<HwEncoder> {
    for family in [HwEncoder::Nvenc, HwEncoder::Qsv, HwEncoder::Amf] {
        let supported = match family {
            HwEncoder::Nvenc => support.nvenc,
            HwEncoder::Qsv   => support.qsv,
            HwEncoder::Amf   => support.amf,
            _                => false,
        };
        if supported && codec.hw_encoder_name(family).is_some() {
            return Some(family);
        }
    }
    None
}

/// Resolve the user's encoder preference into a concrete encoder name and
/// quality args, falling back to software if the requested HW path isn't
/// available for this codec or this build of ffmpeg.
///
/// `crf == 0` (lossless) always uses the software encoder regardless of the HW
/// preference: HW lossless support varies wildly across drivers and gives
/// inconsistent results. Software lossless via libx264/libx265 is reliable.
fn resolve_encoder_args(
    codec: &Codec,
    crf: u32,
    choice: HwEncoder,
    support: &HwSupport,
) -> Vec<String> {
    if crf == 0 {
        return software_args(codec, crf);
    }

    let family = match choice {
        HwEncoder::None => return software_args(codec, crf),
        HwEncoder::Auto => match auto_pick_family(codec, support) {
            Some(f) => f,
            None    => return software_args(codec, crf),
        },
        explicit => {
            let supported = match explicit {
                HwEncoder::Nvenc => support.nvenc,
                HwEncoder::Qsv   => support.qsv,
                HwEncoder::Amf   => support.amf,
                _                => false,
            };
            if !supported || codec.hw_encoder_name(explicit).is_none() {
                return software_args(codec, crf);
            }
            explicit
        }
    };

    let encoder = codec.hw_encoder_name(family).unwrap();
    let qp      = crf.to_string();

    let mut args: Vec<String> = vec!["-c:v".into(), encoder.into()];
    match family {
        // NVENC: constant-QP rate control (-rc constqp + -qp). CRF maps to QP
        // closely enough across the 0–51 range for our purposes.
        HwEncoder::Nvenc => args.extend(["-rc".into(), "constqp".into(), "-qp".into(), qp]),
        // QSV: -global_quality is its constant-quality (CRF-equivalent) knob.
        HwEncoder::Qsv   => args.extend(["-global_quality".into(), qp]),
        // AMF: constant-QP mode requires QP for I/P/B frames separately.
        HwEncoder::Amf   => args.extend([
            "-rc".into(),    "cqp".into(),
            "-qp_i".into(),  qp.clone(),
            "-qp_p".into(),  qp.clone(),
            "-qp_b".into(),  qp,
        ]),
        _ => unreachable!(),
    }
    args
}

fn software_args(codec: &Codec, crf: u32) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-c:v".into(),  codec.software_encoder().into(),
        "-crf".into(),  crf.to_string(),
    ];
    // libvpx-vp9 only honours -crf as a quality target when the bitrate ceiling
    // is set to 0 (constant-quality mode); without this it produces a tiny,
    // bitrate-capped file.
    if matches!(codec, Codec::Vp9) {
        args.extend(["-b:v".into(), "0".into()]);
    }
    // crf 0 = lossless; veryslow squeezes out the best compression.
    // Note: -preset is only valid for libx264/libx265, not libvpx-vp9.
    if crf == 0 && !matches!(codec, Codec::Vp9) {
        args.extend(["-preset".into(), "veryslow".into()]);
    }
    args
}

// ── Path resolution ───────────────────────────────────────────────────────────

/// Returns the path to the bundled `ffmpeg.exe`.
///
/// Search order:
///   1. `<app_dir>/ffmpeg/bin/ffmpeg.exe` — resource_dir (production bundle)
///   2. Walk up from the current exe — covers dev mode where the project's
///      `ffmpeg/bin/ffmpeg.exe` is several directories above the debug binary.
pub fn find_ffmpeg(app_dir: &Path) -> Result<PathBuf, String> {
    // 1. Bundled in resource_dir (production).
    let bundled = app_dir.join("ffmpeg").join("bin").join("ffmpeg.exe");
    if bundled.exists() {
        return Ok(bundled);
    }

    // 2. Walk up from the current exe (dev mode).
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(Path::to_path_buf);
        while let Some(d) = dir {
            let candidate = d.join("ffmpeg").join("bin").join("ffmpeg.exe");
            if candidate.exists() {
                return Ok(candidate);
            }
            // Also try without the bin/ subdirectory
            let candidate_flat = d.join("ffmpeg").join("ffmpeg.exe");
            if candidate_flat.exists() {
                return Ok(candidate_flat);
            }
            dir = d.parent().map(Path::to_path_buf);
        }
    }

    // Log the full search path locally for debugging, but return a generic
    // message to the frontend so we don't leak the user's home directory.
    eprintln!(
        "ffmpeg not found. Searched: {} (and parent directories of the current exe).",
        bundled.display()
    );
    Err("ffmpeg not found. See README for setup instructions.".to_string())
}

// ── Filename pattern expansion ────────────────────────────────────────────────

/// Chars Windows forbids in file names, plus path separators (which would let
/// the pattern escape the chosen output directory).
const ILLEGAL_FILENAME_CHARS: &[char] =
    &['/', '\\', ':', '|', '<', '>', '?', '*', '"'];

/// Expand `{original}` → `stem` and `{n}` → 1-based `index`, appending `ext`.
///
/// After substitution the result is sanitised:
///   - path separators (`/`, `\`) and Windows-illegal chars are replaced with `_`
///   - control chars (`< 0x20`) are replaced with `_`
///   - leading/trailing whitespace and trailing dots are stripped (Windows rejects them)
///   - returns `Err` if the result would be empty, `.`, or `..`
///
/// This is the single defence against pattern-injection writing files outside
/// the chosen output directory.
pub fn expand_filename(
    pattern: &str,
    stem: &str,
    index: usize,
    ext: &str,
) -> Result<String, String> {
    let raw = pattern
        .replace("{original}", stem)
        .replace("{n}", &index.to_string());

    let sanitised: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || ILLEGAL_FILENAME_CHARS.contains(&c) {
                '_'
            } else {
                c
            }
        })
        .collect();

    let trimmed = sanitised.trim().trim_end_matches('.');
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err(format!(
            "Filename pattern '{pattern}' produces an invalid filename"
        ));
    }

    Ok(trimmed.to_string() + ext)
}

// ── ffmpeg argument builders ──────────────────────────────────────────────────

fn build_segment_args(
    input: &str,
    output: &str,
    seg: &SegmentRange,
    params: &ExportParams,
    source_ext: &str,
    hw_support: &HwSupport,
) -> Vec<String> {
    let mut args = vec![
        "-ss".into(),
        format!("{:.6}", seg.start),
        "-to".into(),
        format!("{:.6}", seg.end),
        "-i".into(),
        input.to_string(),
    ];

    match params.codec_mode {
        CodecMode::Copy => {
            args.extend(["-c".into(), "copy".into(), "-avoid_negative_ts".into(), "make_zero".into()]);
        }
        CodecMode::Reencode => {
            let codec     = params.codec.as_ref().unwrap_or(&Codec::H264);
            let crf       = params.crf.unwrap_or(23);
            let choice    = params.hw_encoder.unwrap_or(HwEncoder::None);
            let container = params.container.unwrap_or(Container::Source);

            args.extend(resolve_encoder_args(codec, crf, choice, hw_support));
            args.extend(["-c:a".into(), container.audio_encoder(source_ext).into()]);
        }
    }

    args.extend(["-y".into(), output.to_string()]);
    args
}

fn build_merge_args(list_file: &str, output: &str) -> Vec<String> {
    vec![
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        list_file.to_string(),
        "-c".into(),
        "copy".into(),
        "-y".into(),
        output.to_string(),
    ]
}

// ── Progress parsing ──────────────────────────────────────────────────────────

/// Parse `time=HH:MM:SS.mmm` from a line of ffmpeg stderr output.
fn parse_time_pos(line: &str) -> Option<f64> {
    let prefix = "time=";
    let start  = line.find(prefix)? + prefix.len();
    let rest   = &line[start..];
    // time field ends at next space or end of string
    let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
    let ts  = &rest[..end]; // "HH:MM:SS.mmm"

    let parts: Vec<&str> = ts.splitn(3, ':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h:  f64 = parts[0].parse().ok()?;
    let m:  f64 = parts[1].parse().ok()?;
    let s:  f64 = parts[2].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

// ── Progress event payload ────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct ExportProgressPayload {
    pub percent: f64,
}

// ── Core export logic ─────────────────────────────────────────────────────────

fn run_ffmpeg_with_progress(
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

    // ffmpeg writes its in-progress status as `frame=… time=…\r` (carriage
    // return, no newline) — only the final line of each segment ends in `\n`.
    // BufReader::lines() splits on `\n` only, so it would never see mid-segment
    // updates and the progress bar would jump 0 → 100 per segment. Read raw
    // bytes and split on either terminator instead.
    let stderr = child.stderr.take()
        .ok_or_else(|| "ffmpeg stderr not available (internal error)".to_string())?;
    let mut reader = BufReader::new(stderr);
    let mut line_buf: Vec<u8> = Vec::with_capacity(256);

    // ffmpeg writes progress lines ending with `\r` (no newline until the end
    // of a segment). Read into a 4 KiB buffer rather than one byte at a time
    // to avoid per-character syscall overhead on long encodes.
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
        return Err(format!("ffmpeg exited with status {status}"));
    }

    Ok(())
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

    // Resolve the chosen output container into a concrete file extension.
    // `Source` keeps the input's extension (the historical behavior).
    let container = params.container.unwrap_or(Container::Source);
    let out_ext   = container.extension(&source_ext);

    // Defense-in-depth codec/container compatibility check. The frontend
    // constrains codec choices by container, but a stale/forged payload (or the
    // "Same as source" path resolving to an mp4 input with VP9 selected) could
    // still ask for a muxer-incompatible combo. Fail with a clear message
    // instead of an opaque ffmpeg "Could not find tag for codec" error.
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
    // Combined with expand_filename's path-separator stripping, this is the
    // defence against the frontend writing files outside the chosen folder.
    let output_dir = Path::new(&params.output_dir)
        .canonicalize()
        .map_err(|e| format!("Output directory invalid: {e}"))?;
    if !output_dir.is_dir() {
        return Err(format!(
            "Output path is not a directory: {}",
            output_dir.display()
        ));
    }

    let total_segs = params.segments.len();

    // --- Separate files mode ---
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
    // Temp files (per-segment intermediates and the concat list) are tracked
    // in this guard so they're removed on every exit path — including errors
    // mid-merge that would otherwise leave junk in the user's output dir.
    let mut cleanup = TempCleanup::new();

    // Step 1: export each segment as a temp file. The temp segments use the
    // chosen output container so the final `-c copy` concat lands in a
    // consistent container (and so re-encoded streams sit in their target
    // muxer). In copy mode this also means an incompatible container choice
    // surfaces here as an ffmpeg error rather than silently.
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
            total_segs + 1, // +1 for the final merge step
            app,
        )?;
        temp_files.push(tmp_path);
    }

    // Step 2: write concat list file.
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

    // Step 3: merge.
    let merged_name = expand_filename(&params.filename_pattern, &stem, 1, &out_ext)?;
    let merged_out  = output_dir.join(&merged_name);
    let merge_args  = build_merge_args(
        &list_path.to_string_lossy(),
        &merged_out.to_string_lossy(),
    );
    run_ffmpeg_with_progress(ffmpeg_path, &merge_args, 0.0, total_segs, total_segs + 1, app)?;

    // Cleanup runs via TempCleanup::Drop on the way out (success or error).
    let _ = app.emit("export-progress", ExportProgressPayload { percent: 100.0 });
    Ok(())
}

/// RAII guard that removes any tracked paths when dropped. Used by the merge
/// export path so that an early `?` return (or a panic) doesn't leak temp
/// segments and the concat list file in the user's output directory.
struct TempCleanup {
    paths: Vec<PathBuf>,
}

impl TempCleanup {
    fn new() -> Self {
        Self { paths: Vec::new() }
    }
    fn track(&mut self, p: PathBuf) {
        self.paths.push(p)
    }
}

impl Drop for TempCleanup {
    fn drop(&mut self) {
        for p in &self.paths {
            let _ = std::fs::remove_file(p);
        }
    }
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

    // Validate every segment up-front. ffmpeg silently produces empty output for
    // negative/inverted/NaN times, so we have to catch them here.
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

    // Recover from a poisoned mutex (a previous panic while holding the lock)
    // rather than failing the export with an opaque error.
    let (ffmpeg_path, hw_support) = {
        let guard = state.lock().unwrap_or_else(|e| e.into_inner());
        (guard.ffmpeg_path.clone(), guard.hw_support.clone())
    };
    let ffmpeg_path = ffmpeg_path
        .ok_or_else(|| "ffmpeg not found. See README for setup instructions.".to_string())?;

    // The path is resolved at startup, but the user may have moved or deleted
    // ffmpeg.exe since then.
    if !ffmpeg_path.exists() {
        return Err(
            "ffmpeg.exe was located at startup but is no longer present. \
             Please verify the file exists and restart the app."
                .to_string(),
        );
    }

    // Run in a blocking thread so we don't block the async executor.
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

#[tauri::command]
pub async fn pick_output_dir(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    // blocking_pick_folder is synchronous; running it directly in the async
    // command body parks a Tauri runtime worker thread until the user picks
    // (or cancels). Move it onto the blocking pool.
    let folder = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;

    // Use into_path() rather than to_string() — on some platforms FilePath's
    // Display/ToString gives a URI ("file:///…") instead of a filesystem path,
    // which would cause canonicalize() to fail when the user starts an export.
    let path = folder
        .map(|p| p.into_path().map(|pb| pb.to_string_lossy().into_owned()))
        .transpose()
        .map_err(|e| e.to_string())?;
    Ok(path)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

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
    fn expand_filename_substitutes() {
        assert_eq!(
            expand_filename("{original}_segment_{n}", "myvideo", 2, ".mp4").unwrap(),
            "myvideo_segment_2.mp4"
        );
    }

    #[test]
    fn expand_filename_strips_path_separators() {
        // A pattern that tries to traverse out of the chosen output dir.
        let r = expand_filename("../bad/{n}", "video", 1, ".mp4").unwrap();
        assert!(!r.contains('/'), "got {r}");
        assert!(!r.contains('\\'), "got {r}");
    }

    #[test]
    fn expand_filename_strips_illegal_windows_chars() {
        let r = expand_filename("a:b|c<d>e?f*g\"h_{n}", "video", 1, ".mp4").unwrap();
        for bad in [':', '|', '<', '>', '?', '*', '"'] {
            assert!(!r.contains(bad), "char {bad:?} survived in {r}");
        }
    }

    #[test]
    fn expand_filename_strips_control_chars() {
        let r = expand_filename("a\nb\tc\0d_{n}", "video", 1, ".mp4").unwrap();
        assert!(!r.chars().any(|c| c.is_control()), "got {r}");
    }

    #[test]
    fn expand_filename_rejects_empty_or_dot_only() {
        assert!(expand_filename("", "video", 1, ".mp4").is_err());
        assert!(expand_filename(".", "video", 1, ".mp4").is_err());
        assert!(expand_filename("..", "video", 1, ".mp4").is_err());
        // After substitution and stripping, "/" becomes "_" — that's a valid name.
        // But "/.." becomes "_.." which trimmed of trailing dots is "_"... ok also valid.
        // Stem-only with empty input pattern:
        assert!(expand_filename("{original}", "", 1, ".mp4").is_err());
    }

    #[test]
    fn expand_filename_strips_trailing_dots_and_whitespace() {
        // Windows rejects names ending in '.' or whitespace.
        let r = expand_filename("video.{n}.  ", "video", 3, ".mp4").unwrap();
        // "video.3.  " → trim → "video.3." → trim_end('.') → "video.3" → + ".mp4"
        assert_eq!(r, "video.3.mp4");
    }

    #[test]
    fn build_merge_args_shape() {
        let args = build_merge_args("/tmp/list.txt", "/tmp/out.mp4");
        let expected: Vec<String> = [
            "-f", "concat", "-safe", "0", "-i", "/tmp/list.txt", "-c", "copy", "-y",
            "/tmp/out.mp4",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(args, expected);
    }

    #[test]
    fn temp_cleanup_removes_tracked_files_on_drop() {
        let dir = std::env::temp_dir();
        let f1 = dir.join("__edit_test_cleanup_1.tmp");
        let f2 = dir.join("__edit_test_cleanup_2.tmp");
        std::fs::write(&f1, b"x").unwrap();
        std::fs::write(&f2, b"y").unwrap();
        assert!(f1.exists() && f2.exists());
        {
            let mut g = TempCleanup::new();
            g.track(f1.clone());
            g.track(f2.clone());
        } // drop runs here
        assert!(!f1.exists(), "f1 should be cleaned up");
        assert!(!f2.exists(), "f2 should be cleaned up");
    }

    #[test]
    fn parse_time_pos_handles_carriage_return_line() {
        // Realistic ffmpeg progress line ends in `\r` not `\n` — we strip
        // terminators before calling parse_time_pos, but it should also be
        // tolerant of trailing whitespace.
        let line = "frame=  10 fps=30 q=-1.0 size=N/A time=00:00:01.500 bitrate=N/A speed=1x";
        let t = parse_time_pos(line).unwrap();
        assert!((t - 1.5).abs() < 0.001, "got {t}");
    }

    fn make_params(
        codec_mode: CodecMode,
        codec: Option<Codec>,
        crf: Option<u32>,
        container: Option<Container>,
        hw_encoder: Option<HwEncoder>,
    ) -> ExportParams {
        ExportParams {
            file_path: "in.mp4".into(),
            output_dir: "/out".into(),
            segments: vec![],
            export_mode: ExportMode::Separate,
            codec_mode,
            codec,
            crf,
            container,
            filename_pattern: "{original}_{n}".into(),
            hw_encoder,
        }
    }

    #[test]
    fn build_segment_args_copy() {
        let seg = SegmentRange { start: 1.0, end: 5.0 };
        let params = make_params(CodecMode::Copy, None, None, None, None);
        let args = build_segment_args("in.mp4", "out.mp4", &seg, &params, ".mp4", &HwSupport::default());
        assert!(args.contains(&"-c".to_string()));
        assert!(args.contains(&"copy".to_string()));
        assert!(args.contains(&"-ss".to_string()));
    }

    #[test]
    fn build_segment_args_reencode_software_default() {
        let seg = SegmentRange { start: 0.0, end: 10.0 };
        let params = make_params(
            CodecMode::Reencode,
            Some(Codec::H264),
            Some(18),
            None,  // container unspecified → Source
            None,  // hw unspecified → software
        );
        let args = build_segment_args("in.mp4", "out.mp4", &seg, &params, ".mp4", &HwSupport::default());
        assert!(args.contains(&"libx264".to_string()));
        assert!(args.contains(&"-crf".to_string()));
        assert!(args.contains(&"18".to_string()));
        assert!(args.contains(&"aac".to_string()));
    }

    #[test]
    fn build_segment_args_reencode_webm_uses_opus() {
        let seg = SegmentRange { start: 0.0, end: 10.0 };
        let params = make_params(
            CodecMode::Reencode,
            Some(Codec::Vp9),
            Some(23),
            Some(Container::Webm),
            None,
        );
        let args = build_segment_args("in.mkv", "out.webm", &seg, &params, ".mkv", &HwSupport::default());
        assert!(args.contains(&"libvpx-vp9".to_string()));
        assert!(args.contains(&"libopus".to_string()), "webm must use opus, got {args:?}");
        assert!(!args.contains(&"aac".to_string()), "webm must not use aac");
    }

    #[test]
    fn container_extension_source_keeps_input_ext() {
        assert_eq!(Container::Source.extension(".mkv"), ".mkv");
        assert_eq!(Container::Source.extension(".mov"), ".mov");
    }

    #[test]
    fn container_extension_explicit_overrides() {
        assert_eq!(Container::Mp4.extension(".mkv"), ".mp4");
        assert_eq!(Container::Mkv.extension(".mp4"), ".mkv");
        assert_eq!(Container::Webm.extension(".mp4"), ".webm");
    }

    #[test]
    fn container_audio_encoder_webm_is_opus() {
        assert_eq!(Container::Webm.audio_encoder(".mp4"), "libopus");
        assert_eq!(Container::Mp4.audio_encoder(".mp4"), "aac");
        assert_eq!(Container::Mkv.audio_encoder(".webm"), "aac");
        // Source resolves by the input extension.
        assert_eq!(Container::Source.audio_encoder(".webm"), "libopus");
        assert_eq!(Container::Source.audio_encoder(".mp4"), "aac");
    }

    #[test]
    fn software_args_vp9_has_b_v_zero() {
        let args = software_args(&Codec::Vp9, 23);
        assert!(args.contains(&"libvpx-vp9".to_string()));
        // -b:v 0 is mandatory for libvpx-vp9 CRF mode.
        let bv = args.iter().position(|a| a == "-b:v").expect("missing -b:v");
        assert_eq!(args[bv + 1], "0");
    }

    #[test]
    fn software_args_non_vp9_has_no_b_v() {
        let args = software_args(&Codec::H264, 23);
        assert!(!args.contains(&"-b:v".to_string()));
    }

    #[test]
    fn resolve_encoder_args_explicit_nvenc() {
        let support = HwSupport { nvenc: true, qsv: false, amf: false };
        let args    = resolve_encoder_args(&Codec::H264, 23, HwEncoder::Nvenc, &support);
        assert!(args.contains(&"h264_nvenc".to_string()));
        assert!(args.contains(&"-qp".to_string()));
        assert!(args.contains(&"23".to_string()));
    }

    #[test]
    fn resolve_encoder_args_auto_picks_nvenc_first() {
        let support = HwSupport { nvenc: true, qsv: true, amf: true };
        let args    = resolve_encoder_args(&Codec::H264, 23, HwEncoder::Auto, &support);
        assert!(args.contains(&"h264_nvenc".to_string()), "expected NVENC priority, got {args:?}");
    }

    #[test]
    fn resolve_encoder_args_auto_falls_back_to_qsv_then_amf() {
        let only_qsv = HwSupport { nvenc: false, qsv: true, amf: false };
        let args = resolve_encoder_args(&Codec::H265, 23, HwEncoder::Auto, &only_qsv);
        assert!(args.contains(&"hevc_qsv".to_string()));
        assert!(args.contains(&"-global_quality".to_string()));

        let only_amf = HwSupport { nvenc: false, qsv: false, amf: true };
        let args = resolve_encoder_args(&Codec::H264, 23, HwEncoder::Auto, &only_amf);
        assert!(args.contains(&"h264_amf".to_string()));
        assert!(args.contains(&"-rc".to_string()) && args.contains(&"cqp".to_string()));
    }

    #[test]
    fn resolve_encoder_args_auto_falls_back_to_software_when_nothing_supports_codec() {
        // VP9 has no NVENC or AMF encoder; with no QSV support, must fall back.
        let support = HwSupport { nvenc: true, qsv: false, amf: true };
        let args = resolve_encoder_args(&Codec::Vp9, 23, HwEncoder::Auto, &support);
        assert!(args.contains(&"libvpx-vp9".to_string()));
        assert!(args.contains(&"-crf".to_string()));
    }

    #[test]
    fn resolve_encoder_args_explicit_unsupported_falls_back_to_software() {
        let no_support = HwSupport::default();
        let args = resolve_encoder_args(&Codec::H264, 23, HwEncoder::Nvenc, &no_support);
        assert!(args.contains(&"libx264".to_string()));
    }

    #[test]
    fn resolve_encoder_args_crf_zero_forces_software() {
        // crf 0 = lossless → software regardless of HW availability.
        let support = HwSupport { nvenc: true, qsv: true, amf: true };
        let args = resolve_encoder_args(&Codec::H264, 0, HwEncoder::Auto, &support);
        assert!(args.contains(&"libx264".to_string()));
        assert!(args.contains(&"0".to_string()));
        assert!(args.contains(&"-preset".to_string()) && args.contains(&"veryslow".to_string()));
    }

    #[test]
    fn software_args_vp9_crf_zero_has_no_preset() {
        let args = software_args(&Codec::Vp9, 0);
        assert!(!args.contains(&"-preset".to_string()),
            "libvpx-vp9 does not accept -preset; got: {:?}", args);
    }

    #[test]
    fn resolve_encoder_args_none_forces_software_even_with_hw_available() {
        let support = HwSupport { nvenc: true, qsv: true, amf: true };
        let args = resolve_encoder_args(&Codec::H264, 23, HwEncoder::None, &support);
        assert!(args.contains(&"libx264".to_string()));
        assert!(args.contains(&"-crf".to_string()));
    }
}
