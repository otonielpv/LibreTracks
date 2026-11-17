//! Kit incluido y patrones de serie (plan drum-loops, paso 11, D15).
//!
//! Van dentro del binario (`include_bytes!`): Android no empaqueta los
//! recursos de Tauri y el kit tiene que funcionar sin red nada más instalar.
//! Al arrancar se escriben en `loops/builtin/` (donde los resuelve
//! `SampleRef::Builtin`); los kits y patrones se mezclan con los del usuario,
//! que ganan si comparten id. Generados con `scripts/loopgen/generate.py`.

use std::path::Path;

use libretracks_core::drum_loops::{DrumKit, LoopPattern};
use libretracks_project::rhythm_library::RhythmLibraryData;

/// Súbelo al regenerar los sonidos: fuerza a reescribir `loops/builtin/`.
pub const BUILTIN_VERSION: &str = "1";

macro_rules! builtin_files {
    ($($name:literal),* $(,)?) => {
        &[$(($name, include_bytes!(concat!("../../resources/loops/builtin/", $name)) as &[u8])),*]
    };
}

/// Muestras del kit incluido.
pub static BUILTIN_SAMPLES: &[(&str, &[u8])] = builtin_files!(
    "kick.wav",
    "snare.wav",
    "rim.wav",
    "hat_closed.wav",
    "hat_open.wav",
    "shaker_a.wav",
    "shaker_b.wav",
    "tambourine.wav",
    "clap.wav",
    "cajon.wav",
    "ride_bell.wav",
    "LICENSE.txt",
);

const KITS_JSON: &str = include_str!("../../resources/loops/builtin/kit.json");

macro_rules! builtin_patterns {
    ($($name:literal),* $(,)?) => {
        &[$(include_str!(concat!("../../resources/loops/builtin/patterns/", $name, ".json"))),*]
    };
}

static PATTERNS_JSON: &[&str] = builtin_patterns!(
    "builtin-shaker-16",
    "builtin-tambourine-24",
    "builtin-hat-8",
    "builtin-pop",
    "builtin-ballad",
    "builtin-four-floor",
    "builtin-rock",
    "builtin-worship-68",
    "builtin-waltz-34",
    "builtin-shuffle",
    "builtin-dembow",
    "builtin-cajon-pop",
);

pub fn builtin_kits() -> Vec<DrumKit> {
    serde_json::from_str(KITS_JSON).unwrap_or_default()
}

pub fn builtin_patterns() -> Vec<LoopPattern> {
    PATTERNS_JSON.iter().filter_map(|json| serde_json::from_str(json).ok()).collect()
}

/// Escribe el kit en `dir` si falta o es de otra versión.
pub fn install_builtin(dir: &Path) -> std::io::Result<()> {
    let marker = dir.join("VERSION");
    let current = std::fs::read_to_string(&marker).unwrap_or_default();
    let complete = BUILTIN_SAMPLES.iter().all(|(name, _)| dir.join(name).is_file());
    if current.trim() == BUILTIN_VERSION && complete {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    for (name, bytes) in BUILTIN_SAMPLES {
        libretracks_project::write_file_atomically(&dir.join(name), bytes)?;
    }
    std::fs::write(marker, BUILTIN_VERSION)
}

/// Biblioteca del usuario con los kits y patrones de serie delante; los del
/// usuario sustituyen a los de serie con el mismo id (un kit de serie editado
/// se guarda como copia del usuario).
pub fn with_builtin(mut data: RhythmLibraryData) -> RhythmLibraryData {
    let mut kits: Vec<DrumKit> = builtin_kits()
        .into_iter()
        .filter(|kit| !data.kits.iter().any(|own| own.id == kit.id))
        .collect();
    kits.append(&mut data.kits);
    let mut patterns: Vec<LoopPattern> = builtin_patterns()
        .into_iter()
        .filter(|p| !data.patterns.iter().any(|own| own.id == p.id))
        .collect();
    patterns.append(&mut data.patterns);
    data.kits = kits;
    data.patterns = patterns;
    data
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::drum_loop_resolve::{resolve_sample_path, SampleRoots};

    #[test]
    fn the_builtin_kit_resolves_offline_and_weighs_under_one_and_a_half_megabytes() {
        let total: usize = BUILTIN_SAMPLES.iter().map(|(_, bytes)| bytes.len()).sum();
        assert!(total < 1_500_000, "{total} bytes");
        let dir = tempfile::tempdir().unwrap();
        let builtin = dir.path().join("builtin");
        install_builtin(&builtin).unwrap();
        let roots = SampleRoots { builtin, packs: dir.path().join("packs"), user: dir.path().join("user") };
        let kits = builtin_kits();
        assert_eq!(kits.len(), 2);
        for kit in &kits {
            assert!(kit.sounds.len() <= 8);
            for sound in &kit.sounds {
                let path = resolve_sample_path(&sound.sample, &roots).unwrap();
                let reader = hound::WavReader::open(&path).unwrap();
                assert_eq!(reader.spec().channels, 1);
                assert_eq!(reader.spec().sample_rate, 44100);
                assert_eq!(reader.spec().bits_per_sample, 16);
            }
        }
        // Reinstalar con la misma versión no reescribe nada.
        install_builtin(&roots.builtin).unwrap();
    }

    #[test]
    fn twelve_builtin_patterns_are_already_normalized_with_four_distinct_variations() {
        let kits = builtin_kits();
        let patterns = builtin_patterns();
        assert_eq!(patterns.len(), 12);
        for pattern in &patterns {
            let kit = crate::rhythm::kit_for(pattern, &kits).unwrap_or_else(|| panic!("{} sin kit", pattern.id));
            assert_eq!(&pattern.normalized_with_kit(Some(&kit)), pattern, "{}", pattern.id);
            assert!(pattern.validate(Some(&kit)).is_empty(), "{}", pattern.id);
            let variation = |v: usize| pattern.rows.iter().map(|r| r.variations[v].clone()).collect::<Vec<_>>();
            for a in 0..4 {
                for b in (a + 1)..4 {
                    assert_ne!(variation(a), variation(b), "{}: {a} y {b} iguales", pattern.id);
                }
            }
        }
    }

    #[test]
    fn user_entries_override_builtin_ones_with_the_same_id() {
        let mut own = builtin_kits()[0].clone();
        own.name = "Mío".into();
        let merged = with_builtin(RhythmLibraryData { kits: vec![own], ..Default::default() });
        assert_eq!(merged.kits.iter().filter(|k| k.id == "basic").count(), 1);
        assert_eq!(merged.kits.iter().find(|k| k.id == "basic").unwrap().name, "Mío");
        assert_eq!(merged.patterns.len(), 12);
    }
}
