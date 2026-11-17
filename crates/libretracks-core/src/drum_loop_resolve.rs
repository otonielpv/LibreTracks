//! Del modelo de loops (`drum_loops`) a lo que recibe el motor (plan
//! drum-loops, paso 05): rutas de las muestras, slots estables del banco y el
//! patrón resuelto con ganancias lineales. Lógica pura y testeada aquí porque
//! el crate de escritorio no enlaza tests completos.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use crate::drum_loops::{
    DrumKit, LoopPattern, LoopRowLiveState, OneShotBank, OneShotMode, OneShotPad, SampleRef,
    SampleSource, TriggerQuantize, MAX_VARIATIONS, PADS_PER_BANK,
};

/// Carpetas donde viven las muestras de cada origen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SampleRoots {
    /// Kit incluido en la app (recursos).
    pub builtin: PathBuf,
    /// `loops/packs/<pack_id>/`.
    pub packs: PathBuf,
    /// `loops/user/`.
    pub user: PathBuf,
}

/// Ruta de una muestra. `None` si el nombre intenta salir de su carpeta
/// (`..`, rutas absolutas) o está vacío.
pub fn resolve_sample_path(sample: &SampleRef, roots: &SampleRoots) -> Option<PathBuf> {
    let file = Path::new(&sample.file);
    if sample.file.trim().is_empty()
        || file.is_absolute()
        || file
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return None;
    }
    let base = match &sample.source {
        SampleSource::Builtin => roots.builtin.clone(),
        SampleSource::User => roots.user.clone(),
        SampleSource::Pack { pack_id } => {
            let pack = Path::new(pack_id);
            if pack_id.trim().is_empty()
                || pack.components().count() != 1
                || !matches!(pack.components().next(), Some(Component::Normal(_)))
            {
                return None;
            }
            roots.packs.join(pack)
        }
    };
    Some(base.join(file))
}

/// Slots del banco de muestras, estables entre cargas: una ruta conserva su
/// slot mientras se siga usando, así que editar un sonido no cambia los demás
/// (y el motor reutiliza lo ya decodificado, paso 02).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SlotTable {
    slots: BTreeMap<PathBuf, i32>,
}

/// Resultado de `SlotTable::assign`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SlotAssignment {
    /// Rutas que entraron (necesitan decodificarse).
    pub added: Vec<PathBuf>,
    /// Rutas que dejaron de usarse (su slot queda libre).
    pub removed: Vec<PathBuf>,
}

impl SlotAssignment {
    pub fn changed(&self) -> bool {
        !self.added.is_empty() || !self.removed.is_empty()
    }
}

impl SlotTable {
    /// Deja la tabla con exactamente `paths` (sin repetidos). Las que ya
    /// estaban conservan su slot; las nuevas toman el hueco libre más bajo.
    pub fn assign<I>(&mut self, paths: I) -> SlotAssignment
    where
        I: IntoIterator<Item = PathBuf>,
    {
        let wanted: Vec<PathBuf> = {
            let mut seen = std::collections::BTreeSet::new();
            paths.into_iter().filter(|p| seen.insert(p.clone())).collect()
        };
        let mut result = SlotAssignment::default();
        let keep: std::collections::BTreeSet<&PathBuf> = wanted.iter().collect();
        let removed: Vec<PathBuf> = self
            .slots
            .keys()
            .filter(|p| !keep.contains(p))
            .cloned()
            .collect();
        for path in &removed {
            self.slots.remove(path);
        }
        result.removed = removed;
        for path in wanted {
            if self.slots.contains_key(&path) {
                continue;
            }
            let used: std::collections::BTreeSet<i32> = self.slots.values().copied().collect();
            let slot = (0..).find(|s| !used.contains(s)).unwrap_or(0);
            self.slots.insert(path.clone(), slot);
            result.added.push(path);
        }
        result
    }

    pub fn slot_of(&self, path: &Path) -> Option<i32> {
        self.slots.get(path).copied()
    }

    /// `(slot, ruta)` ordenado por slot: la lista que se manda al motor.
    pub fn entries(&self) -> Vec<(i32, PathBuf)> {
        let mut entries: Vec<(i32, PathBuf)> = self.slots.iter().map(|(p, s)| (*s, p.clone())).collect();
        entries.sort_by_key(|(slot, _)| *slot);
        entries
    }

    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }
}

pub fn db_to_gain(db: f32) -> f32 {
    if !db.is_finite() {
        return 1.0;
    }
    10f32.powf(db.clamp(-96.0, 24.0) / 20.0)
}

/// Fila resuelta: slot, ganancia lineal (fila + sonido), grupo de corte y los
/// bytes de las cuatro variaciones.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedLoopRow {
    pub slot: i32,
    pub gain: f32,
    /// 0 = sin grupo.
    pub choke_group: i32,
    pub variations: Vec<Vec<u8>>,
}

/// Patrón con todo lo que necesita el motor.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedLoopPattern {
    pub steps_per_beat: i32,
    pub beats_per_bar: i32,
    pub beat_unit: i32,
    pub bars: i32,
    pub free_bpm: f64,
    pub swing: f64,
    pub rows: Vec<ResolvedLoopRow>,
}

/// Resuelve un patrón (ya normalizado contra `kit`). `slot_of` da el slot de
/// cada muestra; una fila cuyo sonido o muestra no existe queda con slot -1
/// (el motor la ignora) para no desplazar los índices de las filas.
pub fn resolve_pattern<F>(pattern: &LoopPattern, kit: &DrumKit, slot_of: F) -> ResolvedLoopPattern
where
    F: Fn(&SampleRef) -> Option<i32>,
{
    let pattern = pattern.normalized_with_kit(Some(kit));
    let rows = pattern
        .rows
        .iter()
        .map(|row| {
            let sound = kit.sounds.iter().find(|s| s.id == row.sound_id);
            let slot = sound.and_then(|s| slot_of(&s.sample)).unwrap_or(-1);
            let sound_gain = sound.map(|s| s.gain_db).unwrap_or(0.0);
            ResolvedLoopRow {
                slot,
                gain: db_to_gain(row.gain_db + sound_gain),
                choke_group: sound.and_then(|s| s.choke_group).map(i32::from).unwrap_or(0),
                variations: row.variations.iter().take(MAX_VARIATIONS).cloned().collect(),
            }
        })
        .collect();
    ResolvedLoopPattern {
        steps_per_beat: i32::from(pattern.steps_per_beat),
        beats_per_bar: i32::from(pattern.signature.numerator),
        beat_unit: i32::from(pattern.signature.denominator),
        bars: i32::from(pattern.bars),
        free_bpm: pattern.bpm,
        swing: f64::from(pattern.swing),
        rows,
    }
}

/// Estado inicial de las filas: el guardado o, si falta, todas encendidas en A.
pub fn initial_rows(row_count: usize, saved: &[LoopRowLiveState]) -> Vec<LoopRowLiveState> {
    (0..row_count)
        .map(|i| {
            saved.get(i).copied().unwrap_or(LoopRowLiveState {
                enabled: true,
                variation: 0,
            })
        })
        .collect()
}

/// Pad resuelto para el motor.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedOneShotPad {
    pub slot: i32,
    pub gain: f32,
    /// `oneShot` | `gate`
    pub mode: &'static str,
    /// `off` | `beat` | `bar`
    pub quantize: &'static str,
    pub choke_group: i32,
}

pub fn resolve_one_shot_pad<F>(pad: &OneShotPad, slot_of: F) -> ResolvedOneShotPad
where
    F: Fn(&SampleRef) -> Option<i32>,
{
    ResolvedOneShotPad {
        slot: slot_of(&pad.sample).unwrap_or(-1),
        gain: db_to_gain(pad.gain_db),
        mode: match pad.mode {
            OneShotMode::OneShot => "oneShot",
            OneShotMode::Gate => "gate",
        },
        quantize: match pad.quantize {
            TriggerQuantize::Off => "off",
            TriggerQuantize::Beat => "beat",
            TriggerQuantize::Bar => "bar",
        },
        choke_group: pad.choke_group.map(i32::from).unwrap_or(0),
    }
}

/// Los 12 huecos del banco; `None` = pad vacío.
pub fn resolve_one_shot_bank<F>(bank: &OneShotBank, slot_of: F) -> Vec<Option<ResolvedOneShotPad>>
where
    F: Fn(&SampleRef) -> Option<i32>,
{
    let bank = bank.normalized();
    bank.pads
        .iter()
        .take(PADS_PER_BANK)
        .map(|pad| pad.as_ref().map(|p| resolve_one_shot_pad(p, &slot_of)))
        .collect()
}

#[cfg(test)]
#[path = "drum_loop_resolve_tests.rs"]
mod tests;
