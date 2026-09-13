use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use super::matching_root;

pub(super) fn discover_registered_vault(
    vault_id: &str,
    last_root: Option<&Path>,
) -> Option<PathBuf> {
    discover_from_candidates(vault_id, last_root, mounted_root_candidates())
}

fn discover_from_candidates(
    vault_id: &str,
    last_root: Option<&Path>,
    candidates: impl IntoIterator<Item = PathBuf>,
) -> Option<PathBuf> {
    if let Some(root) = last_root {
        if let Some(root) = matching_root(root, vault_id).ok().flatten() {
            return Some(root);
        }
    }
    let remembered = last_root.and_then(|path| fs::canonicalize(path).ok());
    for candidate in candidates {
        if remembered.as_ref().is_some_and(|root| root == &candidate) {
            continue;
        }
        if let Some(root) = matching_root(&candidate, vault_id).ok().flatten() {
            return Some(root);
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn mounted_root_candidates() -> Vec<PathBuf> {
    fs::read_to_string("/proc/self/mountinfo")
        .map(|text| parse_linux_mountinfo(&text))
        .unwrap_or_default()
}

fn windows_drive_root(letter: u8) -> PathBuf {
    PathBuf::from(format!("{}:\\", letter as char))
}

#[cfg(target_os = "windows")]
fn mounted_root_candidates() -> Vec<PathBuf> {
    (b'A'..=b'Z')
        .map(windows_drive_root)
        .filter(|path| path.is_dir())
        .collect()
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn mounted_root_candidates() -> Vec<PathBuf> {
    Vec::new()
}

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
    use std::{fs, path::PathBuf};

    use super::{discover_from_candidates, parse_linux_mountinfo, windows_drive_root};

    fn marker(root: &std::path::Path, id: &str) {
        fs::create_dir_all(root.join(".lakomics")).unwrap();
        fs::write(
            root.join(".lakomics/vault.json"),
            format!(r#"{{"version":1,"vaultId":"{id}"}}"#),
        )
        .unwrap();
    }

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

    #[test]
    fn discovery_prefers_matching_last_root_and_rejects_wrong_identity() {
        let temp = tempfile::tempdir().unwrap();
        let wanted = uuid::Uuid::new_v4().to_string();
        let wrong = uuid::Uuid::new_v4().to_string();
        let remembered = temp.path().join("remembered");
        let candidate = temp.path().join("candidate");
        marker(&remembered, &wrong);
        marker(&candidate, &wanted);

        let found = discover_from_candidates(&wanted, Some(&remembered), [candidate.clone()]);
        assert_eq!(found.as_deref(), Some(candidate.as_path()));
    }

    #[test]
    fn discovery_keeps_the_remembered_root_when_it_matches() {
        let temp = tempfile::tempdir().unwrap();
        let wanted = uuid::Uuid::new_v4().to_string();
        let remembered = temp.path().join("remembered");
        let other = temp.path().join("other");
        marker(&remembered, &wanted);
        marker(&other, &wanted);

        let found = discover_from_candidates(&wanted, Some(&remembered), [other]);
        assert_eq!(found.as_deref(), Some(remembered.as_path()));
    }
}
