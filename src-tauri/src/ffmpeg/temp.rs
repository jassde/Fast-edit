use std::path::PathBuf;

/// Chars Windows forbids in file names, plus path separators (which would let
/// the pattern escape the chosen output directory).
const ILLEGAL_FILENAME_CHARS: &[char] =
    &['/', '\\', ':', '|', '<', '>', '?', '*', '"'];

/// Expand `{original}` → `stem` and `{n}` → 1-based `index`, appending `ext`.
///
/// After substitution the result is sanitised: path separators and Windows-illegal
/// chars become `_`, control chars become `_`, leading/trailing whitespace and
/// trailing dots are stripped, and empty/`./..` results are rejected.
///
/// This is the single defence against pattern-injection writing files outside
/// the chosen output directory.
pub(crate) fn expand_filename(
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

/// RAII guard that removes any tracked paths when dropped. Used by the merge
/// export path so that an early `?` return (or a panic) doesn't leak temp
/// segments and the concat list file in the user's output directory.
pub(crate) struct TempCleanup {
    paths: Vec<PathBuf>,
}

impl TempCleanup {
    pub(crate) fn new() -> Self {
        Self { paths: Vec::new() }
    }
    pub(crate) fn track(&mut self, p: PathBuf) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_filename_substitutes() {
        assert_eq!(
            expand_filename("{original}_segment_{n}", "myvideo", 2, ".mp4").unwrap(),
            "myvideo_segment_2.mp4"
        );
    }

    #[test]
    fn expand_filename_strips_path_separators() {
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
        assert!(expand_filename("{original}", "", 1, ".mp4").is_err());
    }

    #[test]
    fn expand_filename_strips_trailing_dots_and_whitespace() {
        let r = expand_filename("video.{n}.  ", "video", 3, ".mp4").unwrap();
        assert_eq!(r, "video.3.mp4");
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
        }
        assert!(!f1.exists(), "f1 should be cleaned up");
        assert!(!f2.exists(), "f2 should be cleaned up");
    }
}
