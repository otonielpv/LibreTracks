//! Reparto de color automático para pistas nuevas.
//!
//! El tester que viene de n-Track lo dijo así: *"cada track tiene que tener un
//! color diferente"*. Hasta ahora una pista sin color explícito caía en un gris
//! único para todas (`DEFAULT_TRACK_ACCENT` en el frontend), así que una sesión
//! recién importada era una pared de lanes idénticas.
//!
//! El reparto vive aquí, en el estado, y no en cada llamante: los tres sitios
//! que crean pistas (`create_track`, el camino de pistas auto-creadas al soltar
//! audio y `create_audio_tracks_with_clips`) piden el color a la misma función.

use libretracks_core::{Track, TrackKind};

/// Paleta de colores automáticos.
///
/// Es **la misma** que ve el usuario en el selector de color del frontend
/// (`apps/desktop/src/features/transport/colors/timelineColors.ts`,
/// `TIMELINE_COLOR_PRESETS`), y en el mismo orden, para que lo automático y lo
/// manual hablen el mismo idioma. Los nombres en español se quedan en el
/// frontend, que es quien los enseña.
///
/// Las dos listas están duplicadas por fuerza (una en Rust, otra en
/// TypeScript). Lo que impide que se separen es
/// `colors/autoTrackColorPalette.test.ts`, que lee este mismo fichero y compara
/// los hex uno a uno.
pub(crate) const AUTO_TRACK_COLORS: [&str; 14] = [
    "#E35D5B", // Rojo
    "#F08A6C", // Coral
    "#EE8A3C", // Naranja
    "#E0A83A", // Ambar
    "#B7D34A", // Lima
    "#57B66C", // Verde
    "#2FA98A", // Esmeralda
    "#3CDDC7", // Cian
    "#4FB8E6", // Celeste
    "#5C8CE6", // Azul
    "#6F6FE0", // Indigo
    "#9C73E6", // Violeta
    "#C96FD6", // Magenta
    "#DF6FA8", // Rosa
];

/// Color que le toca a la pista coloreable número `index` (contando desde 0).
///
/// Recorre la paleta en orden y da la vuelta al agotarla, así que dos pistas
/// creadas seguidas nunca comparten color y el resultado es reproducible.
pub(crate) fn auto_track_color_at(index: usize) -> &'static str {
    AUTO_TRACK_COLORS[index % AUTO_TRACK_COLORS.len()]
}

/// Cuántas pistas coloreables hay ya en la canción.
///
/// Las carpetas quedan fuera del reparto: tienen su propio acento
/// (`DEFAULT_FOLDER_ACCENT`) y colorearlas rompería la lectura del árbol.
/// También quedan fuera de la cuenta, para que meter una carpeta entre dos
/// pistas no desplace el ciclo.
fn colorable_track_count(tracks: &[Track]) -> usize {
    tracks
        .iter()
        .filter(|track| track.kind != TrackKind::Folder)
        .count()
}

/// Color para una pista que se va a crear ahora mismo en `tracks`.
///
/// Devuelve `None` —es decir, el gris de siempre— cuando el ajuste está
/// apagado o cuando lo que se crea es una carpeta. Nunca repinta nada: sólo
/// decide el color de la pista que aún no existe.
pub(crate) fn auto_color_for_new_track(
    tracks: &[Track],
    kind: TrackKind,
    enabled: bool,
) -> Option<String> {
    if !enabled || kind == TrackKind::Folder {
        return None;
    }
    Some(auto_track_color_at(colorable_track_count(tracks)).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str, kind: TrackKind) -> Track {
        Track {
            id: id.to_string(),
            name: id.to_string(),
            kind,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: true,
            audio_to: "master".to_string(),
            color: None,
            auto_created: false,
            midi_port: None,
            midi_channel: 1,
            midi_enabled: true,
            collapsed: false,
            height_offset: None,
        }
    }

    #[test]
    fn n_tracks_get_n_distinct_colors_then_the_palette_wraps() {
        let palette_len = AUTO_TRACK_COLORS.len();
        let colors: Vec<&str> = (0..palette_len).map(auto_track_color_at).collect();

        let unique: std::collections::HashSet<&&str> = colors.iter().collect();
        assert_eq!(
            unique.len(),
            palette_len,
            "la paleta entera debe darse sin repetir un solo color"
        );

        // Al agotarla vuelve a empezar por el principio.
        assert_eq!(auto_track_color_at(palette_len), AUTO_TRACK_COLORS[0]);
        assert_eq!(auto_track_color_at(palette_len + 3), AUTO_TRACK_COLORS[3]);
        assert_eq!(auto_track_color_at(palette_len * 5 + 7), AUTO_TRACK_COLORS[7]);
    }

    #[test]
    fn consecutive_new_tracks_never_share_a_color() {
        let mut tracks: Vec<Track> = Vec::new();
        let mut assigned: Vec<String> = Vec::new();
        for index in 0..AUTO_TRACK_COLORS.len() {
            let color = auto_color_for_new_track(&tracks, TrackKind::Audio, true)
                .expect("el ajuste está activo y no es carpeta");
            assigned.push(color.clone());
            let mut next = track(&format!("t{index}"), TrackKind::Audio);
            next.color = Some(color);
            tracks.push(next);
        }
        let unique: std::collections::HashSet<&String> = assigned.iter().collect();
        assert_eq!(unique.len(), AUTO_TRACK_COLORS.len());
    }

    #[test]
    fn folders_stay_out_of_the_rotation() {
        let tracks = vec![track("a", TrackKind::Audio), track("f", TrackKind::Folder)];
        // La carpeta no cuenta: la siguiente pista es la número 1, no la 2.
        assert_eq!(
            auto_color_for_new_track(&tracks, TrackKind::Audio, true).as_deref(),
            Some(AUTO_TRACK_COLORS[1]),
        );
        // Y una carpeta nueva no se colorea.
        assert_eq!(
            auto_color_for_new_track(&tracks, TrackKind::Folder, true),
            None
        );
    }

    #[test]
    fn disabled_setting_keeps_the_historical_grey() {
        assert_eq!(
            auto_color_for_new_track(&[], TrackKind::Audio, false),
            None
        );
    }

    #[test]
    fn midi_tracks_take_part_like_audio_ones() {
        let tracks = vec![track("a", TrackKind::Audio)];
        assert_eq!(
            auto_color_for_new_track(&tracks, TrackKind::Midi, true).as_deref(),
            Some(AUTO_TRACK_COLORS[1]),
        );
    }
}
