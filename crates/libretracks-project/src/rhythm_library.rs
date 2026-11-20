//! Biblioteca de loops de batería y one shots en disco (plan drum-loops,
//! paso 05).
//!
//! ```text
//! <app_local_data>/loops/
//!   kits/<id>.json        DrumKit
//!   patterns/<id>.json    LoopPattern
//!   oneshots/set.json     OneShotSet (uno: los one shots son del músico, D6)
//!   packs/<pack_id>/      packs descargados (paso 11)
//!   user/                 muestras importadas, WAV 16 bit
//! ```
//!
//! Cada escritura es atómica (temporal + renombrado) y comprueba antes el
//! espacio libre, así que un disco lleno se informa como `InsufficientSpace`
//! sin dejar ficheros a medias. Un JSON ilegible se salta al listar: una
//! entrada rota no tumba la biblioteca entera.

use std::fs;
use std::path::{Path, PathBuf};

use libretracks_core::drum_loops::{DrumKit, LoopPattern, OneShotSet};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::{ensure_free_space, write_file_atomically, ProjectError};

/// Margen que se deja libre al escribir una entrada de la biblioteca.
const LIBRARY_HEADROOM_BYTES: u64 = 1024 * 1024;
const ONE_SHOT_SET_FILE: &str = "set.json";

#[derive(Debug, Clone, PartialEq, Default)]
pub struct RhythmLibraryData {
    pub kits: Vec<DrumKit>,
    pub patterns: Vec<LoopPattern>,
    pub one_shots: OneShotSet,
}

#[derive(Debug, Clone)]
pub struct RhythmLibrary {
    root: PathBuf,
}

impl RhythmLibrary {
    /// `root` = `<app_local_data>/loops`.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn kits_dir(&self) -> PathBuf {
        self.root.join("kits")
    }
    pub fn patterns_dir(&self) -> PathBuf {
        self.root.join("patterns")
    }
    pub fn one_shots_dir(&self) -> PathBuf {
        self.root.join("oneshots")
    }
    pub fn packs_dir(&self) -> PathBuf {
        self.root.join("packs")
    }
    pub fn user_dir(&self) -> PathBuf {
        self.root.join("user")
    }

    pub fn ensure_dirs(&self) -> Result<(), ProjectError> {
        for dir in [
            self.kits_dir(),
            self.patterns_dir(),
            self.one_shots_dir(),
            self.packs_dir(),
            self.user_dir(),
        ] {
            fs::create_dir_all(dir)?;
        }
        Ok(())
    }

    pub fn load(&self) -> Result<RhythmLibraryData, ProjectError> {
        Ok(RhythmLibraryData {
            kits: self.list_kits()?,
            patterns: self.list_patterns()?,
            one_shots: self.load_one_shot_set()?,
        })
    }

    pub fn list_kits(&self) -> Result<Vec<DrumKit>, ProjectError> {
        let mut kits: Vec<DrumKit> = read_entries(&self.kits_dir())?;
        kits.iter_mut().for_each(|kit| *kit = kit.normalized());
        kits.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(kits)
    }

    pub fn list_patterns(&self) -> Result<Vec<LoopPattern>, ProjectError> {
        let mut patterns: Vec<LoopPattern> = read_entries(&self.patterns_dir())?;
        patterns.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(patterns)
    }

    pub fn save_kit(&self, kit: &DrumKit) -> Result<(), ProjectError> {
        write_entry(&self.kits_dir(), &kit.id, &kit.normalized())
    }

    pub fn delete_kit(&self, id: &str) -> Result<(), ProjectError> {
        delete_entry(&self.kits_dir(), id)
    }

    pub fn save_pattern(&self, pattern: &LoopPattern) -> Result<(), ProjectError> {
        write_entry(&self.patterns_dir(), &pattern.id, &pattern.normalized())
    }

    pub fn delete_pattern(&self, id: &str) -> Result<(), ProjectError> {
        delete_entry(&self.patterns_dir(), id)
    }

    /// El set de one shots; vacío si aún no existe.
    pub fn load_one_shot_set(&self) -> Result<OneShotSet, ProjectError> {
        let path = self.one_shots_dir().join(ONE_SHOT_SET_FILE);
        match fs::read(&path) {
            Ok(bytes) => Ok(serde_json::from_slice::<OneShotSet>(&bytes)
                .map(|set| set.normalized())
                .unwrap_or_default()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(OneShotSet::default()),
            Err(error) => Err(error.into()),
        }
    }

    pub fn save_one_shot_set(&self, set: &OneShotSet) -> Result<(), ProjectError> {
        let dir = self.one_shots_dir();
        write_json(&dir, &dir.join(ONE_SHOT_SET_FILE), &set.normalized())
    }
}

/// Un id válido como nombre de fichero: sin separadores, sin `..`, sin vacío.
pub fn is_safe_entry_id(id: &str) -> bool {
    !id.trim().is_empty()
        && id.len() <= 128
        && id != "."
        && id != ".."
        && id
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn entry_path(dir: &Path, id: &str) -> Result<PathBuf, ProjectError> {
    if !is_safe_entry_id(id) {
        return Err(ProjectError::InvalidFileName(PathBuf::from(id)));
    }
    Ok(dir.join(format!("{id}.json")))
}

pub(crate) fn write_entry<T: Serialize>(dir: &Path, id: &str, value: &T) -> Result<(), ProjectError> {
    let path = entry_path(dir, id)?;
    write_json(dir, &path, value)
}

fn write_json<T: Serialize>(dir: &Path, path: &Path, value: &T) -> Result<(), ProjectError> {
    fs::create_dir_all(dir)?;
    let bytes = serde_json::to_vec_pretty(value)?;
    ensure_free_space(dir, bytes.len() as u64, LIBRARY_HEADROOM_BYTES)?;
    write_file_atomically(path, &bytes)?;
    Ok(())
}

pub(crate) fn delete_entry(dir: &Path, id: &str) -> Result<(), ProjectError> {
    let path = entry_path(dir, id)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn read_entries<T: DeserializeOwned>(dir: &Path) -> Result<Vec<T>, ProjectError> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        if let Ok(value) = serde_json::from_slice::<T>(&bytes) {
            out.push(value);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::drum_loops::{
        KitRef, LoopRow, OneShotBank, PatternSignature, SampleRef, SampleSource, Sound,
    };

    fn kit(id: &str, name: &str) -> DrumKit {
        DrumKit {
            id: id.into(),
            name: name.into(),
            sounds: vec![Sound {
                id: "hat".into(),
                name: "Hat".into(),
                color: String::new(),
                sample: SampleRef { source: SampleSource::Builtin, file: "hat.wav".into() },
                gain_db: 0.0,
                choke_group: None,
            }],
        }
    }

    fn pattern(id: &str, name: &str) -> LoopPattern {
        LoopPattern {
            id: id.into(),
            name: name.into(),
            kit: KitRef::Library { kit_id: "basic".into() },
            bpm: 92.0,
            signature: PatternSignature::default(),
            steps_per_beat: 4,
            bars: 1,
            swing: 0.0,
            rows: vec![LoopRow { sound_id: "hat".into(), gain_db: 0.0, variations: vec![vec![2; 16]] }],
        }
    }

    #[test]
    fn crud_of_kits_patterns_and_one_shots() {
        let dir = tempfile::tempdir().unwrap();
        let lib = RhythmLibrary::new(dir.path().join("loops"));
        lib.ensure_dirs().unwrap();
        assert_eq!(lib.load().unwrap(), RhythmLibraryData::default());

        lib.save_kit(&kit("b", "Brushes")).unwrap();
        lib.save_kit(&kit("a", "acoustic")).unwrap();
        lib.save_pattern(&pattern("pop", "Pop 16ths")).unwrap();
        let mut set = OneShotSet::default();
        set.banks.push(OneShotBank { id: "a".into(), name: "A".into(), pads: vec![] });
        lib.save_one_shot_set(&set).unwrap();

        let data = lib.load().unwrap();
        assert_eq!(data.kits.iter().map(|k| k.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!(data.patterns.len(), 1);
        assert_eq!(data.patterns[0].rows[0].variations.len(), 4, "se guarda normalizado");
        assert_eq!(data.one_shots.banks[0].pads.len(), 12);

        // Guardar otra vez sustituye; borrar quita; borrar lo inexistente no falla.
        lib.save_pattern(&pattern("pop", "Pop renamed")).unwrap();
        assert_eq!(lib.list_patterns().unwrap()[0].name, "Pop renamed");
        lib.delete_pattern("pop").unwrap();
        lib.delete_pattern("pop").unwrap();
        assert!(lib.list_patterns().unwrap().is_empty());
        lib.delete_kit("a").unwrap();
        assert_eq!(lib.list_kits().unwrap().len(), 1);
        // Sin temporales olvidados.
        let leftovers: Vec<_> = fs::read_dir(lib.kits_dir())
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) != Some("json"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn unsafe_ids_are_rejected_and_broken_entries_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let lib = RhythmLibrary::new(dir.path().join("loops"));
        lib.ensure_dirs().unwrap();
        for bad in ["../x", "a/b", "", "..", "c:evil"] {
            assert!(matches!(lib.save_kit(&kit(bad, "X")), Err(ProjectError::InvalidFileName(_))), "{bad}");
        }
        fs::write(lib.kits_dir().join("broken.json"), b"{nope").unwrap();
        lib.save_kit(&kit("ok", "Ok")).unwrap();
        assert_eq!(lib.list_kits().unwrap().len(), 1);
        fs::write(lib.one_shots_dir().join(ONE_SHOT_SET_FILE), b"garbage").unwrap();
        assert_eq!(lib.load_one_shot_set().unwrap(), OneShotSet::default());
    }

    #[test]
    fn a_full_disk_is_reported_as_insufficient_space() {
        // La mitad pura de ensure_free_space: lo que verá la escritura con el
        // volumen lleno.
        let err = crate::disk_space::check_free_space(10_000, LIBRARY_HEADROOM_BYTES, 1_000).unwrap_err();
        assert!(matches!(err, ProjectError::InsufficientSpace { .. }));
        assert!(err.to_string().starts_with("insufficient disk space"));
    }
}
