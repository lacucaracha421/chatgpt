fn main() {
    // tauri_build links its resource file (icon, version info and the Common Controls v6
    // manifest) into binaries only. Test executables of the lib and of tests/ get none, and
    // anything that reaches Tauri's dialog or menu code (muda's about box and rfd use
    // TaskDialogIndirect, which exists only in comctl32 v6) then fails to start with
    // STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139). So the manifest is embedded by the linker for
    // every Windows MSVC link instead, and tauri_build is told not to add its own copy.
    let windows = std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows");
    let msvc = windows && std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|env| env == "msvc");
    let attributes = if msvc {
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        tauri_build::Attributes::new()
    };
    tauri_build::try_build(attributes).expect("failed to run tauri-build");

    if msvc {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
