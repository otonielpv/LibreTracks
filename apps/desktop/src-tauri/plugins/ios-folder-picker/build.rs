const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .try_build()
        .expect("failed to build the LibreTracks iOS folder picker plugin");
}
