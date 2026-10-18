//! CHAR-CLAUDE-001 slice 3: read-only, explicitly invoked offline experiment.
fn main() {
    if let Err(error) = app_lib::library::character_claude::member_probe::run_cli() {
        eprintln!("char_member_probe: {error}");
        std::process::exit(1);
    }
}
