//! Loops de batería y one shots del lado de Rust (plan drum-loops, paso 05).
//!
//! `RhythmRuntime` sabe qué patrón está activo, qué banco de one shots y qué
//! loops traen las canciones; con la biblioteca en disco calcula un
//! [`RhythmSyncPlan`]: qué muestras cargar (slots estables) y qué comandos
//! mandar al motor. El `AudioController` lo ejecuta fuera de sus locks
//! (`audio/engine_rhythm.rs`).

pub mod import;
pub mod meters;

use std::path::PathBuf;

use libretracks_core::drum_loop_resolve::{
    initial_rows, resolve_one_shot_bank, resolve_pattern, resolve_sample_path, ResolvedLoopPattern,
    SampleRoots, SlotTable,
};
use libretracks_core::drum_loops::{DrumKit, KitRef, LoopPattern, RegionLoop, SampleRef};
use libretracks_core::Song;
use libretracks_project::rhythm_library::{RhythmLibrary, RhythmLibraryData};
use lt_audio_engine_v2::{
    EngineCommand, LoopEnginePattern, LoopEngineRow, LoopEngineRowState, OneShotEnginePad,
    RegionLoopEngine, SampleLoadRequest, SampleSlotPath,
};

/// Tope de RAM de muestras (D11).
#[cfg(any(target_os = "android", target_os = "ios"))]
pub const SAMPLE_BANK_MAX_BYTES: u64 = 48 * 1024 * 1024;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub const SAMPLE_BANK_MAX_BYTES: u64 = 96 * 1024 * 1024;

/// Lo que hay que hacer en el motor tras un cambio.
#[derive(Debug, Clone, Default)]
pub struct RhythmSyncPlan {
    /// `Some` cuando cambian las muestras: hay que cargar antes de mandar los
    /// comandos (los patrones apuntan a esos slots).
    pub load: Option<SampleLoadRequest>,
    pub commands: Vec<EngineCommand>,
}

#[derive(Debug, Default)]
pub struct RhythmRuntime {
    library: Option<RhythmLibrary>,
    roots: Option<SampleRoots>,
    slots: SlotTable,
    region_loops: Vec<(String, RegionLoop)>,
}

impl RhythmRuntime {
    /// `loops_root` = `<app_local_data>/loops`; `builtin_root` = kit incluido.
    pub fn configure(&mut self, loops_root: PathBuf, builtin_root: PathBuf) {
        let library = RhythmLibrary::new(loops_root);
        let _ = library.ensure_dirs();
        self.roots = Some(SampleRoots {
            builtin: builtin_root,
            packs: library.packs_dir(),
            user: library.user_dir(),
        });
        self.library = Some(library);
    }

    pub fn library(&self) -> Option<&RhythmLibrary> {
        self.library.as_ref()
    }

    /// Recoge los loops de las canciones de la sesión.
    pub fn set_song(&mut self, song: &Song) {
        self.region_loops = song
            .regions
            .iter()
            .filter_map(|region| region.drum_loop.clone().map(|l| (region.id.clone(), l)))
            .collect();
    }

    /// Lee la biblioteca y calcula el plan.
    pub fn plan(&mut self, active_pattern_id: &str, active_bank: usize) -> Result<RhythmSyncPlan, String> {
        let library = self.library.as_ref().ok_or("rhythm library not configured")?;
        let data = library.load().map_err(|e| e.to_string())?;
        Ok(self.plan_with(&data, active_pattern_id, active_bank))
    }

    /// Plan con una biblioteca ya leída (puro salvo por la tabla de slots).
    pub fn plan_with(
        &mut self,
        data: &RhythmLibraryData,
        active_pattern_id: &str,
        active_bank: usize,
    ) -> RhythmSyncPlan {
        let Some(roots) = self.roots.clone() else {
            return RhythmSyncPlan::default();
        };
        let path_of = |sample: &SampleRef| resolve_sample_path(sample, &roots);

        let active = data
            .patterns
            .iter()
            .find(|p| p.id == active_pattern_id)
            .and_then(|p| kit_for(p, &data.kits).map(|k| (p.clone(), k)));
        let bank = data.one_shots.normalized().banks.get(active_bank).cloned();

        // Todas las muestras que tienen que estar en el banco a la vez: un
        // `load` sustituye el banco entero.
        let mut paths: Vec<PathBuf> = Vec::new();
        if let Some((_, kit)) = &active {
            paths.extend(kit.sounds.iter().filter_map(|s| path_of(&s.sample)));
        }
        for (_, region_loop) in &self.region_loops {
            if let Some(kit) = kit_for(&region_loop.pattern, &data.kits) {
                paths.extend(kit.sounds.iter().filter_map(|s| path_of(&s.sample)));
            }
        }
        if let Some(bank) = &bank {
            paths.extend(bank.pads.iter().flatten().filter_map(|p| path_of(&p.sample)));
        }
        let assignment = self.slots.assign(paths);

        let mut plan = RhythmSyncPlan::default();
        if assignment.changed() {
            plan.load = Some(SampleLoadRequest {
                samples: self
                    .slots
                    .entries()
                    .into_iter()
                    .map(|(slot, path)| SampleSlotPath { slot, path: path.to_string_lossy().into_owned() })
                    .collect(),
                max_bytes: Some(SAMPLE_BANK_MAX_BYTES),
                sample_rate: None,
            });
        }
        let slots = &self.slots;
        let slot_of = |sample: &SampleRef| path_of(sample).and_then(|p| slots.slot_of(&p));

        if let Some((pattern, kit)) = &active {
            plan.commands.push(EngineCommand::SetLoopPattern {
                pattern: engine_pattern(&resolve_pattern(pattern, kit, slot_of)),
            });
        }
        let regions = self
            .region_loops
            .iter()
            .filter_map(|(region_id, region_loop)| {
                let kit = kit_for(&region_loop.pattern, &data.kits)?;
                let resolved = resolve_pattern(&region_loop.pattern, &kit, slot_of);
                let rows = initial_rows(resolved.rows.len(), &region_loop.initial_rows);
                Some(RegionLoopEngine {
                    region_id: region_id.clone(),
                    pattern: engine_pattern(&resolved),
                    autostart: region_loop.autostart,
                    initial_rows: rows
                        .into_iter()
                        .map(|r| LoopEngineRowState { enabled: r.enabled, variation: i32::from(r.variation) })
                        .collect(),
                })
            })
            .collect();
        plan.commands.push(EngineCommand::SetRegionLoops { regions });
        if let Some(bank) = &bank {
            plan.commands.push(EngineCommand::SetOneShotBank {
                pads: resolve_one_shot_bank(bank, slot_of)
                    .into_iter()
                    .map(|pad| {
                        pad.map(|p| OneShotEnginePad {
                            slot: p.slot,
                            gain: p.gain,
                            mode: p.mode.into(),
                            quantize: p.quantize.into(),
                            choke_group: p.choke_group,
                        })
                    })
                    .collect(),
            });
        }
        plan
    }
}

/// El kit de un patrón: el incrustado o el de la biblioteca.
pub fn kit_for(pattern: &LoopPattern, kits: &[DrumKit]) -> Option<DrumKit> {
    match &pattern.kit {
        KitRef::Embedded { kit } => Some(kit.clone()),
        KitRef::Library { kit_id } => kits.iter().find(|k| &k.id == kit_id).cloned(),
    }
}

/// Copia del patrón con su kit incrustado: lo que se guarda en una canción
/// para que viaje sin referencias rotas (D5).
pub fn embed_kit(pattern: &LoopPattern, kits: &[DrumKit]) -> Option<LoopPattern> {
    let kit = kit_for(pattern, kits)?;
    let mut copy = pattern.clone();
    copy.kit = KitRef::Embedded { kit };
    Some(copy.normalized())
}

pub fn engine_pattern(resolved: &ResolvedLoopPattern) -> LoopEnginePattern {
    LoopEnginePattern {
        steps_per_beat: resolved.steps_per_beat,
        beats_per_bar: resolved.beats_per_bar,
        beat_unit: resolved.beat_unit,
        bars: resolved.bars,
        free_bpm: resolved.free_bpm,
        swing: resolved.swing,
        rows: resolved
            .rows
            .iter()
            .map(|row| LoopEngineRow {
                slot: row.slot,
                gain: row.gain,
                choke_group: row.choke_group,
                variations: row.variations.clone(),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests;
