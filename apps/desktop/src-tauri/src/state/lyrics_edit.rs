//! El vínculo de letra de cada canción con el programa de proyección (plan
//! lyrics-sync). Como la letra ChordPro, el commit es `MixerOnly`: sólo cambia
//! el modelo de Rust.

use libretracks_core::{LyricsLink, RegionLyrics};

use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;

use super::{AudioChangeImpact, DesktopSession};

impl DesktopSession {
    /// Sustituye la letra en proyección de una canción (`None` la quita). Un
    /// paso de deshacer por llamada.
    pub fn set_region_lyrics(
        &mut self,
        region_id: &str,
        lyrics: Option<RegionLyrics>,
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
        if region.lyrics == lyrics {
            return Ok(self.snapshot());
        }
        region.lyrics = lyrics;
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;
        Ok(self.snapshot())
    }

    /// El resolutor encontró la presentación de una canción por su nombre (o
    /// el id guardado no existe en este equipo): se guarda SIN paso de
    /// deshacer (D10), conservando las correcciones del usuario.
    pub fn store_lyrics_link_silently(
        &mut self,
        region_id: &str,
        link: LyricsLink,
        audio: &AudioController,
    ) -> Result<(), DesktopError> {
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
        let updated = crate::lyrics::with_link(region.lyrics.clone(), link);
        if region.lyrics.as_ref() == Some(&updated) {
            return Ok(());
        }
        region.lyrics = Some(updated);
        self.persist_song_update_internal(
            song,
            audio,
            AudioChangeImpact::MixerOnly,
            false,
            true,
            super::UpdatePhase::Commit,
        )
    }
}
