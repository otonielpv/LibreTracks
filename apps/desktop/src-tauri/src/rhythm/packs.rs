//! Packs de sonidos descargables (plan drum-loops, paso 11, D15).
//!
//! Un pack es un zip con `pack.json` y sus muestras. A diferencia de los pads,
//! el sha256 del manifiesto SÍ se verifica: un zip que no coincide no deja
//! nada en disco. Se instala en `loops/packs/<id>/` (donde lo resuelve
//! `SampleRef::Pack`) y sus kits y patrones se suman a la biblioteca.

use std::io::Read;
use std::path::{Path, PathBuf};

use libretracks_core::drum_loops::{DrumKit, KitRef, LoopPattern, SampleRef, SampleSource, Sound};
use libretracks_project::rhythm_library::RhythmLibraryData;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Manifiesto del repositorio de packs (lo crea la persona: PENDIENTE-HUMANO).
pub const PACKS_MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/otonielpv/libretracks-loops/main/manifest.json";

const AUDIO_EXTENSIONS: &[&str] = &["wav", "flac", "mp3", "ogg", "m4a", "aac"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PackKind {
    Kit,
    Oneshots,
    Patterns,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackManifestEntry {
    pub id: String,
    pub name: String,
    pub kind: PackKind,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub size_bytes: u64,
    pub download_url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PacksManifest {
    #[serde(default)]
    pub packs: Vec<PackManifestEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackCatalogEntry {
    #[serde(flatten)]
    pub entry: PackManifestEntry,
    pub installed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacksCatalog {
    pub packs: Vec<PackCatalogEntry>,
    pub offline: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSound {
    pub id: String,
    pub name: String,
    pub file: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub choke_group: Option<u8>,
}

/// `pack.json` dentro del zip.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackFile {
    pub id: String,
    pub name: String,
    pub kind: PackKind,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub license: String,
    #[serde(default)]
    pub sounds: Vec<PackSound>,
    #[serde(default)]
    pub patterns: Vec<LoopPattern>,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn is_safe_id(id: &str) -> bool {
    libretracks_project::rhythm_library::is_safe_entry_id(id)
}

/// Verifica e instala un pack. Todo o nada: con un error no queda nada.
pub fn install_pack_zip(bytes: &[u8], expected_sha256: &str, packs_dir: &Path, pack_id: &str) -> Result<PathBuf, String> {
    if !is_safe_id(pack_id) {
        return Err(format!("invalid pack id: {pack_id}"));
    }
    let actual = sha256_hex(bytes);
    if !actual.eq_ignore_ascii_case(expected_sha256.trim()) {
        return Err(format!("pack checksum mismatch: expected {expected_sha256}, got {actual}"));
    }
    std::fs::create_dir_all(packs_dir).map_err(|e| e.to_string())?;
    libretracks_project::ensure_free_space(packs_dir, bytes.len() as u64 * 3, 8 * 1024 * 1024)
        .map_err(|e| e.to_string())?;
    let partial = packs_dir.join(format!(".{pack_id}.partial"));
    let _ = std::fs::remove_dir_all(&partial);
    let result = (|| -> Result<(), String> {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("invalid package: {e}"))?;
        let mut has_manifest = false;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|e| format!("invalid package: {e}"))?;
            if entry.is_dir() {
                continue;
            }
            let Some(name) = entry.enclosed_name() else {
                return Err("invalid package: unsafe entry".into());
            };
            let ext = name.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
            let is_manifest = name == Path::new("pack.json");
            let is_license = name.file_name().and_then(|n| n.to_str()) == Some("LICENSE.txt");
            if !(is_manifest || is_license || ext.is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.as_str()))) {
                continue;
            }
            let target = partial.join(&name);
            std::fs::create_dir_all(target.parent().unwrap_or(&partial)).map_err(|e| e.to_string())?;
            let mut data = Vec::new();
            entry.read_to_end(&mut data).map_err(|e| e.to_string())?;
            std::fs::write(&target, data).map_err(|e| e.to_string())?;
            has_manifest |= is_manifest;
        }
        if !has_manifest {
            return Err("invalid package: no pack.json".into());
        }
        let manifest: PackFile = serde_json::from_slice(&std::fs::read(partial.join("pack.json")).map_err(|e| e.to_string())?)
            .map_err(|e| format!("invalid package: {e}"))?;
        if manifest.id != pack_id {
            return Err(format!("invalid package: pack.json is {}, expected {pack_id}", manifest.id));
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&partial);
        return Err(error);
    }
    let final_dir = packs_dir.join(pack_id);
    let _ = std::fs::remove_dir_all(&final_dir);
    std::fs::rename(&partial, &final_dir).map_err(|e| {
        let _ = std::fs::remove_dir_all(&partial);
        e.to_string()
    })?;
    Ok(final_dir)
}

pub fn installed_pack_ids(packs_dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(packs_dir) else { return Vec::new() };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().join("pack.json").is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    ids.sort();
    ids
}

fn read_pack(dir: &Path) -> Option<PackFile> {
    serde_json::from_slice(&std::fs::read(dir.join("pack.json")).ok()?).ok()
}

/// Kits y patrones de los packs instalados sumados a la biblioteca.
pub fn with_packs(mut data: RhythmLibraryData, packs_dir: &Path) -> RhythmLibraryData {
    for id in installed_pack_ids(packs_dir) {
        let Some(pack) = read_pack(&packs_dir.join(&id)) else { continue };
        if pack.kind == PackKind::Kit && !pack.sounds.is_empty() && !data.kits.iter().any(|k| k.id == pack.id) {
            data.kits.push(
                DrumKit {
                    id: pack.id.clone(),
                    name: pack.name.clone(),
                    sounds: pack
                        .sounds
                        .iter()
                        .map(|s| Sound {
                            id: s.id.clone(),
                            name: s.name.clone(),
                            color: s.color.clone(),
                            sample: SampleRef { source: SampleSource::Pack { pack_id: pack.id.clone() }, file: s.file.clone() },
                            gain_db: 0.0,
                            choke_group: s.choke_group,
                        })
                        .collect(),
                }
                .normalized(),
            );
        }
        for mut pattern in pack.patterns {
            if data.patterns.iter().any(|p| p.id == pattern.id) {
                continue;
            }
            if let KitRef::Library { kit_id } = &pattern.kit {
                if kit_id.is_empty() {
                    pattern.kit = KitRef::Library { kit_id: pack.id.clone() };
                }
            }
            data.patterns.push(pattern);
        }
    }
    data
}

/// Packs instalados cuyos sonidos usan patrones de la biblioteca (avisar al
/// desinstalar).
pub fn patterns_using_pack(data: &RhythmLibraryData, pack_id: &str) -> usize {
    data.patterns
        .iter()
        .filter(|p| matches!(&p.kit, KitRef::Library { kit_id } if kit_id == pack_id))
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture_zip(pack_id: &str, extra: Option<&str>) -> Vec<u8> {
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("pack.json", options).unwrap();
            let manifest = serde_json::json!({
                "id": pack_id, "name": "Latin", "kind": "kit", "version": "1", "license": "CC0",
                "sounds": [{ "id": "guiro", "name": "Güiro", "file": "guiro.wav", "color": "#ff0" }],
                "patterns": [{
                    "id": "latin-1", "name": "Latin", "kit": { "kind": "library", "kitId": pack_id },
                    "bpm": 100.0, "signature": { "numerator": 4, "denominator": 4 }, "stepsPerBeat": 4, "bars": 1,
                    "swing": 0.0, "rows": [{ "soundId": "guiro", "gainDb": 0.0, "variations": [[2,0,0,0,2,0,0,0,2,0,0,0,2,0,0,0],[],[],[]] }]
                }]
            });
            zip.write_all(manifest.to_string().as_bytes()).unwrap();
            zip.start_file("guiro.wav", options).unwrap();
            zip.write_all(b"RIFF....").unwrap();
            zip.start_file("readme.exe", options).unwrap();
            zip.write_all(b"MZ").unwrap();
            if let Some(name) = extra {
                zip.start_file(name, options).unwrap();
                zip.write_all(b"x").unwrap();
            }
            zip.finish().unwrap();
        }
        buffer.into_inner()
    }

    #[test]
    fn a_correct_checksum_installs_and_adds_kit_and_patterns() {
        let dir = tempfile::tempdir().unwrap();
        let packs = dir.path().join("packs");
        let bytes = fixture_zip("latin", None);
        let installed = install_pack_zip(&bytes, &sha256_hex(&bytes).to_uppercase(), &packs, "latin").unwrap();
        assert!(installed.join("guiro.wav").is_file());
        assert!(!installed.join("readme.exe").exists(), "solo audio, pack.json y licencia");
        assert_eq!(installed_pack_ids(&packs), vec!["latin".to_string()]);
        let data = with_packs(RhythmLibraryData::default(), &packs);
        assert_eq!(data.kits[0].sounds[0].sample.source, SampleSource::Pack { pack_id: "latin".into() });
        assert_eq!(data.patterns[0].id, "latin-1");
        assert_eq!(patterns_using_pack(&data, "latin"), 1);
    }

    #[test]
    fn a_wrong_checksum_or_bad_zip_is_rejected_without_leftovers() {
        let dir = tempfile::tempdir().unwrap();
        let packs = dir.path().join("packs");
        let bytes = fixture_zip("latin", None);
        let err = install_pack_zip(&bytes, &"0".repeat(64), &packs, "latin").unwrap_err();
        assert!(err.starts_with("pack checksum mismatch"), "{err}");
        assert!(!packs.join("latin").exists());

        let mismatch = fixture_zip("other", None);
        let err = install_pack_zip(&mismatch, &sha256_hex(&mismatch), &packs, "latin").unwrap_err();
        assert!(err.contains("expected latin"), "{err}");

        let garbage = b"not a zip".to_vec();
        assert!(install_pack_zip(&garbage, &sha256_hex(&garbage), &packs, "latin").is_err());
        assert!(install_pack_zip(&bytes, &sha256_hex(&bytes), &packs, "../evil").is_err());
        let leftovers: Vec<_> = std::fs::read_dir(&packs).map(|r| r.flatten().collect()).unwrap_or_default();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }
}
