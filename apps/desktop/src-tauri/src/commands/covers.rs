use base64::Engine as _;
use tauri::State;
use crate::state::DesktopState;
use crate::models::TransportSnapshot;

#[tauri::command(async)]
pub fn set_song_region_cover(region_id: String, cover_image: Option<String>, state: State<'_, DesktopState>) -> Result<TransportSnapshot, String> {
    state.session.lock().map_err(|error| error.to_string())?
        .set_song_region_cover(&region_id, cover_image, &state.audio).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn find_song_cover_images(paths: Vec<String>, folder_name: String, state: State<'_, DesktopState>) -> Result<Vec<String>, String> {
    use std::{collections::BTreeSet, io::Read, path::PathBuf};
    let song_dir = state.session.lock().map_err(|error| error.to_string())?.song_dir.clone();
    let folder_name = folder_name.rsplit(['/', '\\']).next().unwrap_or(&folder_name);
    let roots: BTreeSet<PathBuf> = paths.iter().take(256).filter_map(|path| {
        let path = PathBuf::from(path);
        let path = if path.is_absolute() { path } else { song_dir.as_ref()?.join(path) };
        let parent = path.parent()?;
        Some(parent.ancestors().find(|ancestor| ancestor.file_name().is_some_and(|name| name.to_string_lossy() == folder_name))
            .unwrap_or(parent).to_path_buf())
    }).collect();
    let mut images = Vec::new();
    let mut budget = 8 * 1024 * 1024;
    for path in roots.iter().flat_map(|root| libretracks_project::cover::find_cover_images(root)) {
        let Ok(file) = std::fs::File::open(&path) else { continue };
        let mut bytes = Vec::new();
        if file.take((budget + 1) as u64).read_to_end(&mut bytes).is_err() || bytes.len() > budget { continue; }
        budget -= bytes.len();
        let mime = match path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
            "png" => "image/png", "webp" => "image/webp", _ => "image/jpeg",
        };
        images.push(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)));
        if images.len() == 4 || budget == 0 { break; }
    }
    Ok(images)
}