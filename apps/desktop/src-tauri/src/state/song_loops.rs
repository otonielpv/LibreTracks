//! Loop de batería por canción (plan drum-loops, D5): asignar una copia del
//! patrón (con el kit incrustado) a una región o quitarla. Una edición como
//! cualquier otra: deshacer, autoguardado y `project_revision`. El motor recibe
//! los loops de todas las canciones con `SetRegionLoops` (vía
//! `update_live_song_regions`).

use libretracks_core::drum_loops::RegionLoop;

use super::{AudioChangeImpact, DesktopSession};
use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;

impl DesktopSession {
    pub fn set_song_region_loop(
        &mut self,
        region_id: &str,
        region_loop: Option<RegionLoop>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let region = song
            .regions
            .iter_mut()
            .find(|region| region.id == region_id)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
        let region_loop = region_loop.map(|mut l| {
            l.pattern = l.pattern.normalized();
            l
        });
        if region.drum_loop == region_loop {
            return Ok(self.snapshot());
        }
        region.drum_loop = region_loop;

        audio.update_live_song_regions(&song)?;
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;
        Ok(self.snapshot())
    }
}
