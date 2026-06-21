use std::path::PathBuf;

use serde::{Deserialize, Serialize};

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
    pub(crate) fn software_encoder(&self) -> &'static str {
        match self {
            Codec::H264 => "libx264",
            Codec::H265 => "libx265",
            Codec::Vp9  => "libvpx-vp9",
        }
    }

    pub(crate) fn hw_encoder_name(&self, family: HwEncoder) -> Option<&'static str> {
        match (self, family) {
            (Codec::H264, HwEncoder::Nvenc) => Some("h264_nvenc"),
            (Codec::H265, HwEncoder::Nvenc) => Some("hevc_nvenc"),
            (Codec::H264, HwEncoder::Qsv)   => Some("h264_qsv"),
            (Codec::H265, HwEncoder::Qsv)   => Some("hevc_qsv"),
            (Codec::Vp9,  HwEncoder::Qsv)   => Some("vp9_qsv"),
            (Codec::H264, HwEncoder::Amf)   => Some("h264_amf"),
            (Codec::H265, HwEncoder::Amf)   => Some("hevc_amf"),
            _ => None,
        }
    }
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Container {
    Source,
    Mp4,
    Mkv,
    Webm,
}

impl Container {
    pub(crate) fn extension(&self, source_ext: &str) -> String {
        match self {
            Container::Source => source_ext.to_string(),
            Container::Mp4    => ".mp4".to_string(),
            Container::Mkv    => ".mkv".to_string(),
            Container::Webm   => ".webm".to_string(),
        }
    }

    pub(crate) fn audio_encoder(&self, source_ext: &str) -> &'static str {
        let is_webm = match self {
            Container::Webm   => true,
            Container::Source => source_ext.eq_ignore_ascii_case(".webm"),
            _                 => false,
        };
        if is_webm { "libopus" } else { "aac" }
    }
}

#[derive(Default)]
pub struct FfmpegState {
    pub ffmpeg_path: Option<PathBuf>,
    pub hw_support:  HwSupport,
}

#[derive(Serialize, Clone)]
pub struct ExportProgressPayload {
    pub percent: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(Container::Source.audio_encoder(".webm"), "libopus");
        assert_eq!(Container::Source.audio_encoder(".mp4"), "aac");
    }
}
