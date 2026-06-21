use super::types::{Codec, CodecMode, Container, ExportParams, HwEncoder, HwSupport, SegmentRange};

/// Auto priority order: NVENC → QSV → AMF.
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
/// quality args. `crf == 0` (lossless) always uses the software encoder
/// regardless of the HW preference — HW lossless support varies wildly.
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
        HwEncoder::Nvenc => args.extend(["-rc".into(), "constqp".into(), "-qp".into(), qp]),
        HwEncoder::Qsv   => args.extend(["-global_quality".into(), qp]),
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
    if matches!(codec, Codec::Vp9) {
        args.extend(["-b:v".into(), "0".into()]);
    }
    if crf == 0 && !matches!(codec, Codec::Vp9) {
        args.extend(["-preset".into(), "veryslow".into()]);
    }
    args
}

pub(crate) fn build_segment_args(
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

pub(crate) fn build_merge_args(list_file: &str, output: &str) -> Vec<String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::ExportMode;

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
            None,
            None,
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
    fn software_args_vp9_has_b_v_zero() {
        let args = software_args(&Codec::Vp9, 23);
        assert!(args.contains(&"libvpx-vp9".to_string()));
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
