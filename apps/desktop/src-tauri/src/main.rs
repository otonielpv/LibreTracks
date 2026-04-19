#[tauri::command]
fn healthcheck() -> &'static str {
    "libretracks-ready"
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![healthcheck])
        .run(tauri::generate_context!())
        .expect("failed to run LibreTracks desktop application");
}
