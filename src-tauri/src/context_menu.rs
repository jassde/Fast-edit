//! Windows Explorer context-menu integration.
//!
//! Adds an "Edit with Video Trimmer" verb to the right-click menu for the
//! supported video extensions. Two scopes are supported:
//!
//! - **User** (`HKEY_CURRENT_USER`)  — current Windows user only, no admin needed.
//!   Direct `winreg` writes from the unelevated app process.
//! - **Machine** (`HKEY_LOCAL_MACHINE`) — all users on the machine, requires
//!   UAC elevation. The main app stays unelevated; we generate a small
//!   PowerShell script that uses the registry provider (`New-Item` +
//!   `RegistryKey.SetValue`) to write the entries, then run it in an elevated
//!   child PowerShell via `Start-Process -Verb RunAs`. The inner script's
//!   exceptions are written to a log file in `%TEMP%` so failures stay
//!   diagnosable even though the elevated child has no shared stdio with us.
//!
//! Reads (status checks) work without admin for both scopes — standard users
//! can read HKLM\Software by default.
//!
//! On non-Windows platforms the public commands are no-op stubs that return
//! errors / `false` so the rest of the app compiles unchanged.

use serde::{Deserialize, Serialize};

const VERB_NAME:  &str    = "Edit with Video Trimmer";
const EXTENSIONS: &[&str] = &["mp4", "webm", "mkv", "mov"];

#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    User,
    Machine,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct ContextMenuStatus {
    pub user:    bool,
    pub machine: bool,
}

// ── Windows implementation ───────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod imp {
    use super::{Scope, EXTENSIONS, VERB_NAME};
    use std::path::Path;
    use std::process::Command;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::{HKEY, RegKey};

    impl Scope {
        fn predef_hkey(self) -> HKEY {
            match self {
                Scope::User    => HKEY_CURRENT_USER,
                Scope::Machine => HKEY_LOCAL_MACHINE,
            }
        }
    }

    fn verb_subpath(ext: &str) -> String {
        format!("Software\\Classes\\.{ext}\\shell\\{VERB_NAME}")
    }

    pub fn is_registered(scope: Scope) -> bool {
        let root = RegKey::predef(scope.predef_hkey());
        EXTENSIONS.iter().any(|ext| {
            root.open_subkey_with_flags(verb_subpath(ext), KEY_READ).is_ok()
        })
    }

    pub fn register(scope: Scope, exe_path: &Path) -> Result<(), String> {
        let exe_str = exe_path
            .to_str()
            .ok_or_else(|| "Executable path contains invalid UTF-8".to_string())?;

        match scope {
            Scope::User    => register_hkcu_direct(exe_str),
            Scope::Machine => apply_via_elevated_ps_script(|log| register_ps_script(exe_str, log)),
        }
    }

    pub fn unregister(scope: Scope) -> Result<(), String> {
        match scope {
            Scope::User    => unregister_hkcu_direct(),
            Scope::Machine => apply_via_elevated_ps_script(|log| unregister_ps_script(log)),
        }
    }

    // ── HKCU direct (no elevation) ───────────────────────────────────────────

    fn register_hkcu_direct(exe_str: &str) -> Result<(), String> {
        // Both the exe path and the dropped %1 routinely contain spaces — wrap
        // each in quotes so Explorer's command parsing keeps them as one arg.
        let command_value = format!("\"{exe_str}\" \"%1\"");
        let icon_value    = format!("\"{exe_str}\",0");

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        for ext in EXTENSIONS {
            let verb_path = verb_subpath(ext);

            let (verb_key, _) = hkcu
                .create_subkey(&verb_path)
                .map_err(|e| format!("Failed to create verb key for .{ext}: {e}"))?;
            verb_key
                .set_value("", &VERB_NAME.to_string())
                .map_err(|e| format!("Failed to set verb label for .{ext}: {e}"))?;
            verb_key
                .set_value("Icon", &icon_value)
                .map_err(|e| format!("Failed to set verb icon for .{ext}: {e}"))?;

            let cmd_path = format!("{verb_path}\\command");
            let (cmd_key, _) = hkcu
                .create_subkey(&cmd_path)
                .map_err(|e| format!("Failed to create command key for .{ext}: {e}"))?;
            cmd_key
                .set_value("", &command_value)
                .map_err(|e| format!("Failed to set command for .{ext}: {e}"))?;
        }

        Ok(())
    }

    fn unregister_hkcu_direct() -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for ext in EXTENSIONS {
            match hkcu.delete_subkey_all(verb_subpath(ext)) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Failed to remove verb for .{ext}: {e}")),
            }
        }
        Ok(())
    }

    // ── HKLM via elevated PowerShell registry-provider script ────────────────
    //
    // Originally this used a generated `.reg` file imported via elevated
    // `reg.exe import`. That was unreliable: `reg.exe`'s "Version 5.00" parser
    // expects UTF-16 LE, and when handed UTF-8 it sometimes returns success
    // while writing nothing. We now bake a small PowerShell script that calls
    // `New-Item` + `RegistryKey.SetValue` directly through the registry
    // provider, then run that script in an elevated child PowerShell. No file
    // format parsing, no encoding ambiguity — values land via .NET APIs.

    /// Single-quote a string for safe embedding in a PowerShell single-quoted
    /// string literal. PS escapes a single quote inside `'…'` by doubling it.
    fn ps_single_quote(s: &str) -> String {
        format!("'{}'", s.replace('\'', "''"))
    }

    /// Wrap a script body in a try/catch that writes any exception to the
    /// given log path so the unelevated parent can read it back. Without
    /// this, the elevated child's stderr disappears into the void (no
    /// stdio handoff through `Start-Process -Verb RunAs`).
    fn ps_with_log_capture(log_q: &str, body: &str) -> String {
        // `{{` / `}}` are Rust format-string escapes for literal `{` / `}`.
        format!(
r#"$ErrorActionPreference = 'Stop'
$logPath = {log_q}
try {{
{body}
}} catch {{
    "FAILED: $($_.Exception.Message)`r`n$($_.ScriptStackTrace)" | Out-File -FilePath $logPath -Encoding utf8 -Force
    throw
}}
"#
        )
    }

    fn register_ps_script(exe_str: &str, log_path: &str) -> String {
        let exe_q  = ps_single_quote(exe_str);
        let verb_q = ps_single_quote(VERB_NAME);
        let log_q  = ps_single_quote(log_path);
        let body = format!(
r#"    $exe  = {exe_q}
    $verb = {verb_q}
    $cmdValue  = '"' + $exe + '" "%1"'
    $iconValue = '"' + $exe + '",0'
    $exts = @('.mp4', '.webm', '.mkv', '.mov')
    foreach ($ext in $exts) {{
        $verbPath = "HKLM:\Software\Classes\$ext\shell\$verb"
        $cmdPath  = "$verbPath\command"
        $verbKey = New-Item -Path $verbPath -Force
        $verbKey.SetValue('',     $verb,      'String')
        $verbKey.SetValue('Icon', $iconValue, 'String')
        $cmdKey  = New-Item -Path $cmdPath  -Force
        $cmdKey.SetValue('',  $cmdValue, 'String')
    }}"#
        );
        ps_with_log_capture(&log_q, &body)
    }

    fn unregister_ps_script(log_path: &str) -> String {
        let verb_q = ps_single_quote(VERB_NAME);
        let log_q  = ps_single_quote(log_path);
        let body = format!(
r#"    $verb = {verb_q}
    $exts = @('.mp4', '.webm', '.mkv', '.mov')
    foreach ($ext in $exts) {{
        $verbPath = "HKLM:\Software\Classes\$ext\shell\$verb"
        if (Test-Path -LiteralPath $verbPath) {{
            Remove-Item -LiteralPath $verbPath -Recurse -Force
        }}
    }}"#
        );
        ps_with_log_capture(&log_q, &body)
    }

    /// RAII guard that removes a temp file on drop, so an early `?` return
    /// (or panic) doesn't leak the temp file in `%TEMP%`.
    struct TempFileGuard(std::path::PathBuf);
    impl Drop for TempFileGuard {
        fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
    }

    /// Allocate a log file path, build the script (with that log path baked
    /// in via the `make_script` closure), write it to a temp `.ps1`, then
    /// launch an elevated child PowerShell via `Start-Process -Verb RunAs`.
    /// Blocks until the child exits and propagates its exit code.
    ///
    /// On failure we read the log file the inner script wrote to, so the
    /// caller sees the actual exception message — without this, the elevated
    /// child's stderr is invisible (no shared stdio across UAC).
    ///
    /// The script path is passed to the outer PS via env var to avoid
    /// quoting issues. The elevated child runs with `-ExecutionPolicy Bypass`
    /// so a Restricted machine policy doesn't refuse to run our temp script.
    fn apply_via_elevated_ps_script<F>(make_script: F) -> Result<(), String>
    where
        F: FnOnce(&str) -> String,
    {
        // PID-stamped names keep concurrent toggles from the same app from
        // colliding and are easy to grep in %TEMP% if debugging is needed.
        let pid       = std::process::id();
        let tmp_path  = std::env::temp_dir().join(format!("video-trimmer-ctxmenu-{pid}.ps1"));
        let log_path  = std::env::temp_dir().join(format!("video-trimmer-ctxmenu-log-{pid}.txt"));

        let log_str = log_path
            .to_str()
            .ok_or_else(|| "Temp log path contains invalid UTF-8".to_string())?;
        let script_content = make_script(log_str);

        std::fs::write(&tmp_path, &script_content)
            .map_err(|e| format!("Failed to write temp PS script: {e}"))?;
        let _script_cleanup = TempFileGuard(tmp_path.clone());
        let _log_cleanup    = TempFileGuard(log_path.clone());

        let tmp_str = tmp_path
            .to_str()
            .ok_or_else(|| "Temp PS script path contains invalid UTF-8".to_string())?;

        // Outer PS: elevate a child PS that runs our script. `-PassThru` lets
        // us read the child's exit code; `Stop` turns UAC denial into a script
        // termination so we get a non-zero exit at the outer level too.
        const OUTER_PS: &str = concat!(
            "$ErrorActionPreference='Stop'; ",
            "$p = Start-Process -Wait -PassThru -Verb RunAs ",
            "-FilePath 'powershell.exe' ",
            "-ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$env:VT_PS_SCRIPT); ",
            "exit $p.ExitCode"
        );

        let output = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", OUTER_PS])
            .env("VT_PS_SCRIPT", tmp_str)
            .output()
            .map_err(|e| format!("Failed to spawn powershell: {e}"))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("canceled by the user")
            || stderr.contains("operation was canceled")
        {
            return Err("Elevation was canceled.".to_string());
        }

        // The child's exception (if any) was written to log_path by the
        // try/catch wrapper in ps_with_log_capture. Read it back if present.
        let log_content = std::fs::read_to_string(&log_path)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let exit = output.status.code().unwrap_or(-1);
        match log_content {
            Some(detail) => Err(format!(
                "Elevated registry update failed (exit {exit}): {detail}"
            )),
            None => Err(format!(
                "Elevated registry update failed (exit {exit}): {}",
                stderr.trim()
            )),
        }
    }
}

// ── Non-Windows stubs ────────────────────────────────────────────────────────

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::Scope;
    use std::path::Path;

    pub fn is_registered(_scope: Scope) -> bool { false }

    pub fn register(_scope: Scope, _exe_path: &Path) -> Result<(), String> {
        Err("Context-menu integration is only supported on Windows.".to_string())
    }

    pub fn unregister(_scope: Scope) -> Result<(), String> {
        Err("Context-menu integration is only supported on Windows.".to_string())
    }
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn register_context_menu(scope: Scope) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Failed to resolve current executable path: {e}"))?;
    imp::register(scope, &exe)
}

#[tauri::command]
pub fn unregister_context_menu(scope: Scope) -> Result<(), String> {
    imp::unregister(scope)
}

#[tauri::command]
pub fn context_menu_status() -> ContextMenuStatus {
    ContextMenuStatus {
        user:    imp::is_registered(Scope::User),
        machine: imp::is_registered(Scope::Machine),
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::Scope;

    // The PS script generators are exercised end-to-end by an elevated
    // PowerShell child when the Settings toggle runs (too heavy for a unit
    // test — would need a real UAC prompt and HKLM writes). What we CAN test
    // cheaply is the Scope serde contract, so the frontend payload format
    // can't drift from the Rust enum without a build break here.

    #[test]
    fn scope_deserializes_from_lowercase() {
        let user: Scope = serde_json::from_str("\"user\"").unwrap();
        assert_eq!(user, Scope::User);
        let machine: Scope = serde_json::from_str("\"machine\"").unwrap();
        assert_eq!(machine, Scope::Machine);
    }
}
