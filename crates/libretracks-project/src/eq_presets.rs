//! Presets de ecualizador (plan `track-eq-2`, paso 01, E1).
//!
//! ```text
//! <app_local_data>/eq-presets/<id>.json   EqPreset { id, name, eq }
//! ```
//!
//! Mismo patrón que [`crate::rhythm_library::RhythmLibrary`]: escritura atómica
//! con comprobación de espacio y lectura tolerante (un JSON roto se salta).
//! El EQ se guarda ya recortado ([`TrackEq::sanitized`]). Los presets de fábrica
//! viven en el código ([`factory_presets`]) y no se pueden borrar ni pisar.
//!
//! No van en `AppSettings`: los ajustes se publican al remote y cada máquina
//! tiene su propia biblioteca.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use libretracks_core::track_eq::{EqBand, EqBandKind, TrackEq, TRACK_EQ_DEFAULT_Q};
use serde::{Deserialize, Serialize};

use crate::rhythm_library::{delete_entry, is_safe_entry_id, read_entries, write_entry};
use crate::ProjectError;

/// Prefijo de los ids de fábrica: un preset de usuario no puede usarlo.
pub const FACTORY_PRESET_PREFIX: &str = "factory-";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqPreset {
    pub id: String,
    pub name: String,
    pub eq: TrackEq,
    /// Solo en la vista: los de fábrica son de solo lectura. No se escribe a disco.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub factory: bool,
}

#[derive(Debug, Clone)]
pub struct EqPresetLibrary {
    root: PathBuf,
}

impl EqPresetLibrary {
    /// `root` = `<app_local_data>/eq-presets`.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Solo los del usuario, ordenados por nombre.
    pub fn list_user(&self) -> Result<Vec<EqPreset>, ProjectError> {
        let mut presets: Vec<EqPreset> = read_entries(&self.root)?;
        presets.retain(|p| is_safe_entry_id(&p.id) && !p.id.starts_with(FACTORY_PRESET_PREFIX));
        for preset in &mut presets {
            preset.eq = preset.eq.sanitized();
            preset.factory = false;
        }
        presets.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(presets)
    }

    /// Los de fábrica primero (en su orden) y después los del usuario.
    pub fn list(&self) -> Result<Vec<EqPreset>, ProjectError> {
        let mut all = factory_presets();
        all.extend(self.list_user()?);
        Ok(all)
    }

    /// Crea (sin `id`) o sustituye/renombra (con `id`) un preset de usuario.
    /// Devuelve el preset tal como queda en disco.
    pub fn save(&self, id: Option<&str>, name: &str, eq: &TrackEq) -> Result<EqPreset, ProjectError> {
        let id = match id {
            Some(id) => id.to_string(),
            None => new_preset_id(),
        };
        if id.starts_with(FACTORY_PRESET_PREFIX) {
            return Err(ProjectError::InvalidFileName(PathBuf::from(id)));
        }
        let name = name.trim();
        let preset = EqPreset {
            id: id.clone(),
            name: if name.is_empty() { "EQ".to_string() } else { name.to_string() },
            eq: eq.sanitized(),
            factory: false,
        };
        write_entry(&self.root, &id, &preset)?;
        Ok(preset)
    }

    pub fn delete(&self, id: &str) -> Result<(), ProjectError> {
        if id.starts_with(FACTORY_PRESET_PREFIX) {
            return Err(ProjectError::InvalidFileName(PathBuf::from(id)));
        }
        delete_entry(&self.root, id)
    }
}

fn new_preset_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("user-{nanos:x}")
}

fn band(enabled: bool, kind: EqBandKind, frequency_hz: f64, gain_db: f64, q: f64, slope: u8) -> EqBand {
    EqBand { enabled, kind, frequency_hz, gain_db, q, slope }
}

/// Los presets de fábrica (E1). Todos con las 6 bandas en el orden por
/// defecto (corte bajo, shelf bajo, dos campanas, shelf alto, corte alto) para
/// que el editor los muestre en las mismas posiciones. El nombre es el inglés
/// de reserva: la UI lo traduce por id.
pub fn factory_presets() -> Vec<EqPreset> {
    use EqBandKind::*;
    let q = TRACK_EQ_DEFAULT_Q;
    let preset = |id: &str, name: &str, bands: Vec<EqBand>| EqPreset {
        id: format!("{FACTORY_PRESET_PREFIX}{id}"),
        name: name.to_string(),
        eq: TrackEq { enabled: true, bands },
        factory: true,
    };
    vec![
        preset(
            "vocal-clean",
            "Vocal: clean lows",
            vec![
                band(true, LowCut, 100.0, 0.0, q, 12),
                band(true, LowShelf, 200.0, -2.0, q, 12),
                band(true, Peak, 350.0, -3.0, 1.0, 12),
                band(true, Peak, 3000.0, 2.0, 1.0, 12),
                band(true, HighShelf, 10000.0, 2.0, q, 12),
                band(false, HighCut, 18000.0, 0.0, q, 12),
            ],
        ),
        preset(
            "bass-definition",
            "Bass: definition",
            vec![
                band(true, LowCut, 35.0, 0.0, q, 12),
                band(true, LowShelf, 80.0, 2.0, q, 12),
                band(true, Peak, 250.0, -3.0, 1.0, 12),
                band(true, Peak, 800.0, 2.0, 1.2, 12),
                band(true, HighShelf, 5000.0, -2.0, q, 12),
                band(false, HighCut, 18000.0, 0.0, q, 12),
            ],
        ),
        preset(
            "kick",
            "Kick",
            vec![
                band(true, LowCut, 30.0, 0.0, q, 24),
                band(true, LowShelf, 60.0, 3.0, q, 12),
                band(true, Peak, 350.0, -4.0, 1.5, 12),
                band(true, Peak, 4000.0, 3.0, 1.0, 12),
                band(true, HighShelf, 10000.0, -2.0, q, 12),
                band(false, HighCut, 18000.0, 0.0, q, 12),
            ],
        ),
        preset(
            "acoustic",
            "Acoustic guitar",
            vec![
                band(true, LowCut, 80.0, 0.0, q, 12),
                band(true, LowShelf, 150.0, -1.5, q, 12),
                band(true, Peak, 220.0, -3.0, 1.0, 12),
                band(true, Peak, 5000.0, 2.0, 1.0, 12),
                band(true, HighShelf, 10000.0, 2.0, q, 12),
                band(false, HighCut, 18000.0, 0.0, q, 12),
            ],
        ),
        preset(
            "hpf-80",
            "Remove lows (HPF 80)",
            vec![
                band(true, LowCut, 80.0, 0.0, q, 12),
                band(true, LowShelf, 100.0, 0.0, q, 12),
                band(true, Peak, 400.0, 0.0, q, 12),
                band(true, Peak, 2500.0, 0.0, q, 12),
                band(true, HighShelf, 8000.0, 0.0, q, 12),
                band(false, HighCut, 18000.0, 0.0, q, 12),
            ],
        ),
        preset(
            "telephone",
            "Telephone",
            vec![
                band(true, LowCut, 300.0, 0.0, q, 24),
                band(true, LowShelf, 100.0, 0.0, q, 12),
                band(true, Peak, 1500.0, 4.0, 0.8, 12),
                band(true, Peak, 2500.0, 0.0, q, 12),
                band(true, HighShelf, 8000.0, 0.0, q, 12),
                band(true, HighCut, 3400.0, 0.0, q, 24),
            ],
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn curve(gain: f64) -> TrackEq {
        let mut eq = TrackEq::default();
        eq.bands[2].gain_db = gain;
        eq
    }

    #[test]
    fn round_trip_rename_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let lib = EqPresetLibrary::new(dir.path().join("eq-presets"));
        assert!(lib.list_user().unwrap().is_empty(), "sin carpeta = vacía");

        let saved = lib.save(None, "  Mi voz ", &curve(4.0)).unwrap();
        assert_eq!(saved.name, "Mi voz");
        assert!(!saved.factory);
        let listed = lib.list_user().unwrap();
        assert_eq!(listed, vec![saved.clone()]);

        // Renombrar = guardar con el mismo id.
        let renamed = lib.save(Some(&saved.id), "Voz 2", &curve(5.0)).unwrap();
        let listed = lib.list_user().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], renamed);
        assert_eq!(listed[0].eq.bands[2].gain_db, 5.0);

        lib.delete(&saved.id).unwrap();
        lib.delete(&saved.id).unwrap();
        assert!(lib.list_user().unwrap().is_empty());
    }

    #[test]
    fn broken_files_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let lib = EqPresetLibrary::new(dir.path().to_path_buf());
        lib.save(Some("ok"), "Ok", &curve(1.0)).unwrap();
        fs::write(dir.path().join("broken.json"), b"{nope").unwrap();
        fs::write(dir.path().join("notes.txt"), b"hola").unwrap();
        let listed = lib.list_user().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "ok");
    }

    #[test]
    fn out_of_range_eq_is_clamped_on_save() {
        let dir = tempfile::tempdir().unwrap();
        let lib = EqPresetLibrary::new(dir.path().to_path_buf());
        let mut eq = curve(99.0);
        eq.bands[1].frequency_hz = 1.0;
        eq.bands[3].q = f64::NAN;
        let saved = lib.save(Some("x"), "X", &eq).unwrap();
        assert_eq!(saved.eq, eq.sanitized());
        assert_eq!(saved.eq.bands[2].gain_db, 18.0);
        let on_disk: EqPreset = serde_json::from_slice(&fs::read(dir.path().join("x.json")).unwrap()).unwrap();
        assert_eq!(on_disk.eq, eq.sanitized());
        assert!(!on_disk.factory);
    }

    #[test]
    fn factory_ids_and_unsafe_ids_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let lib = EqPresetLibrary::new(dir.path().to_path_buf());
        for bad in ["factory-kick", "../x", "a/b", ""] {
            assert!(lib.save(Some(bad), "X", &curve(0.0)).is_err(), "{bad}");
        }
        assert!(lib.delete("factory-kick").is_err());
        // Un fichero que se haga pasar por uno de fábrica no aparece.
        fs::write(
            dir.path().join("factory-kick.json"),
            serde_json::to_vec(&EqPreset { id: "factory-kick".into(), name: "Fake".into(), eq: curve(1.0), factory: false }).unwrap(),
        )
        .unwrap();
        assert!(lib.list_user().unwrap().is_empty());
    }

    #[test]
    fn factory_presets_are_already_sanitized() {
        let presets = factory_presets();
        assert_eq!(presets.len(), 6);
        for preset in &presets {
            assert_eq!(preset.eq, preset.eq.sanitized(), "{}", preset.id);
            assert_eq!(preset.eq.bands.len(), 6, "{}", preset.id);
            assert!(preset.factory);
            assert!(preset.id.starts_with(FACTORY_PRESET_PREFIX));
            assert!(is_safe_entry_id(&preset.id));
        }
        let mut ids: Vec<_> = presets.iter().map(|p| p.id.clone()).collect();
        ids.dedup();
        assert_eq!(ids.len(), 6);
    }

    #[test]
    fn list_puts_factory_first() {
        let dir = tempfile::tempdir().unwrap();
        let lib = EqPresetLibrary::new(dir.path().to_path_buf());
        lib.save(Some("mine"), "Aaa", &curve(1.0)).unwrap();
        let all = lib.list().unwrap();
        assert_eq!(all.len(), 7);
        assert!(all[..6].iter().all(|p| p.factory));
        assert_eq!(all[6].id, "mine");
    }
}
