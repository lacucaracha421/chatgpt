//! Mount roots probed for an encrypted vault (`.lakomics-vault/vault.json`).

#[cfg(any(target_os = "linux", test))]
use std::collections::BTreeSet;
#[cfg(target_os = "linux")]
use std::fs;
use std::path::PathBuf;

#[cfg(target_os = "linux")]
pub(super) fn mounted_root_candidates() -> Vec<PathBuf> {
    fs::read_to_string("/proc/self/mountinfo")
        .map(|text| parse_linux_mountinfo(&text))
        .unwrap_or_default()
}

#[cfg(any(target_os = "windows", test))]
fn windows_drive_root(letter: u8) -> PathBuf {
    PathBuf::from(format!("{}:\\", letter as char))
}

#[cfg(target_os = "windows")]
pub(super) fn mounted_root_candidates() -> Vec<PathBuf> {
    (b'A'..=b'Z')
        .map(windows_drive_root)
        .filter(|path| path.is_dir())
        .collect()
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub(super) fn mounted_root_candidates() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(any(target_os = "linux", test))]
fn parse_linux_mountinfo(text: &str) -> Vec<PathBuf> {
    let mut roots = BTreeSet::new();
    for line in text.lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        let Some(mount_point) = fields.get(4) else {
            continue;
        };
        roots.insert(PathBuf::from(decode_mount_field(mount_point)));
    }
    roots.into_iter().collect()
}

#[cfg(any(target_os = "linux", test))]
fn decode_mount_field(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(value.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\' && index + 3 < bytes.len() {
            let code = &value[index + 1..index + 4];
            let decoded = match code {
                "040" => Some(' '),
                "011" => Some('\t'),
                "012" => Some('\n'),
                "134" => Some('\\'),
                _ => None,
            };
            if let Some(decoded) = decoded {
                out.push(decoded);
                index += 4;
                continue;
            }
        }
        let character = value[index..].chars().next().expect("valid utf-8 boundary");
        out.push(character);
        index += character.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{parse_linux_mountinfo, windows_drive_root};

    #[test]
    fn windows_drive_root_uses_one_root_separator() {
        assert_eq!(windows_drive_root(b'D'), PathBuf::from(r"D:\"));
    }

    #[test]
    fn linux_mount_parser_decodes_mount_point_escapes() {
        let mounts = parse_linux_mountinfo(
            "36 25 0:31 / /run/media/laku/My\\040Vault rw,nosuid - fuseblk /dev/sdb1 rw\n\
             37 25 0:32 / /mnt/plain rw - ext4 /dev/sdc1 rw\n",
        );
        assert_eq!(
            mounts,
            vec![
                PathBuf::from("/mnt/plain"),
                PathBuf::from("/run/media/laku/My Vault")
            ]
        );
    }
}
