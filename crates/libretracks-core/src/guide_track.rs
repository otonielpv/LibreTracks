//! La pista de guía de la secuencia: la voz grabada que trae el multitrack
//! («Coro, 1, 2, 3, 4»). Con la voz guía en «solo en saltos» el motor la
//! silencia mientras anuncia un salto (estilo AbleSet), así que hace falta
//! saber cuál es.
//!
//! Se detecta por el nombre («Guía», «Guide», «Cues»…), como ya hace el
//! análisis de canción, y el usuario puede corregirlo por pista con
//! [`Track::guide`]: `Some(true)` la marca aunque se llame de otra forma y
//! `Some(false)` la descarta aunque el nombre encaje.
//!
//! Una pista que se llame también «Click» («Click + Guía») NO se detecta
//! sola: silenciarla durante el aviso quitaría también el click. Si el usuario
//! la elige a mano, es su decisión.

use crate::model::{Song, SongRegion, Track, TrackKind};

/// Lo mínimo que un clip debe pisar una canción para contar como suyo (el
/// mismo umbral que usa el análisis de canción en el frontend).
const MIN_SONG_OVERLAP_SECONDS: f64 = 0.01;

const GUIDE_WORDS: &[&str] = &["guide", "guides", "guia", "guias", "cue", "cues"];
const CLICK_WORDS: &[&str] = &["click", "clic", "clik", "metronom", "metronomo", "metronome"];

fn fold_accents(c: char) -> char {
    match c {
        'á' | 'à' | 'ä' | 'â' => 'a',
        'é' | 'è' | 'ë' | 'ê' => 'e',
        'í' | 'ì' | 'ï' | 'î' => 'i',
        'ó' | 'ò' | 'ö' | 'ô' => 'o',
        'ú' | 'ù' | 'ü' | 'û' => 'u',
        other => other,
    }
}

fn words(name: &str) -> impl Iterator<Item = String> + '_ {
    name.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| word.to_lowercase().chars().map(fold_accents).collect())
}

/// Si el nombre dice «guía» (y no también «click»).
pub fn name_says_guide(name: &str) -> bool {
    let mut guide = false;
    for word in words(name) {
        if CLICK_WORDS.contains(&word.as_str()) {
            return false;
        }
        guide |= GUIDE_WORDS.contains(&word.as_str());
    }
    guide
}

/// Si la pista es la guía de la secuencia: lo que el usuario eligió o, si no
/// eligió nada, lo que dice su nombre. Solo una pista de audio puede serlo.
pub fn is_guide_track(track: &Track) -> bool {
    track.kind == TrackKind::Audio
        && track
            .guide
            .unwrap_or_else(|| name_says_guide(&track.name))
}

/// Si la pista tiene algún clip que suene dentro de la canción.
pub fn track_sounds_in_region(song: &Song, track_id: &str, region: &SongRegion) -> bool {
    song.clips.iter().any(|clip| {
        clip.track_id == track_id && {
            let start = clip.timeline_start_seconds.max(region.start_seconds);
            let end = (clip.timeline_start_seconds + clip.duration_seconds).min(region.end_seconds);
            start + MIN_SONG_OVERLAP_SECONDS < end
        }
    })
}

/// Si la canción tiene una pista de guía que suene en ella.
pub fn region_has_guide_track(song: &Song, region: &SongRegion) -> bool {
    song.tracks
        .iter()
        .any(|track| is_guide_track(track) && track_sounds_in_region(song, &track.id, region))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guide_names_are_detected_in_spanish_and_english() {
        for name in ["Guía", "GUIA", "Guide", "Cues", "Voz guía", "Guide L", "guias"] {
            assert!(name_says_guide(name), "{name}");
        }
    }

    #[test]
    fn other_names_are_not_guides() {
        for name in ["Keys", "Guitarra", "Rescue", "Bajo", "Pad", "Guiado"] {
            assert!(!name_says_guide(name), "{name}");
        }
    }

    #[test]
    fn a_click_shared_with_the_guide_is_not_detected() {
        for name in ["Click + Guía", "Click/Guide", "Clic y guía", "Metrónomo guía"] {
            assert!(!name_says_guide(name), "{name}");
        }
    }
}
