//! Muestras propias de los loops de canción dentro de `.ltset` y `.ltpkg`
//! (plan drum-loops, paso 12).
//!
//! El patrón ya viaja incrustado en la región (paso 01). Lo que no viaja solo
//! son las muestras `SampleRef::User`, que viven en `loops/user/` de cada
//! instalación. Al exportar se renombran por su hash (`<hash>.wav`) en la copia
//! de la canción que se empaqueta y se añaden al zip como `loops/<hash>.wav`;
//! al importar se instalan en `loops/user/` si no están: misma muestra, mismo
//! nombre, nunca se duplica. Un paquete sin `loops/` (versiones anteriores)
//! importa igual. Las muestras de packs viajan por id.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use libretracks_core::drum_loops::{KitRef, SampleSource};
use libretracks_core::Song;
use sha2::{Digest, Sha256};

use crate::ProjectError;

const LOOPS_PREFIX: &str = "loops/";
const HASH_CHARS: usize = 16;

fn hashed_name(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let hash: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| "wav".into());
    Some(format!("{}.{ext}", &hash[..HASH_CHARS]))
}

/// Copia de `song` con las muestras propias de sus loops renombradas por hash
/// y la lista `(entrada del zip, fichero de origen)` a añadir al paquete.
/// Una muestra que falta en disco se deja como está.
pub fn hash_user_samples(song: &Song, user_dir: &Path) -> (Song, Vec<(String, PathBuf)>) {
    let mut song = song.clone();
    let mut entries: BTreeMap<String, PathBuf> = BTreeMap::new();
    for region in &mut song.regions {
        let Some(region_loop) = region.drum_loop.as_mut() else { continue };
        let KitRef::Embedded { kit } = &mut region_loop.pattern.kit else { continue };
        for sound in &mut kit.sounds {
            if sound.sample.source != SampleSource::User {
                continue;
            }
            let source = user_dir.join(&sound.sample.file);
            let Some(name) = hashed_name(&source) else { continue };
            entries.entry(format!("{LOOPS_PREFIX}{name}")).or_insert(source);
            sound.sample.file = name;
        }
    }
    (song, entries.into_iter().collect())
}

/// Añade las muestras a un paquete ya escrito (sin comprimir: son WAV).
pub fn append_rhythm_samples(package: &Path, samples: &[(String, PathBuf)]) -> Result<(), ProjectError> {
    if samples.is_empty() {
        return Ok(());
    }
    let needed: u64 = samples.iter().filter_map(|(_, p)| fs::metadata(p).ok()).map(|m| m.len()).sum();
    crate::disk_space::ensure_free_space(package, needed, 16 * 1024 * 1024)?;
    let file = fs::OpenOptions::new().read(true).write(true).open(package)?;
    let mut zip = zip::ZipWriter::new_append(file).map_err(crate::song_store::zip_error)?;
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, source) in samples {
        let bytes = fs::read(source)?;
        zip.start_file(name.as_str(), options).map_err(crate::song_store::zip_error)?;
        zip.write_all(&bytes)?;
    }
    zip.finish().map_err(crate::song_store::zip_error)?;
    Ok(())
}

/// Instala en `user_dir` las muestras `loops/*` de un paquete que aún no
/// estén. Devuelve cuántas instaló. Sin `loops/` no hace nada.
pub fn install_rhythm_samples(package: &Path, user_dir: &Path) -> Result<usize, ProjectError> {
    let mut file = fs::File::open(package)?;
    install_rhythm_samples_from_reader(&mut file, user_dir)
}

/// Lo mismo desde un lector (Android SAF, `.ltpkg`); lo deja rebobinado al
/// principio para que la extracción lo siga usando.
pub fn install_rhythm_samples_from_reader<R: Read + std::io::Seek>(
    reader: &mut R,
    user_dir: &Path,
) -> Result<usize, ProjectError> {
    let installed = install_from(&mut *reader, user_dir);
    reader.seek(std::io::SeekFrom::Start(0))?;
    installed
}

fn install_from<R: Read + std::io::Seek>(reader: R, user_dir: &Path) -> Result<usize, ProjectError> {
    let mut archive = zip::ZipArchive::new(reader).map_err(crate::song_store::zip_error)?;
    let mut installed = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(crate::song_store::zip_error)?;
        let name = entry.name().replace('\\', "/");
        let Some(file_name) = name.strip_prefix(LOOPS_PREFIX) else { continue };
        let safe = !file_name.is_empty()
            && !file_name.contains('/')
            && file_name != ".."
            && file_name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.');
        if !safe {
            continue;
        }
        let target = user_dir.join(file_name);
        if target.exists() {
            continue;
        }
        fs::create_dir_all(user_dir)?;
        crate::disk_space::ensure_free_space(user_dir, entry.size(), 16 * 1024 * 1024)?;
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes)?;
        crate::write_file_atomically(&target, &bytes)?;
        installed += 1;
    }
    Ok(installed)
}

/// Packs que usan los loops de la canción (para avisar si faltan).
pub fn packs_used_by_song(song: &Song) -> Vec<String> {
    let mut packs: Vec<String> = Vec::new();
    for region in &song.regions {
        let Some(region_loop) = &region.drum_loop else { continue };
        let KitRef::Embedded { kit } = &region_loop.pattern.kit else { continue };
        for sound in &kit.sounds {
            if let SampleSource::Pack { pack_id } = &sound.sample.source {
                if !packs.contains(pack_id) {
                    packs.push(pack_id.clone());
                }
            }
        }
    }
    packs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{export_session_as_package, extract_session_package, load_song_from_file, save_song};
    use libretracks_core::drum_loops::{DrumKit, LoopPattern, LoopRow, PatternSignature, RegionLoop, SampleRef, Sound};

    fn song_with_loop(dir: &Path) -> Song {
        let song_dir = dir.join("session");
        fs::create_dir_all(&song_dir).unwrap();
        let mut song: Song = serde_json::from_value(serde_json::json!({
            "id": "s", "title": "S", "bpm": 120.0, "timeSignature": "4/4", "durationSeconds": 10.0,
            "tempoMarkers": [], "timeSignatureMarkers": [], "tracks": [], "clips": [], "sectionMarkers": [],
            "regions": [{ "id": "r1", "name": "Uno", "startSeconds": 0.0, "endSeconds": 10.0 }]
        }))
        .unwrap();
        song.regions[0].drum_loop = Some(RegionLoop {
            pattern: LoopPattern {
                id: "p".into(),
                name: "Mío".into(),
                kit: KitRef::Embedded {
                    kit: DrumKit {
                        id: "k".into(),
                        name: "K".into(),
                        sounds: vec![
                            Sound {
                                id: "pand".into(),
                                name: "Pandereta".into(),
                                color: String::new(),
                                sample: SampleRef { source: SampleSource::User, file: "pandereta ñ.wav".into() },
                                gain_db: 0.0,
                                choke_group: None,
                            },
                            Sound {
                                id: "guiro".into(),
                                name: "Güiro".into(),
                                color: String::new(),
                                sample: SampleRef { source: SampleSource::Pack { pack_id: "latin".into() }, file: "g.wav".into() },
                                gain_db: 0.0,
                                choke_group: None,
                            },
                        ],
                    },
                },
                bpm: 100.0,
                signature: PatternSignature::default(),
                steps_per_beat: 4,
                bars: 1,
                swing: 0.0,
                rows: vec![LoopRow { sound_id: "pand".into(), gain_db: 0.0, variations: vec![vec![2; 16]] }],
            },
            autostart: true,
            initial_rows: vec![],
        });
        save_song(&song_dir, &song).unwrap();
        song
    }

    #[test]
    fn an_ltset_carries_the_loop_and_its_user_sample_without_duplicating_it() {
        let dir = tempfile::tempdir().unwrap();
        let song = song_with_loop(dir.path());
        let user_out = dir.path().join("user-a");
        fs::create_dir_all(&user_out).unwrap();
        fs::write(user_out.join("pandereta ñ.wav"), b"RIFF-sample-bytes").unwrap();

        let (packaged, samples) = hash_user_samples(&song, &user_out);
        assert_eq!(samples.len(), 1);
        let package = dir.path().join("out.ltset");
        export_session_as_package(&dir.path().join("cache"), &dir.path().join("session"), &packaged, &[], &package, false, |_, _| {}).unwrap();
        append_rhythm_samples(&package, &samples).unwrap();

        let user_in = dir.path().join("user-b");
        for attempt in 0..2 {
            let target = dir.path().join(format!("import-{attempt}"));
            let extracted = extract_session_package(&target, &package, |_, _| {}).unwrap();
            let installed = install_rhythm_samples(&package, &user_in).unwrap();
            assert_eq!(installed, if attempt == 0 { 1 } else { 0 }, "la segunda vez no duplica");
            let loaded = load_song_from_file(&extracted.song_file).unwrap();
            let region_loop = loaded.regions[0].drum_loop.as_ref().expect("el loop viaja");
            let KitRef::Embedded { kit } = &region_loop.pattern.kit else { panic!("kit incrustado") };
            let file = &kit.sounds[0].sample.file;
            assert_eq!(fs::read(user_in.join(file)).unwrap(), b"RIFF-sample-bytes");
            assert_eq!(kit.sounds[1].sample.source, SampleSource::Pack { pack_id: "latin".into() });
        }
        assert_eq!(fs::read_dir(&user_in).unwrap().count(), 1);
        assert_eq!(packs_used_by_song(&song), vec!["latin".to_string()]);
    }

    #[test]
    fn a_package_without_loops_imports_the_same() {
        let dir = tempfile::tempdir().unwrap();
        let song = song_with_loop(dir.path());
        let package = dir.path().join("old.ltset");
        export_session_as_package(&dir.path().join("cache"), &dir.path().join("session"), &song, &[], &package, false, |_, _| {}).unwrap();
        let extracted = extract_session_package(&dir.path().join("import"), &package, |_, _| {}).unwrap();
        assert_eq!(install_rhythm_samples(&package, &dir.path().join("user")).unwrap(), 0);
        assert!(load_song_from_file(&extracted.song_file).unwrap().regions[0].drum_loop.is_some());
    }
}
