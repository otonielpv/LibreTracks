use base64::Engine as _;
use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;
use super::{AudioChangeImpact, DesktopSession};

impl DesktopSession {
    pub fn set_song_region_cover(
        &mut self,
        region_id: &str,
        cover_image: Option<String>,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if let Some(image) = &cover_image {
            let valid = image.len() <= 128 * 1024 && image.strip_prefix("data:image/jpeg;base64,")
                .and_then(|encoded| base64::engine::general_purpose::STANDARD.decode(encoded).ok())
                .is_some_and(|bytes| bytes.starts_with(&[0xff, 0xd8, 0xff]) && bytes.ends_with(&[0xff, 0xd9]));
            if !valid {
                return Err(DesktopError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, "Invalid or oversized cover image")));
            }
        }
        let mut song = self.engine.song().cloned().ok_or(DesktopError::NoSongLoaded)?;
        let region = song.regions.iter_mut().find(|region| region.id == region_id)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
        if region.cover_image == cover_image { return Ok(self.snapshot()); }
        region.cover_image = cover_image;
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;
        Ok(self.snapshot())
    }
}