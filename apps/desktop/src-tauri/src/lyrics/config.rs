//! `lyrics.json` on disk (plan lyrics-sync, D11). The tolerant parsing and
//! the defaults live in `libretracks_core::lyrics_config`; this only reads and
//! writes the file next to `redundancy.json`. The token is not here: it goes
//! to the keychain.

use std::{
    fs,
    path::{Path, PathBuf},
};

use libretracks_core::lyrics_config::LyricsConfig;
use tauri::{AppHandle, Manager};

pub const LYRICS_FILE_NAME: &str = "lyrics.json";

fn path_in(dir: &Path) -> PathBuf {
    dir.join(LYRICS_FILE_NAME)
}

pub fn load_from(dir: &Path) -> LyricsConfig {
    fs::read_to_string(path_in(dir))
        .map(|text| LyricsConfig::parse(&text))
        .unwrap_or_default()
}

pub fn save_to(dir: &Path, config: &LyricsConfig) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let text = serde_json::to_string_pretty(config).map_err(std::io::Error::other)?;
    fs::write(path_in(dir), text)
}

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

pub fn load(app: &AppHandle) -> LyricsConfig {
    data_dir(app).map(|dir| load_from(&dir)).unwrap_or_default()
}

pub fn save(app: &AppHandle, config: &LyricsConfig) {
    let Some(dir) = data_dir(app) else {
        return;
    };
    if let Err(error) = save_to(&dir, config) {
        eprintln!("[lyrics] could not save {LYRICS_FILE_NAME}: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_reads_defaults_and_a_saved_one_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_from(dir.path()), LyricsConfig::default());
        let config = LyricsConfig {
            enabled: true,
            host: "10.0.0.5".into(),
            ..LyricsConfig::default()
        };
        save_to(dir.path(), &config).unwrap();
        assert_eq!(load_from(dir.path()), config);
    }
}
