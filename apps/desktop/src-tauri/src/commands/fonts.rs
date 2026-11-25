//! The font families installed on this device, for the lyrics style picker.
//! The WebView draws any installed family by its name, so the list is only
//! names: no font is read by the UI or copied anywhere.

use std::collections::BTreeSet;
use std::sync::OnceLock;

static FAMILIES: OnceLock<Vec<String>> = OnceLock::new();

fn scan() -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    #[cfg(target_os = "android")]
    db.load_fonts_dir("/system/fonts");
    #[cfg(target_os = "ios")]
    db.load_fonts_dir("/System/Library/Fonts");
    family_names(db.faces().map(|face| face.families.as_slice()))
}

/// One name per family (the English one when the font has several), sorted
/// case-insensitively. Hidden system families (".SF NS…") are left out.
fn family_names<'a>(faces: impl Iterator<Item = &'a [(String, fontdb::Language)]>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut names = Vec::new();
    for families in faces {
        let name = families
            .iter()
            .find(|(_, language)| *language == fontdb::Language::English_UnitedStates)
            .or_else(|| families.first())
            .map(|(name, _)| name.trim());
        let Some(name) = name else { continue };
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        if seen.insert(name.to_lowercase()) {
            names.push(name.to_string());
        }
    }
    names.sort_by_key(|name| name.to_lowercase());
    names
}

/// Scanned once per run (a few hundred ms with many fonts installed), on a
/// worker thread: never on the UI or audio thread.
#[tauri::command(async)]
pub fn list_system_fonts() -> Vec<String> {
    FAMILIES.get_or_init(scan).clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use fontdb::Language;

    #[test]
    fn one_english_name_per_family_sorted_without_hidden_ones() {
        let faces: Vec<Vec<(String, Language)>> = vec![
            vec![("Segoe UI".into(), Language::English_UnitedStates)],
            vec![("segoe ui".into(), Language::English_UnitedStates)],
            vec![
                ("ＭＳ ゴシック".into(), Language::Japanese_Japan),
                ("MS Gothic".into(), Language::English_UnitedStates),
            ],
            vec![(".SF NS Text".into(), Language::English_UnitedStates)],
            vec![("arial".into(), Language::English_UnitedStates)],
            vec![],
        ];
        let names = family_names(faces.iter().map(|face| face.as_slice()));
        assert_eq!(names, vec!["arial", "MS Gothic", "Segoe UI"]);
    }
}
