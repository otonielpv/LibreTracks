//! «Separar canales L/R» (plan channel-split, paso 04).
//!
//! Duplica una pista de audio estéreo con sus clips **apuntando a los mismos
//! ficheros** (no se copia audio) y deja la original en Solo izquierdo y la
//! nueva, justo debajo y en la misma carpeta, en Solo derecho. Es el caso de un
//! fichero estéreo con el multitrack paneado a un lado y el click + la guía al
//! otro.
//!
//! Decisiones (ver la bitácora del paso):
//! - La pista nueva copia todos los campos de la original salvo `id`, `name` y
//!   el modo: color, volumen, paneo, salida, transposición, alias…
//! - Automatizaciones, escenas de mezcla y vínculos MIDI que apuntan a la
//!   pista original NO se duplican: la nueva empieza sin ellos.
//! - Los clips de la pista también se copian en las instantáneas de estructura
//!   (original del arreglo y bloques con contenido propio), o una canción
//!   arreglada perdería la pista R al cambiar de arreglo. Los ids nuevos
//!   conservan el sufijo de copia `~n` de los arreglos, así lo que hay en el
//!   timeline sigue siendo exactamente lo que construye el arreglo.
//! - Un solo `persist_song_update` = un paso de deshacer.

use libretracks_core::{ChannelMode, Clip, Song, TrackKind};

use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::view::waveform_key_for_file_path;
use crate::models::TransportSnapshot;

use super::{unique_track_id, AudioChangeImpact, DesktopSession, WaveformMemoryCache};

/// Si la pista tiene algún clip estéreo, según la caché de ondas (los picos
/// del canal derecho están vacíos en las fuentes mono). No abre ficheros. Un
/// clip cuya onda aún no está en la caché cuenta como posible estéreo: mejor
/// ofrecer la acción que esconderla mientras se analiza.
pub(crate) fn track_has_stereo_audio(
    song: &Song,
    track_id: &str,
    waveform_cache: &WaveformMemoryCache,
) -> bool {
    song.clips
        .iter()
        .filter(|clip| clip.track_id == track_id)
        .any(|clip| waveform_cache.is_stereo(&waveform_key_for_file_path(&clip.file_path)) != Some(false))
}

/// Id del clip copiado a la pista nueva, conservando el sufijo `~n` de las
/// copias de un arreglo: `"c1~2"` → `"c1-track_9~2"`.
fn split_clip_id(id: &str, new_track_id: &str) -> String {
    match id.rsplit_once('~') {
        Some((base, suffix)) if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) => {
            format!("{base}-{new_track_id}~{suffix}")
        }
        _ => format!("{id}-{new_track_id}"),
    }
}

/// Inserta, justo detrás de cada clip de `from`, su copia en `to`.
fn duplicate_track_clips(clips: &mut Vec<Clip>, from: &str, to: &str) {
    if !clips.iter().any(|clip| clip.track_id == from) {
        return;
    }
    let mut out = Vec::with_capacity(clips.len() * 2);
    for clip in clips.drain(..) {
        let copy = (clip.track_id == from).then(|| Clip {
            id: split_clip_id(&clip.id, to),
            track_id: to.to_string(),
            ..clip.clone()
        });
        out.push(clip);
        out.extend(copy);
    }
    *clips = out;
}

impl DesktopSession {
    /// Ver el módulo. `left_name`/`right_name` vienen ya traducidos de la UI
    /// («Voz L» / «Voz R»).
    pub fn split_track_channels(
        &mut self,
        track_id: &str,
        left_name: &str,
        right_name: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let index = song
            .tracks
            .iter()
            .position(|track| track.id == track_id)
            .ok_or_else(|| DesktopError::TrackNotFound(track_id.to_string()))?;
        if song.tracks[index].kind != TrackKind::Audio {
            return Err(DesktopError::AudioCommand(
                "only audio tracks can be split into left and right".into(),
            ));
        }
        if !track_has_stereo_audio(&song, track_id, &self.waveform_cache) {
            return Err(DesktopError::AudioCommand(
                "the track has no stereo audio to split".into(),
            ));
        }
        let left_name = left_name.trim();
        let right_name = right_name.trim();
        if left_name.is_empty() || right_name.is_empty() {
            return Err(DesktopError::AudioCommand("track name must not be empty".into()));
        }

        let new_id = unique_track_id(&song.tracks);
        let mut right = song.tracks[index].clone();
        right.id = new_id.clone();
        right.name = right_name.to_string();
        right.channel_mode = ChannelMode::Right;
        let left = &mut song.tracks[index];
        left.name = left_name.to_string();
        left.channel_mode = ChannelMode::Left;
        // Una pista de audio no tiene hijos: justo debajo es la misma carpeta.
        song.tracks.insert(index + 1, right);

        duplicate_track_clips(&mut song.clips, track_id, &new_id);
        for structure in song.structures_mut() {
            duplicate_track_clips(&mut structure.original.clips, track_id, &new_id);
            for content in structure.block_contents_mut() {
                duplicate_track_clips(&mut content.clips, track_id, &new_id);
            }
        }

        self.persist_song_update(song, audio, AudioChangeImpact::StructureRebuild, true)?;
        Ok(self.snapshot())
    }
}

#[cfg(test)]
mod tests {
    use super::split_clip_id;

    #[test]
    fn copied_clip_ids_keep_the_arrangement_copy_suffix() {
        assert_eq!(split_clip_id("c1", "t9"), "c1-t9");
        assert_eq!(split_clip_id("c1~2", "t9"), "c1-t9~2");
        assert_eq!(split_clip_id("a~b", "t9"), "a~b-t9");
    }
}
