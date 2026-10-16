//! Direct receive and the Windows firewall (TRANSFER-001 S6).
//!
//! The LAN listener binds TCP 53318 on every interface. Windows only lets a tablet reach it
//! when an inbound rule allows the program (or the port) on the active network profile, so
//! this module (a) reports whether that is the case and (b) adds the missing rule through ONE
//! elevated helper. The app itself is never elevated: a fixed PowerShell script is built here
//! in Rust, wrapped in `-EncodedCommand`, and started with `Start-Process -Verb RunAs` (a
//! ShellExecute `runas`), so Windows shows a single UAC prompt. No user input reaches a script;
//! the only variable is this program's own path, which is single-quote escaped.
//!
//! Output of the non-elevated status probe is locale-independent `key=value` lines.

use serde::Serialize;

/// What the UI needs to know about direct receive on this PC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DirectReceive {
    Unknown,
    Allowed,
    /// The firewall would drop a tablet's connection (no allow rule, or a program block rule).
    Blocked,
    /// Every active network is Public, so a Private-profile rule cannot help.
    Public,
    /// Not Windows, or the LAN listener is not running.
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OpenOutcome {
    Opened,
    /// The user declined the administrator prompt.
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenResult {
    pub outcome: OpenOutcome,
    pub state: DirectReceive,
}

/// Display name of the allow rule this module adds (and replaces when it exists).
const RULE_NAME: &str = "Lakomics direct receive";

/// Exit codes of the launcher script.
const EXIT_CANCELLED: i32 = 3;

/// Non-elevated probe. Reads this program's path from `LAKOMICS_EXE` (never interpolated).
const STATUS_SCRIPT: &str = r#"$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
if (-not (Get-Command Get-NetFirewallRule)) { 'ok=0'; exit 0 }
$exe = $env:LAKOMICS_EXE
$rules = @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -eq $exe } | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' })
$block = @($rules | Where-Object { $_.Action -eq 'Block' }).Count
$allow = @($rules | Where-Object { $_.Action -eq 'Allow' -and ("$($_.Profile)" -match 'Private|Domain|Any') }).Count
$categories = @(Get-NetConnectionProfile | ForEach-Object { "$($_.NetworkCategory)" })
$private = @($categories | Where-Object { $_ -ne 'Public' }).Count
'ok=1'
"block=$block"
"allow=$allow"
"profiles=$($categories.Count)"
"private=$private"
"#;

/// Reads the probe's output. `None` when the probe did not run (no firewall cmdlets, odd output).
pub(super) fn parse_status(output: &str) -> Option<DirectReceive> {
    let mut ok = false;
    let (mut block, mut allow, mut profiles, mut private) = (None, None, None, None);
    for line in output.lines() {
        let Some((key, value)) = line.trim().split_once('=') else {
            continue;
        };
        let number = value.trim().parse::<u32>().ok();
        match key.trim() {
            "ok" => ok = number == Some(1),
            "block" => block = number,
            "allow" => allow = number,
            "profiles" => profiles = number,
            "private" => private = number,
            _ => {}
        }
    }
    if !ok {
        return None;
    }
    let (block, allow) = (block?, allow?);
    // No connection at all says nothing about Public; judge by the rules.
    let only_public = profiles? > 0 && private? == 0;
    Some(if only_public {
        DirectReceive::Public
    } else if block > 0 || allow == 0 {
        DirectReceive::Blocked
    } else {
        DirectReceive::Allowed
    })
}

/// PowerShell single-quoted string literal for `value`.
fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// The elevated script: replace our rule, drop Windows' own block rules for this program
/// (a dismissed first-run firewall dialog creates them and they beat any allow rule), then allow
/// inbound TCP on the Private profile for this program.
pub(super) fn elevated_script(exe: &str, port: u16) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'\n\
         $exe = {exe}\n\
         $name = {name}\n\
         try {{\n\
         Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule\n\
         Get-NetFirewallApplicationFilter | Where-Object {{ $_.Program -eq $exe }} | Get-NetFirewallRule | Where-Object {{ $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }} | Remove-NetFirewallRule\n\
         New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort {port} -Profile Private -Program $exe | Out-Null\n\
         exit 0\n\
         }} catch {{ exit 1 }}\n",
        exe = quoted(exe),
        name = quoted(RULE_NAME),
    )
}

/// `-EncodedCommand` payload: base64 of the UTF-16LE script.
pub(super) fn encode_command(script: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * index)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Non-elevated launcher: starts the elevated script and waits for it. Exit 0 = done,
/// [`EXIT_CANCELLED`] = the user declined the prompt (Win32 error 1223), anything else = failure.
pub(super) fn launcher_script(encoded_elevated: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'\n\
         try {{\n\
         $process = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','{encoded_elevated}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru\n\
         exit $process.ExitCode\n\
         }} catch {{\n\
         $e = $_.Exception\n\
         while ($e) {{ if ($e -is [System.ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 1223) {{ exit {EXIT_CANCELLED} }}; $e = $e.InnerException }}\n\
         exit 4\n\
         }}\n"
    )
}

pub(super) fn outcome_from_exit(code: Option<i32>) -> OpenOutcome {
    match code {
        Some(0) => OpenOutcome::Opened,
        Some(EXIT_CANCELLED) => OpenOutcome::Cancelled,
        _ => OpenOutcome::Failed,
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        io::Read,
        os::windows::process::CommandExt,
        path::PathBuf,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const PROBE_TIMEOUT: Duration = Duration::from_secs(25);
    /// Long enough to read and answer the UAC prompt.
    const ELEVATE_TIMEOUT: Duration = Duration::from_secs(180);

    fn powershell() -> PathBuf {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe")
    }

    /// Runs an encoded script; `(exit code, stdout)`, `None` on spawn failure or timeout.
    fn run(
        script: &str,
        exe_env: Option<&str>,
        timeout: Duration,
    ) -> Option<(Option<i32>, String)> {
        let mut command = Command::new(powershell());
        command
            .args(["-NoProfile", "-NonInteractive", "-EncodedCommand"])
            .arg(encode_command(script))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        if let Some(exe) = exe_env {
            command.env("LAKOMICS_EXE", exe);
        }
        let mut child = command.spawn().ok()?;
        let mut stdout = child.stdout.take()?;
        let reader = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stdout.by_ref().take(16 * 1024).read_to_string(&mut text);
            text
        });
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if started.elapsed() < timeout => {
                    std::thread::sleep(Duration::from_millis(100))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
            }
        };
        let text = reader.join().unwrap_or_default();
        status.map(|status| (status.code(), text))
    }

    fn exe_path() -> Option<String> {
        std::env::current_exe()
            .ok()
            .map(|path| path.to_string_lossy().into_owned())
    }

    pub(super) fn status() -> DirectReceive {
        let Some(exe) = exe_path() else {
            return DirectReceive::Unknown;
        };
        run(STATUS_SCRIPT, Some(&exe), PROBE_TIMEOUT)
            .and_then(|(_, text)| parse_status(&text))
            .unwrap_or(DirectReceive::Unknown)
    }

    pub(super) fn open(port: u16) -> OpenOutcome {
        let Some(exe) = exe_path() else {
            return OpenOutcome::Failed;
        };
        let launcher = launcher_script(&encode_command(&elevated_script(&exe, port)));
        match run(&launcher, None, ELEVATE_TIMEOUT) {
            Some((code, _)) => outcome_from_exit(code),
            None => OpenOutcome::Failed,
        }
    }
}

/// Current state. `listening` is whether the LAN listener bound its port.
pub(super) fn status(listening: bool) -> DirectReceive {
    if !listening {
        return DirectReceive::Unsupported;
    }
    #[cfg(windows)]
    {
        windows::status()
    }
    #[cfg(not(windows))]
    {
        DirectReceive::Unsupported
    }
}

/// Runs the elevated helper once (one UAC prompt) and re-reads the state afterwards.
pub(super) fn open(listening: bool, port: u16) -> OpenResult {
    #[cfg(windows)]
    if listening {
        let outcome = windows::open(port);
        return OpenResult {
            outcome,
            state: status(true),
        };
    }
    let _ = (listening, port);
    OpenResult {
        outcome: OpenOutcome::Failed,
        state: DirectReceive::Unsupported,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(ok: u32, block: u32, allow: u32, profiles: u32, private: u32) -> String {
        format!("ok={ok}\r\nblock={block}\r\nallow={allow}\r\nprofiles={profiles}\r\nprivate={private}\r\n")
    }

    #[test]
    fn a_program_allow_rule_on_a_private_network_is_allowed() {
        assert_eq!(
            parse_status(&probe(1, 0, 1, 2, 1)),
            Some(DirectReceive::Allowed)
        );
    }

    #[test]
    fn no_allow_rule_or_a_program_block_rule_is_blocked() {
        assert_eq!(
            parse_status(&probe(1, 0, 0, 1, 1)),
            Some(DirectReceive::Blocked)
        );
        // The first-run dialog left a block rule next to an allow rule: the block wins.
        assert_eq!(
            parse_status(&probe(1, 2, 1, 1, 1)),
            Some(DirectReceive::Blocked)
        );
    }

    #[test]
    fn only_public_networks_are_public_whatever_the_rules_say() {
        assert_eq!(
            parse_status(&probe(1, 0, 1, 1, 0)),
            Some(DirectReceive::Public)
        );
        assert_eq!(
            parse_status(&probe(1, 1, 0, 2, 0)),
            Some(DirectReceive::Public)
        );
    }

    #[test]
    fn being_offline_is_judged_by_the_rules_alone() {
        assert_eq!(
            parse_status(&probe(1, 0, 0, 0, 0)),
            Some(DirectReceive::Blocked)
        );
        assert_eq!(
            parse_status(&probe(1, 0, 1, 0, 0)),
            Some(DirectReceive::Allowed)
        );
    }

    #[test]
    fn a_probe_that_did_not_run_is_unknown() {
        assert_eq!(parse_status(&probe(0, 0, 0, 0, 0)), None);
        assert_eq!(parse_status(""), None);
        assert_eq!(parse_status("ok=1\r\nblock=0\r\n"), None);
    }

    #[test]
    fn the_elevated_script_carries_fixed_text_and_the_quoted_program_path() {
        let script = elevated_script("C:\\Apps\\O'Neil\\lakomics.exe", 53318);
        assert!(script.contains("$exe = 'C:\\Apps\\O''Neil\\lakomics.exe'"));
        assert!(script.contains("-Protocol TCP -LocalPort 53318 -Profile Private -Program $exe"));
        assert!(script.contains("-Direction Inbound -Action Allow"));
        assert!(script.contains("$_.Action -eq 'Block'"));
        assert!(script.contains("exit 0") && script.contains("exit 1"));
    }

    #[test]
    fn the_command_is_base64_of_utf16le() {
        // "Hi" is 48 00 69 00; known vector from PowerShell's own -EncodedCommand.
        assert_eq!(encode_command("Hi"), "SABpAA==");
        assert_eq!(
            encode_command("Write-Output 1"),
            "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIAAxAA=="
        );
        assert_eq!(encode_command(""), "");
    }

    #[test]
    fn the_launcher_embeds_only_the_encoded_payload() {
        let encoded = encode_command(&elevated_script("C:\\a\\lakomics.exe", 53318));
        let launcher = launcher_script(&encoded);
        assert!(launcher.contains(&format!("'-EncodedCommand','{encoded}' -Verb RunAs")));
        assert!(launcher.contains("NativeErrorCode -eq 1223"));
        assert!(encoded
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c)));
    }

    #[test]
    fn exit_codes_map_to_outcomes() {
        assert_eq!(outcome_from_exit(Some(0)), OpenOutcome::Opened);
        assert_eq!(outcome_from_exit(Some(3)), OpenOutcome::Cancelled);
        assert_eq!(outcome_from_exit(Some(1)), OpenOutcome::Failed);
        assert_eq!(outcome_from_exit(Some(4)), OpenOutcome::Failed);
        assert_eq!(outcome_from_exit(None), OpenOutcome::Failed);
    }

    #[cfg(not(windows))]
    #[test]
    fn other_platforms_have_no_firewall_to_open() {
        assert_eq!(status(true), DirectReceive::Unsupported);
        assert_eq!(open(true, 53318).outcome, OpenOutcome::Failed);
    }

    #[test]
    fn a_missing_listener_is_unsupported() {
        assert_eq!(status(false), DirectReceive::Unsupported);
    }
}
