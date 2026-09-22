//! Qué audio de la sesión no está, quién lo usa, y dónde podría estar.
//!
//! LibreTracks **referencia** el audio original en vez de copiarlo (escritorio
//! e iOS hoy; Android con el paso 07). Referenciar tiene un coste conocido: el
//! usuario mueve, renombra o borra el original y se entera en mitad de un
//! directo. Ableton, que es la referencia de producto de este proyecto,
//! referencia por defecto **y** trae un gestor de ficheros que faltan. Una cosa
//! no va sin la otra.
//!
//! Este módulo es el inventario. Deliberadamente **no repara nada**: quien
//! vuelve a enlazar es `DesktopSession::resolve_missing_file`, y siempre
//! porque el usuario lo ha pedido. La búsqueda automática **propone**, nunca
//! enlaza sola — un fichero con el mismo nombre no es necesariamente el mismo
//! fichero, y enlazar el equivocado en silencio es peor que no encontrarlo.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use libretracks_core::Song;
use serde::Serialize;

use super::resolve_audio_file_path;

/// Un fichero de audio que la sesión referencia y que no está en disco.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissingMediaEntry {
    /// La ruta tal y como la guarda la sesión: relativa a la carpeta de la
    /// sesión, o absoluta si referencia un original de fuera. Es la clave con
    /// la que `resolve_missing_file` vuelve a enlazar.
    pub file_path: String,
    /// Dónde se esperaba encontrarlo, ya resuelto. Es lo que el usuario
    /// necesita leer para entender qué ha pasado.
    pub expected_path: String,
    pub file_name: String,
    /// Las pistas que lo usan, sin repetir y en orden alfabético. Sin esto la
    /// pantalla dice «falta bateria.wav» y el usuario no sabe qué se va a
    /// quedar mudo.
    pub track_names: Vec<String>,
    /// Cuántos clips lo usan (puede haber varios en la misma pista).
    pub clip_count: usize,
    /// Ficheros con el mismo nombre encontrados en carpetas conocidas.
    /// Propuestas: la interfaz pide confirmación antes de enlazar ninguna.
    pub candidates: Vec<String>,
}

/// Carpetas donde tiene sentido buscar un fichero que falta.
///
/// Dos fuentes, y ninguna necesita estado nuevo que persistir:
///
/// 1. **La carpeta de audio de la sesión**, que es donde vive todo lo que se
///    importó copiando.
/// 2. **La carpeta de los stems hermanos que SÍ están.** Si el usuario importó
///    veinte pistas de una carpeta y luego movió una, las otras diecinueve
///    siguen apuntando a esa carpeta: es la «última carpeta de import» sin
///    tener que recordarla en ningún sitio, y sobrevive a reinstalar.
pub fn known_search_dirs(song_dir: &Path, song: &Song) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec![song_dir.join("audio")];
    for clip in &song.clips {
        let resolved = resolve_audio_file_path(song_dir, &clip.file_path);
        // Sólo los que están: la carpeta de uno que falta no nos dice nada.
        if !resolved.is_file() {
            continue;
        }
        if let Some(parent) = resolved.parent() {
            let parent = parent.to_path_buf();
            if !dirs.contains(&parent) {
                dirs.push(parent);
            }
        }
    }
    dirs
}

/// Ficheros llamados `file_name` dentro de `dirs`, sin recursión.
///
/// Sin recursión a propósito: un barrido recursivo desde la carpeta de música
/// del usuario puede tardar minutos, y esto corre al abrir la sesión. Si no
/// está al lado de sus hermanos, el usuario lo busca a mano.
///
/// La comparación de nombre **ignora mayúsculas**: hay precedente en el repo
/// de sistemas de ficheros que las pliegan, y un candidato de más no hace
/// daño porque hay que confirmarlo.
pub fn find_candidates(file_name: &str, dirs: &[PathBuf]) -> Vec<String> {
    if file_name.is_empty() {
        return Vec::new();
    }
    let wanted = file_name.to_lowercase();
    let mut found: BTreeSet<String> = BTreeSet::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let matches = path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.to_lowercase() == wanted);
            if matches {
                found.insert(path.to_string_lossy().into_owned());
            }
        }
    }
    found.into_iter().collect()
}

/// El inventario completo: qué falta, quién lo usa y qué candidatos hay.
///
/// Devuelve la lista vacía cuando no falta nada, que es el caso normal. **No
/// bloquea nada ni falla**: una sesión con ficheros que faltan se abre igual y
/// suena lo que pueda sonar — un músico que abre una sesión cinco minutos
/// antes de tocar necesita eso, no una pregunta.
pub fn collect_missing_media(song_dir: &Path, song: &Song) -> Vec<MissingMediaEntry> {
    // Agrupado por ruta: un mismo fichero usado por seis clips es UNA entrada
    // que hay que reparar una vez, no seis filas idénticas.
    let mut by_path: BTreeMap<String, (usize, BTreeSet<String>)> = BTreeMap::new();
    for clip in &song.clips {
        if resolve_audio_file_path(song_dir, &clip.file_path).is_file() {
            continue;
        }
        let track_name = song
            .tracks
            .iter()
            .find(|track| track.id == clip.track_id)
            .map(|track| track.name.clone())
            .unwrap_or_default();
        let entry = by_path
            .entry(clip.file_path.clone())
            .or_insert_with(|| (0, BTreeSet::new()));
        entry.0 += 1;
        if !track_name.is_empty() {
            entry.1.insert(track_name);
        }
    }

    if by_path.is_empty() {
        return Vec::new();
    }

    // Las carpetas se calculan UNA vez para todo el lote: la lista es la misma
    // para cada fichero y recorrerla por entrada multiplicaría el coste de
    // disco por el número de ficheros que faltan.
    let dirs = known_search_dirs(song_dir, song);

    by_path
        .into_iter()
        .map(|(file_path, (clip_count, track_names))| {
            let expected = resolve_audio_file_path(song_dir, &file_path);
            let file_name = expected
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&file_path)
                .to_string();
            MissingMediaEntry {
                candidates: find_candidates(&file_name, &dirs),
                expected_path: expected.to_string_lossy().into_owned(),
                file_name,
                file_path,
                track_names: track_names.into_iter().collect(),
                clip_count,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::{Clip, Track, TrackKind};
    use std::fs;
    use tempfile::tempdir;

    fn track(id: &str, name: &str) -> Track {
        Track {
            id: id.to_string(),
            name: name.to_string(),
            kind: TrackKind::Audio,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: true,
            audio_to: "master".to_string(),
            mono_downmix: false,
            color: None,
            auto_created: false,
            midi_port: None,
            midi_channel: 1,
            midi_enabled: true,
            collapsed: false,
            height_offset: None,
        }
    }

    fn clip(id: &str, track_id: &str, file_path: &str) -> Clip {
        Clip {
            id: id.to_string(),
            track_id: track_id.to_string(),
            file_path: file_path.to_string(),
            timeline_start_seconds: 0.0,
            source_start_seconds: 0.0,
            duration_seconds: 1.0,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            color: None,
        }
    }

    fn song_with(tracks: Vec<Track>, clips: Vec<Clip>) -> Song {
        Song {
            id: "s".into(),
            title: "Sesion".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 12.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![],
            tracks,
            clips,
            midi_clips: vec![],
            section_markers: vec![],
        }
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("mkdir");
        }
        fs::write(path, b"RIFF").expect("write");
    }

    #[test]
    fn a_session_with_everything_in_place_reports_nothing() {
        let dir = tempdir().expect("tempdir");
        let song_dir = dir.path();
        touch(&song_dir.join("audio").join("bateria.wav"));

        let song = song_with(
            vec![track("t1", "Bateria")],
            vec![clip("c1", "t1", "audio/bateria.wav")],
        );

        assert!(collect_missing_media(song_dir, &song).is_empty());
    }

    #[test]
    fn a_relative_file_that_is_gone_is_reported_with_the_tracks_that_use_it() {
        let dir = tempdir().expect("tempdir");
        let song_dir = dir.path();
        fs::create_dir_all(song_dir.join("audio")).expect("mkdir");

        let song = song_with(
            vec![track("t1", "Bateria"), track("t2", "Coros")],
            vec![
                clip("c1", "t1", "audio/bateria.wav"),
                clip("c2", "t1", "audio/bateria.wav"),
                clip("c3", "t2", "audio/bateria.wav"),
            ],
        );

        let missing = collect_missing_media(song_dir, &song);
        assert_eq!(missing.len(), 1, "un fichero, una entrada, no una por clip");
        assert_eq!(missing[0].file_name, "bateria.wav");
        assert_eq!(missing[0].clip_count, 3);
        assert_eq!(missing[0].track_names, vec!["Bateria", "Coros"]);
        // La ruta esperada es absoluta y cuelga de la sesion. No se compara el
        // separador: la ruta guardada trae "/" y `join` no lo reescribe en
        // Windows, asi que sale "C:\...udio/bateria.wav" y da igual.
        assert!(missing[0].expected_path.ends_with("bateria.wav"));
        assert!(missing[0]
            .expected_path
            .starts_with(&song_dir.to_string_lossy().into_owned()));
    }

    #[test]
    fn an_absolute_file_that_is_gone_is_reported_too() {
        let dir = tempdir().expect("tempdir");
        let song_dir = dir.path();
        let outside = dir.path().join("fuera").join("voz.wav");

        let song = song_with(
            vec![track("t1", "Voz")],
            vec![clip("c1", "t1", &outside.to_string_lossy())],
        );

        let missing = collect_missing_media(song_dir, &song);
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].file_name, "voz.wav");
        assert_eq!(missing[0].file_path, outside.to_string_lossy());
    }

    #[test]
    fn an_absolute_file_that_is_there_is_not_reported() {
        let dir = tempdir().expect("tempdir");
        let song_dir = dir.path();
        let outside = dir.path().join("fuera").join("voz.wav");
        touch(&outside);

        let song = song_with(
            vec![track("t1", "Voz")],
            vec![clip("c1", "t1", &outside.to_string_lossy())],
        );

        assert!(collect_missing_media(song_dir, &song).is_empty());
    }

    /// El caso que hace útil la búsqueda automática: el usuario movió la
    /// carpeta entera, y los hermanos que sí están dicen a dónde.
    #[test]
    fn a_sibling_that_is_still_there_points_at_the_folder_the_rest_moved_to() {
        let dir = tempdir().expect("tempdir");
        let song_dir = dir.path().join("sesion");
        fs::create_dir_all(song_dir.join("audio")).expect("mkdir");
        let nueva = dir.path().join("Multitracks").join("Domingo");
        touch(&nueva.join("bajo.wav"));
        touch(&nueva.join("bateria.wav"));

        let song = song_with(
            vec![track("t1", "Bajo"), track("t2", "Bateria")],
            vec![
                // Éste sí está, y su carpeta es la pista para encontrar el otro.
                clip("c1", "t1", &nueva.join("bajo.wav").to_string_lossy()),
                // Éste apunta al sitio viejo.
                clip("c2", "t2", "audio/bateria.wav"),
            ],
        );

        let missing = collect_missing_media(&song_dir, &song);
        assert_eq!(missing.len(), 1);
        assert_eq!(
            missing[0].candidates,
            vec![nueva.join("bateria.wav").to_string_lossy().into_owned()],
            "el hermano que sigue en su sitio tiene que delatar la carpeta nueva"
        );
    }

    #[test]
    fn no_candidate_when_nothing_with_that_name_is_anywhere_known() {
        let dir = tempdir().expect("tempdir");
        let song_dir = dir.path();
        fs::create_dir_all(song_dir.join("audio")).expect("mkdir");

        let song = song_with(
            vec![track("t1", "Bateria")],
            vec![clip("c1", "t1", "audio/bateria.wav")],
        );

        let missing = collect_missing_media(song_dir, &song);
        assert_eq!(missing.len(), 1);
        assert!(
            missing[0].candidates.is_empty(),
            "proponer algo que no existe seria peor que no proponer nada"
        );
    }

    #[test]
    fn candidate_matching_folds_case_but_stays_in_the_folder() {
        let dir = tempdir().expect("tempdir");
        let hermana = dir.path().join("stems");
        touch(&hermana.join("VOZ.WAV"));
        // Una subcarpeta NO se mira: un barrido recursivo desde la carpeta de
        // musica del usuario tarda minutos y esto corre al abrir la sesion.
        touch(&hermana.join("mas_abajo").join("otra.wav"));

        assert_eq!(
            find_candidates("voz.wav", &[hermana.clone()]),
            vec![hermana.join("VOZ.WAV").to_string_lossy().into_owned()]
        );
        assert!(find_candidates("otra.wav", &[hermana]).is_empty());
    }

    #[test]
    fn a_directory_that_does_not_exist_is_skipped_not_an_error() {
        let dir = tempdir().expect("tempdir");
        assert!(find_candidates("voz.wav", &[dir.path().join("no-existe")]).is_empty());
    }
}
