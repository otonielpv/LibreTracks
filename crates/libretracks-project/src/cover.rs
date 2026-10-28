use std::path::{Path, PathBuf};

pub fn find_cover_images(root: &Path) -> Vec<PathBuf> {
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    let mut candidates = Vec::new();
    let mut remaining = 2048usize;
    while let Some((folder, depth)) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(folder) else { continue };
        let mut entries: Vec<_> = entries.flatten().take(remaining).collect();
        remaining = remaining.saturating_sub(entries.len());
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() && depth < 3 {
                pending.push((path, depth + 1));
            } else if kind.is_file() {
                let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
                if !matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "webp") { continue; }
                let Ok(metadata) = entry.metadata() else { continue };
                if metadata.len() == 0 || metadata.len() > 8 * 1024 * 1024 { continue; }
                let name = path.file_stem().and_then(|value| value.to_str()).unwrap_or("").to_lowercase();
                let rank = ["cover", "album", "portada", "front", "folder", "artwork", "caratula", "carátula"]
                    .iter().position(|prefix| name.starts_with(prefix))
                    .unwrap_or(8);
                candidates.push((rank, depth, path));
            }
        }
        if remaining == 0 { break; }
    }
    candidates.sort();
    candidates.into_iter().map(|(_, _, path)| path).take(16).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_named_covers_and_searches_subfolders_without_following_other_files() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("art")).unwrap();
        for name in ["random.png", "album.jpg", "art/COVER.JPG", "song.wav"] {
            std::fs::write(root.path().join(name), b"image").unwrap();
        }
        let images = find_cover_images(root.path());
        assert_eq!(images.len(), 3);
        assert_eq!(images[0], root.path().join("art/COVER.JPG"));
        assert_eq!(images[1], root.path().join("album.jpg"));
        std::fs::remove_file(&images[0]).unwrap();
        std::fs::remove_file(&images[1]).unwrap();
        assert_eq!(find_cover_images(root.path()), vec![root.path().join("random.png")]);
    }
}