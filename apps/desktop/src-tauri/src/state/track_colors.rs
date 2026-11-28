//! Reparto de color automático para pistas nuevas.
//!
//! El tester que viene de n-Track lo dijo así: *"cada track tiene que tener un
//! color diferente"*. Hasta ahora una pista sin color explícito caía en un gris
//! único para todas (`DEFAULT_TRACK_ACCENT` en el frontend), así que una sesión
//! recién importada era una pared de lanes idénticas.
//!
//! El reparto vive aquí, en el estado, y no en cada llamante: todos los sitios
//! que crean pistas piden el color a la misma función.
//!
//! Primero se mira el nombre: una pista que se reconoce como de una familia
//! (guía, batería, guitarra eléctrica…) toma el color de su grupo, para que
//! todas las guitarras se lean juntas. Solo lo que no se reconoce recorre la
//! paleta en orden. Los grupos son [`TRACK_COLOR_GROUPS`], la misma tabla de la
//! que sale la plantilla de serie «Banda».

use libretracks_core::track_matching::match_stems;
use libretracks_core::{Track, TrackKind};

/// Una familia de instrumentos: su color y los nombres con los que se reconoce.
///
/// Es la tabla que comparten el color por grupo y la plantilla de serie
/// (`song_templates::builtin_band_template`), así que una pista se colorea
/// igual que la carpeta de la plantilla donde caería su stem.
pub(crate) struct TrackColorGroup {
    pub id: &'static str,
    pub name_es: &'static str,
    pub name_en: &'static str,
    /// Lo que la plantilla crea para este grupo: Click y Guía son pistas, el
    /// resto carpetas.
    pub kind: TrackKind,
    pub color: &'static str,
    /// Alias para `track_matching`: palabras enteras; gana el de más palabras
    /// y, a igualdad, el grupo que va antes en la tabla.
    pub aliases: &'static [&'static str],
}

/// Los grupos, en orden de prioridad para los empates de `track_matching`.
///
/// El orden importa: Guía antes que Voces («Voz Guía» es la guía), guitarras
/// antes que Voces («Lead Guitar»), Efectos y Pads antes que Teclados («Synth
/// Pad», «Ambient»), y la eléctrica antes que la acústica para que «Gtr» suelto
/// sea eléctrica. Los colores salen de [`AUTO_TRACK_COLORS`].
pub(crate) const TRACK_COLOR_GROUPS: [TrackColorGroup; 12] = [
    TrackColorGroup {
        id: "click",
        name_es: "Click",
        name_en: "Click",
        kind: TrackKind::Audio,
        color: "#E35D5B", // Rojo
        aliases: &["click", "clic", "metronome", "metronomo", "met", "click track"],
    },
    TrackColorGroup {
        id: "guide",
        name_es: "Guía",
        name_en: "Guide",
        kind: TrackKind::Audio,
        color: "#E35D5B", // Rojo: va con el click
        aliases: &["guide", "guia", "cues", "cue", "voice guide", "voz guia"],
    },
    TrackColorGroup {
        id: "drums",
        name_es: "Batería",
        name_en: "Drums",
        kind: TrackKind::Folder,
        color: "#5C8CE6", // Azul
        aliases: &[
            "drums", "drum", "bateria", "kick", "bombo", "snare", "caja", "hi hat", "hihat",
            "toms", "tom", "overheads", "oh", "room", "cymbals", "platos",
        ],
    },
    TrackColorGroup {
        id: "percussion",
        name_es: "Percusión y loops",
        name_en: "Percussion & loops",
        kind: TrackKind::Folder,
        color: "#4FB8E6", // Celeste
        aliases: &[
            "perc", "percussion", "percusion", "pandero", "pandereta", "tambourine", "shaker",
            "conga", "bongo", "cajon", "woodblock", "wood block", "cowbell", "clap", "claps",
            "triangle", "triangulo", "timbal", "timbales", "guiro", "maracas", "loop", "loops",
            "drum loop", "synth loop",
        ],
    },
    TrackColorGroup {
        id: "bass",
        name_es: "Bajo",
        name_en: "Bass",
        kind: TrackKind::Folder,
        color: "#9C73E6", // Violeta
        aliases: &["bass", "bajo", "sub", "synth bass", "bass synth"],
    },
    TrackColorGroup {
        id: "electric_guitars",
        name_es: "Guitarras eléctricas",
        name_en: "Electric guitars",
        kind: TrackKind::Folder,
        color: "#EE8A3C", // Naranja
        aliases: &[
            "eg", "ge", "gtr", "guitar", "guitarra", "electric", "electrica", "electric guitar",
            "guitarra electrica", "distor", "distorsion", "distortion", "steel", "lap steel",
        ],
    },
    TrackColorGroup {
        id: "acoustic_guitars",
        name_es: "Guitarras acústicas",
        name_en: "Acoustic guitars",
        kind: TrackKind::Folder,
        color: "#E0A83A", // Ámbar
        // `gtr` también aquí para que `AGtr` se lea como a(coustic) + gtr; un
        // «Gtr» suelto empata y se lo queda la eléctrica, que va antes.
        aliases: &[
            "ag", "ga", "gtr", "acoustic", "acustica", "acoustic guitar", "guitarra acustica",
            "nylon",
        ],
    },
    TrackColorGroup {
        id: "fx",
        name_es: "Efectos",
        name_en: "FX",
        kind: TrackKind::Folder,
        color: "#6F6FE0", // Índigo
        aliases: &[
            "fx", "sfx", "efectos", "sweep", "riser", "impact", "noise", "synth fx", "voz fx",
            "vocal fx", "vox fx",
        ],
    },
    TrackColorGroup {
        id: "pads",
        name_es: "Pads",
        name_en: "Pads",
        kind: TrackKind::Folder,
        color: "#2FA98A", // Esmeralda
        aliases: &["pad", "pads", "ambient", "ambient pad", "synth pad", "warm pad"],
    },
    TrackColorGroup {
        id: "strings",
        name_es: "Cuerdas",
        name_en: "Strings",
        kind: TrackKind::Folder,
        color: "#3CDDC7", // Cian
        aliases: &[
            "strings", "cuerdas", "violin", "viola", "cello", "orchestra", "orquesta", "brass",
            "metales", "horns", "sax", "trumpet", "trompeta",
        ],
    },
    TrackColorGroup {
        id: "keys",
        name_es: "Teclados",
        name_en: "Keys",
        kind: TrackKind::Folder,
        color: "#57B66C", // Verde
        aliases: &[
            "keys", "teclas", "teclados", "teclado", "piano", "rhodes", "wurli", "organ",
            "organo", "b3", "electric piano", "acoustic piano", "synth", "synths",
            "sintetizador", "arp",
        ],
    },
    TrackColorGroup {
        id: "vocals",
        name_es: "Voces",
        name_en: "Vocals",
        kind: TrackKind::Folder,
        color: "#DF6FA8", // Rosa
        aliases: &[
            "vox", "voz", "voces", "vocals", "vocal", "bgv", "bgvs", "coro", "coros", "choir",
            "chorus", "lead", "soprano", "alto", "tenor",
        ],
    },
];

/// El grupo al que pertenece una pista por su nombre, si se reconoce.
pub(crate) fn color_group_for_name(name: &str) -> Option<&'static TrackColorGroup> {
    TRACK_COLOR_GROUPS.get(group_rank(name))
}

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

/// Posición del grupo de una pista en [`TRACK_COLOR_GROUPS`]; lo que no se
/// reconoce va detrás de todo.
pub(crate) fn group_rank(name: &str) -> usize {
    let targets: Vec<&[&str]> = TRACK_COLOR_GROUPS.iter().map(|group| group.aliases).collect();
    match_stems(&[name], None, &targets)
        .into_iter()
        .next()
        .flatten()
        .unwrap_or(TRACK_COLOR_GROUPS.len())
}

/// Ordena por grupo un tramo de pistas hermanas sin hijas (las de un lote
/// recién soltado). Estable: dentro del grupo, el orden en que llegaron.
pub(crate) fn sort_track_run_by_group(tracks: &mut [Track]) {
    tracks.sort_by_cached_key(|track| group_rank(&track.name));
}

/// Las pistas de la sesión ordenadas por grupo, nivel a nivel del árbol.
///
/// Cada carpeta se mueve con sus hijas, y dentro de cada nivel:
/// - las pistas de una misma canción (`song_region_id`) siguen juntas y las
///   canciones conservan su orden, para no mezclar el click de una con el de
///   otra;
/// - dentro de cada canción, por grupo; lo no reconocido va al final;
/// - a igualdad, el orden de antes (estable).
pub(crate) fn sort_tracks_by_group(tracks: &[Track]) -> Vec<Track> {
    let ids: std::collections::HashSet<&str> = tracks.iter().map(|t| t.id.as_str()).collect();
    let mut sorted = Vec::with_capacity(tracks.len());
    push_children_sorted(tracks, None, &ids, &mut sorted);
    // Un ciclo de carpetas (no debería existir) no puede tragarse pistas.
    if sorted.len() < tracks.len() {
        let placed: std::collections::HashSet<String> =
            sorted.iter().map(|t| t.id.clone()).collect();
        sorted.extend(tracks.iter().filter(|t| !placed.contains(&t.id)).cloned());
    }
    sorted
}

/// La carpeta de una pista; una hija de una carpeta que no existe cuelga de la
/// raíz, para que nunca se pierda al ordenar.
fn effective_parent<'a>(
    track: &'a Track,
    ids: &std::collections::HashSet<&str>,
) -> Option<&'a str> {
    track
        .parent_track_id
        .as_deref()
        .filter(|id| ids.contains(id) && *id != track.id)
}

fn push_children_sorted(
    tracks: &[Track],
    parent: Option<&str>,
    ids: &std::collections::HashSet<&str>,
    sorted: &mut Vec<Track>,
) {
    let mut children: Vec<&Track> = tracks
        .iter()
        .filter(|t| effective_parent(t, ids) == parent)
        .collect();
    let mut songs: Vec<Option<&str>> = Vec::new();
    for child in &children {
        if !songs.contains(&child.song_region_id.as_deref()) {
            songs.push(child.song_region_id.as_deref());
        }
    }
    children.sort_by_cached_key(|track| {
        let song = songs
            .iter()
            .position(|song| *song == track.song_region_id.as_deref())
            .unwrap_or(0);
        (song, group_rank(&track.name))
    });
    for child in children {
        sorted.push(child.clone());
        push_children_sorted(tracks, Some(child.id.as_str()), ids, sorted);
    }
}

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

/// Color para una pista llamada `name` que se va a crear ahora mismo en
/// `tracks`.
///
/// Si el nombre es de un grupo, el color del grupo; si no, el siguiente de la
/// paleta. Devuelve `None` —es decir, el gris de siempre— cuando el ajuste está
/// apagado o cuando lo que se crea es una carpeta. Nunca repinta nada: sólo
/// decide el color de la pista que aún no existe.
pub(crate) fn auto_color_for_new_track(
    tracks: &[Track],
    kind: TrackKind,
    name: &str,
    enabled: bool,
) -> Option<String> {
    if !enabled || kind == TrackKind::Folder {
        return None;
    }
    let color = color_group_for_name(name)
        .map(|group| group.color)
        .unwrap_or_else(|| auto_track_color_at(colorable_track_count(tracks)));
    Some(color.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str, kind: TrackKind) -> Track {
        Track {
            eq: None,
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
            channel_mode: Default::default(),
            color: None,
            auto_created: false,
            midi_port: None,
            midi_channel: 1,
            midi_enabled: true,
            collapsed: false,
            height_offset: None,
            match_aliases: Vec::new(),
            guide: None,
            song_region_id: None,
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
            let color = auto_color_for_new_track(&tracks, TrackKind::Audio, "Coalo", true)
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
            auto_color_for_new_track(&tracks, TrackKind::Audio, "Coalo", true).as_deref(),
            Some(AUTO_TRACK_COLORS[1]),
        );
        // Y una carpeta nueva no se colorea.
        assert_eq!(
            auto_color_for_new_track(&tracks, TrackKind::Folder, "Coalo", true),
            None
        );
    }

    #[test]
    fn disabled_setting_keeps_the_historical_grey() {
        assert_eq!(
            auto_color_for_new_track(&[], TrackKind::Audio, "Coalo", false),
            None
        );
    }

    #[test]
    fn midi_tracks_take_part_like_audio_ones() {
        let tracks = vec![track("a", TrackKind::Audio)];
        assert_eq!(
            auto_color_for_new_track(&tracks, TrackKind::Midi, "Coalo", true).as_deref(),
            Some(AUTO_TRACK_COLORS[1]),
        );
    }

    fn group_id(name: &str) -> Option<&'static str> {
        color_group_for_name(name).map(|group| group.id)
    }

    /// Los nombres reales de las sesiones de prueba `TestLetras2` y
    /// `TestMultiplesAnalisis`, cada uno con el grupo que le toca.
    #[test]
    fn real_session_track_names_land_in_their_group() {
        let cases: &[(&str, &str)] = &[
            ("Click", "click"),
            ("Clic 138bpm", "click"),
            ("Click Track", "click"),
            ("Click 02", "click"),
            ("Al Estar Ante Ti Click 12 2", "click"),
            ("Guía", "guide"),
            ("Guias", "guide"),
            ("Guide", "guide"),
            ("Guia 01", "guide"),
            ("Cues 1", "guide"),
            ("Al Estar Ante Ti Voz Guia 11 10", "guide"),
            ("Drums", "drums"),
            ("Drums Live", "drums"),
            ("DRUMS_1", "drums"),
            ("Bateria", "drums"),
            ("Perc", "percussion"),
            ("Perc Live", "percussion"),
            ("Al Estar Ante Ti Pandero 1 8", "percussion"),
            ("Loop", "percussion"),
            ("LOOP_1", "percussion"),
            ("Synth Loop", "percussion"),
            ("Bass", "bass"),
            ("BASS_1", "bass"),
            ("Bajo", "bass"),
            ("Al Estar Ante Ti Bajo 3 1", "bass"),
            ("Synth Bass", "bass"),
            ("Eg 1", "electric_guitars"),
            ("Ge 4", "electric_guitars"),
            ("EGTR 1_1", "electric_guitars"),
            ("EGTR_6", "electric_guitars"),
            ("Egtr", "electric_guitars"),
            ("Distorsion 12", "electric_guitars"),
            ("Distor 1 06", "electric_guitars"),
            ("Lap Steel", "electric_guitars"),
            ("Al Estar Ante Ti Guitar Electric 7 5", "electric_guitars"),
            ("Al Estar Ante Ti Guistar Distortion 10 4", "electric_guitars"),
            ("Al Estar Ante Ti Over Guitar 9 7", "electric_guitars"),
            ("Gtr", "electric_guitars"),
            ("Ag", "acoustic_guitars"),
            ("Ag 2", "acoustic_guitars"),
            ("Ga", "acoustic_guitars"),
            ("Acustica", "acoustic_guitars"),
            ("Acustica 1 01", "acoustic_guitars"),
            ("AGtr", "acoustic_guitars"),
            ("Acoustic Guitar", "acoustic_guitars"),
            ("Keys 1", "keys"),
            ("Key", "keys"),
            ("Piano 2", "keys"),
            ("Organ", "keys"),
            ("Al Estar Ante Ti Organo 4 6", "keys"),
            ("Synth 3", "keys"),
            ("Pad", "pads"),
            ("PAD_1", "pads"),
            ("Al Estar Ante Ti Warm Pad 5 11", "pads"),
            ("Synth Pad", "pads"),
            ("Strings", "strings"),
            ("Cuerdas", "strings"),
            ("Bgvs", "vocals"),
            ("Choir 2", "vocals"),
            ("Chorus 04", "vocals"),
            ("Alto", "vocals"),
            ("Tenor", "vocals"),
            ("Fx", "fx"),
            ("Synth Fx", "fx"),
            ("Voz Fx", "fx"),
        ];
        let wrong: Vec<String> = cases
            .iter()
            .filter(|(name, expected)| group_id(name) != Some(*expected))
            .map(|(name, expected)| format!("{name}: {:?} (esperado {expected})", group_id(name)))
            .collect();
        assert!(wrong.is_empty(), "mal clasificadas:\n{}", wrong.join("\n"));
    }

    #[test]
    fn unknown_names_and_word_fragments_stay_out() {
        assert_eq!(group_id("Coalo 01"), None);
        assert_eq!(group_id("Audio 3"), None);
        // `ag` y `ge` solo como palabra entera.
        assert_eq!(group_id("Stage"), None);
    }

    #[test]
    fn a_recognised_name_takes_its_group_color_not_the_rotation() {
        let tracks = vec![track("a", TrackKind::Audio), track("b", TrackKind::Audio)];
        assert_eq!(
            auto_color_for_new_track(&tracks, TrackKind::Audio, "EG 2", true).as_deref(),
            Some("#EE8A3C"),
        );
        // El ajuste apagado manda también sobre el grupo.
        assert_eq!(auto_color_for_new_track(&tracks, TrackKind::Audio, "EG 2", false), None);
    }

    #[test]
    fn group_colors_come_from_the_palette() {
        for group in &TRACK_COLOR_GROUPS {
            assert!(
                AUTO_TRACK_COLORS.contains(&group.color),
                "{} usa {} fuera de la paleta",
                group.id,
                group.color
            );
        }
    }

    fn names(tracks: &[Track]) -> Vec<&str> {
        tracks.iter().map(|t| t.name.as_str()).collect()
    }

    fn named(id: &str, name: &str, parent: Option<&str>, song: Option<&str>) -> Track {
        let mut t = track(id, if id.starts_with("dir") { TrackKind::Folder } else { TrackKind::Audio });
        t.name = name.into();
        t.parent_track_id = parent.map(str::to_string);
        t.song_region_id = song.map(str::to_string);
        t
    }

    #[test]
    fn a_dropped_batch_is_sorted_by_group_keeping_arrival_order_inside_each() {
        // El orden alfabético de los ficheros de «Al Estar Ante Ti».
        let mut tracks: Vec<Track> = [
            "Bajo 3", "Click 12", "Drums 6", "Guistar Distortion 10", "Guitar Electric 7",
            "Organo 4", "Over Guitar 9", "Pandero 1", "Piano 2", "Voz Guia 11", "Warm Pad 5",
            "Woodblock 8", "Coalo",
        ]
        .iter()
        .enumerate()
        .map(|(i, name)| named(&format!("t{i}"), name, None, None))
        .collect();
        sort_track_run_by_group(&mut tracks);
        assert_eq!(
            names(&tracks),
            [
                "Click 12", "Voz Guia 11", "Drums 6", "Pandero 1", "Woodblock 8", "Bajo 3",
                "Guistar Distortion 10", "Guitar Electric 7", "Over Guitar 9", "Warm Pad 5",
                "Organo 4", "Piano 2", "Coalo",
            ]
        );
    }

    #[test]
    fn sorting_the_session_keeps_folders_whole_and_songs_apart() {
        let tracks = vec![
            named("a_eg", "EG 1", None, Some("song_a")),
            named("a_click", "Click", None, Some("song_a")),
            named("b_bass", "Bass", None, Some("song_b")),
            named("a_ag", "AG", None, Some("song_a")),
            named("b_click", "Click", None, Some("song_b")),
            named("dir_keys", "Teclados", None, None),
            named("k_pad", "Pad", Some("dir_keys"), None),
            named("k_piano", "Piano", Some("dir_keys"), None),
            named("k_click", "Click alt", Some("dir_keys"), None),
            named("x", "Coalo", None, None),
            named("dir_drums", "Batería", None, None),
        ];
        let sorted = sort_tracks_by_group(&tracks);
        assert_eq!(
            sorted.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            [
                // Canción A junta y en su sitio, ordenada por grupo.
                "a_click", "a_eg", "a_ag",
                // Luego la B (la eléctrica de A no se va con la de B).
                "b_click", "b_bass",
                // Las compartidas: la carpeta de batería antes que la de
                // teclados, que se lleva a sus hijas ordenadas.
                "dir_drums", "dir_keys", "k_click", "k_pad", "k_piano",
                // Lo que no se reconoce, al final.
                "x",
            ]
        );
    }

    #[test]
    fn sorting_never_loses_a_track_with_a_missing_parent() {
        let tracks = vec![
            named("a", "Piano", Some("gone"), None),
            named("b", "Click", None, None),
        ];
        let sorted = sort_tracks_by_group(&tracks);
        assert_eq!(names(&sorted), ["Click", "Piano"]);
    }
}
