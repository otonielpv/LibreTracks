//! Letra y acordes (ChordPro) de cada canción y su sincronía con las marcas.
//!
//! Sibling `impl DesktopSession` block. Nada de esto toca el motor de audio: el
//! commit es `MixerOnly`, que sólo sustituye el modelo de Rust.

use libretracks_core::SongChart;

use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;

use super::{AudioChangeImpact, DesktopSession};

impl DesktopSession {
    /// Sustituye la letra de una canción (o la quita con `None`). El gráfico
    /// llega entero del frontend, que es quien convierte el PDF y empareja
    /// secciones con marcas; aquí sólo se valida y se normaliza.
    pub fn set_song_region_chart(
        &mut self,
        region_id: &str,
        chart: Option<SongChart>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let chart = match chart {
            Some(mut chart) => {
                if chart.text.len() > SongChart::MAX_TEXT_BYTES {
                    return Err(DesktopError::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!(
                            "chart too large: {} bytes (max {})",
                            chart.text.len(),
                            SongChart::MAX_TEXT_BYTES
                        ),
                    )));
                }
                let markers = &song.section_markers;
                chart.normalize(|id| markers.iter().any(|marker| marker.id == id));
                Some(chart).filter(|chart| !chart.text.trim().is_empty())
            }
            None => None,
        };
        let region = song
            .regions
            .iter_mut()
            .find(|region| region.id == region_id)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
        if region.chart == chart {
            return Ok(self.snapshot());
        }
        region.chart = chart;
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;
        Ok(self.snapshot())
    }
}
