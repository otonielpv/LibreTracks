//! Loops de batería por pasos y one shots (plan `drum-loops`).
//!
//! Modelo puro: tipos serializables, normalización a los límites y las
//! operaciones del editor de patrones. El motor C++ recibe estos datos ya
//! resueltos a slots de muestra (pasos 02-05); aquí no hay rutas ni audio.

use serde::{Deserialize, Serialize};

/// Sonidos por kit (= filas de un patrón).
pub const MAX_KIT_SOUNDS: usize = 8;
/// Variaciones por fila (A-D).
pub const MAX_VARIATIONS: usize = 4;
/// Pasos por variación (4 compases × 16).
pub const MAX_STEPS: usize = 64;
/// Bancos de one shots (A-D).
pub const MAX_ONE_SHOT_BANKS: usize = 4;
/// Pads por banco (rejilla 4×3).
pub const PADS_PER_BANK: usize = 12;
pub const MIN_PATTERN_BPM: f64 = 30.0;
pub const MAX_PATTERN_BPM: f64 = 300.0;
pub const MAX_SWING: f32 = 0.75;
/// Valor máximo de un paso: 0 silencio, 1 suave, 2 normal, 3 acento.
pub const MAX_STEP_VELOCITY: u8 = 3;
pub const STEP_SOFT: u8 = 1;
pub const STEP_NORMAL: u8 = 2;
pub const STEP_ACCENT: u8 = 3;

/// De dónde sale una muestra. Rust la resuelve a una ruta del disco.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SampleSource {
    /// Kit incluido en la app.
    Builtin,
    /// Pack descargado.
    Pack {
        #[serde(rename = "packId")]
        pack_id: String,
    },
    /// Importada por el usuario (`loops/user/`).
    User,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleRef {
    pub source: SampleSource,
    pub file: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sound {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
    pub sample: SampleRef,
    #[serde(default)]
    pub gain_db: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choke_group: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrumKit {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub sounds: Vec<Sound>,
}

impl DrumKit {
    pub fn normalized(&self) -> DrumKit {
        let mut kit = self.clone();
        kit.sounds.truncate(MAX_KIT_SOUNDS);
        kit
    }

    pub fn has_sound(&self, sound_id: &str) -> bool {
        self.sounds.iter().any(|sound| sound.id == sound_id)
    }
}

/// El kit de un patrón: uno de la biblioteca o una copia incrustada (la que
/// viaja con una canción).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum KitRef {
    Library {
        #[serde(rename = "kitId")]
        kit_id: String,
    },
    Embedded { kit: DrumKit },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternSignature {
    pub numerator: u8,
    pub denominator: u8,
}

impl Default for PatternSignature {
    fn default() -> Self {
        Self { numerator: 4, denominator: 4 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopRow {
    pub sound_id: String,
    #[serde(default)]
    pub gain_db: f32,
    /// A-D. Un byte por paso: 0 silencio, 1 suave, 2 normal, 3 acento.
    #[serde(default)]
    pub variations: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopPattern {
    pub id: String,
    pub name: String,
    pub kit: KitRef,
    /// BPM del modo de reloj libre.
    pub bpm: f64,
    #[serde(default)]
    pub signature: PatternSignature,
    /// 4 = semicorcheas, 3 = tresillos.
    pub steps_per_beat: u8,
    /// 1, 2 o 4.
    pub bars: u8,
    #[serde(default)]
    pub swing: f32,
    #[serde(default)]
    pub rows: Vec<LoopRow>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoopRowLiveState {
    pub enabled: bool,
    /// 0..4 (A-D).
    pub variation: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoopLiveState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern_id: Option<String>,
    #[serde(default)]
    pub playing: bool,
    #[serde(default)]
    pub rows: Vec<LoopRowLiveState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum OneShotMode {
    /// Suena entero al pulsar.
    #[default]
    OneShot,
    /// Suena mientras se mantiene pulsado.
    Gate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TriggerQuantize {
    #[default]
    Off,
    Beat,
    Bar,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneShotPad {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
    pub sample: SampleRef,
    #[serde(default)]
    pub gain_db: f32,
    #[serde(default)]
    pub mode: OneShotMode,
    #[serde(default)]
    pub quantize: TriggerQuantize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choke_group: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneShotBank {
    pub id: String,
    pub name: String,
    /// Siempre `PADS_PER_BANK` tras normalizar; `None` es un hueco vacío.
    #[serde(default)]
    pub pads: Vec<Option<OneShotPad>>,
}

impl OneShotBank {
    pub fn normalized(&self) -> OneShotBank {
        let mut bank = self.clone();
        bank.pads.resize(PADS_PER_BANK, None);
        bank
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OneShotSet {
    #[serde(default)]
    pub banks: Vec<OneShotBank>,
}

impl OneShotSet {
    pub fn normalized(&self) -> OneShotSet {
        OneShotSet {
            banks: self
                .banks
                .iter()
                .take(MAX_ONE_SHOT_BANKS)
                .map(OneShotBank::normalized)
                .collect(),
        }
    }
}

/// Loop asignado a una canción: copia incrustada del patrón (sin referencias
/// que se puedan romper) y cómo arranca.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionLoop {
    pub pattern: LoopPattern,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default)]
    pub initial_rows: Vec<LoopRowLiveState>,
}

/// Errores de `LoopPattern::validate`, para que la UI los traduzca.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum PatternError {
    EmptyName,
    KitWithoutSounds,
    NoRows,
    UnknownSound {
        #[serde(rename = "soundId")]
        sound_id: String,
    },
    InvalidStepsPerBeat,
    InvalidBars,
}

/// Resultado de `set_steps_per_beat`: cuántos pasos activos no caían en una
/// posición exacta de la rejilla nueva y se movieron al más cercano.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StepConversion {
    pub moved_steps: usize,
}

impl StepConversion {
    pub fn is_exact(&self) -> bool {
        self.moved_steps == 0
    }
}

fn valid_steps_per_beat(value: u8) -> bool {
    value == 3 || value == 4
}

fn valid_bars(value: u8) -> bool {
    matches!(value, 1 | 2 | 4)
}

fn clamp_bars(value: u8) -> u8 {
    match value {
        0 | 1 => 1,
        2 | 3 => 2,
        _ => 4,
    }
}

impl LoopPattern {
    pub fn beats_per_bar(&self) -> usize {
        self.signature.numerator.max(1) as usize
    }

    pub fn steps_per_bar(&self) -> usize {
        self.beats_per_bar() * self.steps_per_beat.max(1) as usize
    }

    /// Pasos de cada variación, acotado a `MAX_STEPS`.
    pub fn step_count(&self) -> usize {
        (self.steps_per_bar() * self.bars.max(1) as usize).min(MAX_STEPS)
    }

    /// El kit incrustado, si lo hay.
    pub fn embedded_kit(&self) -> Option<&DrumKit> {
        match &self.kit {
            KitRef::Embedded { kit } => Some(kit),
            KitRef::Library { .. } => None,
        }
    }

    /// Normaliza contra el kit incrustado (si el kit es de la biblioteca no
    /// puede saber qué sonidos existen y no quita filas por eso).
    pub fn normalized(&self) -> LoopPattern {
        let kit = self.embedded_kit().cloned();
        self.normalized_with_kit(kit.as_ref())
    }

    /// Recorta a los límites, ajusta la longitud de cada variación a
    /// `bars × beats_per_bar × steps_per_beat`, quita las filas cuyo sonido
    /// no está en `kit` y acota swing y BPM.
    pub fn normalized_with_kit(&self, kit: Option<&DrumKit>) -> LoopPattern {
        let mut pattern = self.clone();
        if let KitRef::Embedded { kit } = &mut pattern.kit {
            *kit = kit.normalized();
        }
        if !valid_steps_per_beat(pattern.steps_per_beat) {
            pattern.steps_per_beat = 4;
        }
        pattern.bars = clamp_bars(pattern.bars);
        pattern.signature.numerator = pattern.signature.numerator.clamp(1, 16);
        if !matches!(pattern.signature.denominator, 2 | 4 | 8 | 16) {
            pattern.signature.denominator = 4;
        }
        pattern.bpm = if pattern.bpm.is_finite() {
            pattern.bpm.clamp(MIN_PATTERN_BPM, MAX_PATTERN_BPM)
        } else {
            120.0
        };
        pattern.swing = if pattern.swing.is_finite() {
            pattern.swing.clamp(0.0, MAX_SWING)
        } else {
            0.0
        };
        // Con un compás largo, 4 compases pueden pasar de 64 pasos: se bajan
        // compases hasta caber (truncar a mitad de compás descuadraría).
        while pattern.bars > 1 && pattern.steps_per_bar() * pattern.bars as usize > MAX_STEPS {
            pattern.bars = clamp_bars(pattern.bars / 2);
        }
        let kit = kit.map(DrumKit::normalized);
        if let Some(kit) = &kit {
            pattern.rows.retain(|row| kit.has_sound(&row.sound_id));
        }
        pattern.rows.truncate(MAX_KIT_SOUNDS);
        let steps = pattern.step_count();
        for row in &mut pattern.rows {
            row.variations.resize(MAX_VARIATIONS, Vec::new());
            row.variations.truncate(MAX_VARIATIONS);
            for variation in &mut row.variations {
                variation.resize(steps, 0);
                for step in variation.iter_mut() {
                    *step = (*step).min(MAX_STEP_VELOCITY);
                }
            }
        }
        pattern
    }

    /// Errores que la UI debe enseñar antes de guardar.
    pub fn validate(&self, kit: Option<&DrumKit>) -> Vec<PatternError> {
        let mut errors = Vec::new();
        if self.name.trim().is_empty() {
            errors.push(PatternError::EmptyName);
        }
        if !valid_steps_per_beat(self.steps_per_beat) {
            errors.push(PatternError::InvalidStepsPerBeat);
        }
        if !valid_bars(self.bars) {
            errors.push(PatternError::InvalidBars);
        }
        let kit = kit.or(self.embedded_kit());
        if let Some(kit) = kit {
            if kit.sounds.is_empty() {
                errors.push(PatternError::KitWithoutSounds);
            }
            for row in &self.rows {
                if !kit.has_sound(&row.sound_id) {
                    errors.push(PatternError::UnknownSound {
                        sound_id: row.sound_id.clone(),
                    });
                }
            }
        }
        if self.rows.is_empty() {
            errors.push(PatternError::NoRows);
        }
        errors
    }

    fn step_mut(&mut self, row: usize, variation: usize, step: usize) -> Option<&mut u8> {
        self.rows
            .get_mut(row)?
            .variations
            .get_mut(variation)?
            .get_mut(step)
    }

    /// Enciende (a normal) o apaga un paso. Devuelve si cambió algo.
    pub fn toggle_step(&mut self, row: usize, variation: usize, step: usize) -> bool {
        match self.step_mut(row, variation, step) {
            Some(value) => {
                *value = if *value == 0 { STEP_NORMAL } else { 0 };
                true
            }
            None => false,
        }
    }

    /// Cicla la intensidad: silencio/suave → normal → acento → suave.
    pub fn cycle_velocity(&mut self, row: usize, variation: usize, step: usize) -> bool {
        match self.step_mut(row, variation, step) {
            Some(value) => {
                *value = match *value {
                    STEP_NORMAL => STEP_ACCENT,
                    STEP_ACCENT => STEP_SOFT,
                    _ => STEP_NORMAL,
                };
                true
            }
            None => false,
        }
    }

    /// Pinta `value` en los pasos `range` (arrastrar en el editor).
    pub fn paint_steps(
        &mut self,
        row: usize,
        variation: usize,
        range: std::ops::Range<usize>,
        value: u8,
    ) -> bool {
        let value = value.min(MAX_STEP_VELOCITY);
        let Some(steps) = self
            .rows
            .get_mut(row)
            .and_then(|row| row.variations.get_mut(variation))
        else {
            return false;
        };
        let end = range.end.min(steps.len());
        let mut changed = false;
        for step in range.start.min(end)..end {
            if steps[step] != value {
                steps[step] = value;
                changed = true;
            }
        }
        changed
    }

    /// Copia la variación `from` sobre `to` en todas las filas.
    pub fn copy_variation(&mut self, from: usize, to: usize) -> bool {
        if from >= MAX_VARIATIONS || to >= MAX_VARIATIONS || from == to {
            return false;
        }
        for row in &mut self.rows {
            if let Some(source) = row.variations.get(from).cloned() {
                if let Some(target) = row.variations.get_mut(to) {
                    *target = source;
                }
            }
        }
        true
    }

    /// Vacía una fila (las cuatro variaciones).
    pub fn clear_row(&mut self, row: usize) -> bool {
        match self.rows.get_mut(row) {
            Some(row) => {
                for variation in &mut row.variations {
                    variation.iter_mut().for_each(|step| *step = 0);
                }
                true
            }
            None => false,
        }
    }

    /// Cambia el número de compases. Al crecer repite el contenido; al
    /// encoger trunca.
    pub fn resize_bars(&mut self, new_bars: u8) {
        let new_bars = clamp_bars(new_bars);
        let old_steps = self.step_count();
        self.bars = new_bars;
        let new_steps = self.step_count();
        for row in &mut self.rows {
            for variation in &mut row.variations {
                variation.resize(old_steps, 0);
                if new_steps <= old_steps || old_steps == 0 {
                    variation.resize(new_steps, 0);
                } else {
                    let source = variation.clone();
                    *variation = (0..new_steps).map(|i| source[i % old_steps]).collect();
                }
            }
        }
    }

    /// Cambia los pasos por tiempo conservando la posición en el tiempo de
    /// cada paso activo. Los que no caen exactos van al paso más cercano y se
    /// cuentan en el resultado para que la UI avise.
    pub fn set_steps_per_beat(&mut self, new_steps_per_beat: u8) -> StepConversion {
        let mut report = StepConversion::default();
        if !valid_steps_per_beat(new_steps_per_beat) || new_steps_per_beat == self.steps_per_beat {
            return report;
        }
        let old_spb = self.steps_per_beat.max(1) as usize;
        let new_spb = new_steps_per_beat as usize;
        self.steps_per_beat = new_steps_per_beat;
        let new_steps = self.step_count();
        for row in &mut self.rows {
            for variation in &mut row.variations {
                let mut converted = vec![0u8; new_steps];
                for (index, &value) in variation.iter().enumerate() {
                    if value == 0 {
                        continue;
                    }
                    let scaled = index * new_spb;
                    let exact = scaled % old_spb == 0;
                    // Al paso más cercano; un empate va al de arriba.
                    let target = (scaled + old_spb / 2) / old_spb;
                    if !exact {
                        report.moved_steps += 1;
                    }
                    if target < new_steps {
                        converted[target] = converted[target].max(value);
                    }
                }
                *variation = converted;
            }
        }
        report
    }
}

#[cfg(test)]
#[path = "drum_loops_tests.rs"]
mod tests;
