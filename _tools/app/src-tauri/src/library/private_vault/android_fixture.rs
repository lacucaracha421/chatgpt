//! Deterministic, public test material only. Never use these keys outside fixtures.
use super::super::encrypted_store::{EncryptedVault, VaultIndex, VaultItem, VaultItemKind};
use super::*;
use std::{fs, path::Path};

fn fixed_wrap(
    master: &MasterKey,
    key: &WrappingKey,
    vault: &Uuid,
    kind: WrapKind,
    nonce: u8,
) -> WrappedKey {
    let cipher = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &key.0).unwrap());
    let nonce = [nonce; 12];
    let mut bytes = master.0.to_vec();
    cipher
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(wrap_aad(vault, kind)),
            &mut bytes,
        )
        .unwrap();
    WrappedKey {
        nonce: hex(&nonce),
        ciphertext: hex(&bytes),
    }
}

fn fixed_object(
    path: &Path,
    master: &MasterKey,
    vault: &Uuid,
    id: [u8; 16],
    purpose: Purpose,
    salt: u8,
    plain: &[u8],
) {
    let header = object_header(purpose, &[salt; 32]);
    let cipher = ChunkCipher::new(master, purpose, vault, &id, &header);
    let mut out = header.to_vec();
    let chunks = plain.len().div_ceil(CHUNK_SIZE).max(1);
    for index in 0..chunks {
        let mut bytes =
            plain[index * CHUNK_SIZE..plain.len().min((index + 1) * CHUNK_SIZE)].to_vec();
        cipher
            .seal(index as u32, index + 1 == chunks, &mut bytes)
            .unwrap();
        out.extend(bytes);
    }
    fs::write(path, out).unwrap();
    let mut reader =
        ObjectReader::open(master, purpose, vault, &id, File::open(path).unwrap()).unwrap();
    assert_eq!(reader.read_all().unwrap(), plain);
}

#[test]
fn android_golden_fixture() {
    let root =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../android/tests/fixtures/private-vault");
    let dir = root.join(".lakomics-vault");
    fs::create_dir_all(dir.join("objects")).unwrap();
    let vault = Uuid::parse_str("00112233-4455-6677-8899-aabbccddeeff").unwrap();
    let master = MasterKey([0x42; 32]);
    let recovery = WrappingKey([0x24; 32]);
    let password = "tablet-암호-fixture";
    let salt = [0x11; 16];
    let password_wrap = password_key(password, PBKDF2_ITERATIONS, &salt).unwrap();
    let header = VaultHeader {
        format_version: 1,
        vault_id: vault,
        kdf: KdfParams {
            name: KDF_NAME.into(),
            iterations: PBKDF2_ITERATIONS,
            salt: hex(&salt),
        },
        password_wrap: fixed_wrap(&master, &password_wrap, &vault, WrapKind::Password, 0x31),
        recovery_wrap: fixed_wrap(&master, &recovery, &vault, WrapKind::Recovery, 0x32),
    };
    fs::write(
        dir.join("vault.json"),
        serde_json::to_vec_pretty(&header).unwrap(),
    )
    .unwrap();
    // A real 1x1 PNG, usable as both the tiny image and its custom thumbnail.
    let png_hex = "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c6360000200000500017a5eab3f0000000049454e44ae426082";
    let mut png = vec![0; png_hex.len() / 2];
    assert!(unhex_into(png_hex, &mut png));
    let video: Vec<u8> = (0..CHUNK_SIZE * 2 + 37).map(|i| (i % 251) as u8).collect();
    for (id, plain) in [
        (1, png.as_slice()),
        (2, png.as_slice()),
        (3, video.as_slice()),
    ] {
        fixed_object(
            &dir.join("objects").join(hex(&[id; 16])),
            &master,
            &vault,
            [id; 16],
            Purpose::Object,
            id,
            plain,
        );
    }
    let item = |id: u8, kind, size| VaultItem {
        id: format!("fixture-{id}"),
        object_id: hex(&[id; 16]),
        original_relative_path: if id == 1 { "photo.png" } else { "clip.mp4" }.into(),
        original_file_name: if id == 1 { "photo.png" } else { "clip.mp4" }.into(),
        kind,
        byte_size: size,
        width: Some(1),
        height: Some(1),
        imported_at: "2026-09-24T00:00:00Z".into(),
        title: Some(
            if id == 1 {
                "사용자 지정 제목"
            } else {
                "여러 청크 영상"
            }
            .into(),
        ),
        thumbnail_object_id: Some(hex(&[2; 16])),
        poster_object_id: None,
        trashed_at: None,
        content_sha256: None,
        thumbnail_sha256: None,
    };
    let index = VaultIndex {
        format_version: 1,
        revision: 1,
        items: vec![
            item(1, VaultItemKind::Image, png.len() as u64),
            item(3, VaultItemKind::Video, video.len() as u64),
        ],
    };
    let mut json = serde_json::to_value(&index).unwrap();
    json["futureField"] = serde_json::json!({"ignored":[true,1.5,null]});
    fixed_object(
        &dir.join("index.bin"),
        &master,
        &vault,
        [0; 16],
        Purpose::Index,
        4,
        &serde_json::to_vec(&json).unwrap(),
    );
    json["formatVersion"] = serde_json::json!(99);
    fixed_object(
        &root.join("unknown-index.bin"),
        &master,
        &vault,
        [0; 16],
        Purpose::Index,
        5,
        &serde_json::to_vec(&json).unwrap(),
    );
    fs::write(root.join("fixture.json"),serde_json::to_vec_pretty(&serde_json::json!({"password":password,"recoveryKey":hex(&recovery.0),"videoLength":video.len()})).unwrap()).unwrap();
    let opened = EncryptedVault::unlock(&root, &Secret::Password(password)).unwrap();
    let loaded = opened.load_index().unwrap();
    assert_eq!(loaded, index);
    drop(opened);
    let opened = EncryptedVault::unlock(&root, &Secret::RecoveryKey(&hex(&recovery.0))).unwrap();
    let loaded = opened.load_index().unwrap();
    assert_eq!(loaded, index);
}
