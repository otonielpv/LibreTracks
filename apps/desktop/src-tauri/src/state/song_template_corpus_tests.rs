//! Plantillas de canción contra un setlist real: los nombres de stems de las
//! 10 canciones de la sesión de pruebas `TestMultiplesAnalisis`, tal cual
//! vienen en disco (`EGTR_6`, `COALO_01`, `Drums (Live)`, `Lap Steel`…).
//!
//! Cada combinación de modo de pistas × plantilla × punta de entrada mete las
//! 10 canciones en una sesión y comprueba las invariantes: cada stem tiene su
//! clip, las carpetas se llaman como su canción, colores y routing heredados,
//! nada se solapa, una sola entrada de deshacer por acción, y lo mismo tras
//! guardar y reabrir.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use libretracks_core::{Song, Track, TrackKind};
use libretracks_project::{
    export_region_as_package, load_song_from_file, save_song_to_file, SongImportTrackMode,
    SONG_FILE_NAME,
};
use tempfile::tempdir;

use super::build_empty_song;
use super::song_templates::BUILTIN_BAND_TEMPLATE;
use super::tests::{session_with_song_dir, write_silent_test_wav};
use super::{CreateAudioTrackWithClipRequest, CreateClipWithAutoTrackRequest, DesktopSession};
use crate::audio::engine::AudioController;

/// (canción, stems). Los nombres de canción llevan sus acentos y signos reales.
const SETLIST: [(&str, &[&str]); 10] = [
    (
        "DIGNO ES EL SEÑOR MARCELA GANDARA",
        &["Acustica.mp3", "Bass.mp3", "Click.mp3", "Drums.mp3", "Egtr.mp3", "Guide.mp3", "Key.mp3", "Pad.mp3", "loop.mp3"],
    ),
    (
        "ERES TODOPODEROSO ROJO",
        &["BASS_1.mp3", "DRUMS_1.mp3", "EGTR 1_1.mp3", "EGTR_6.mp3", "EGTR_7.mp3", "EGTR_8.mp3", "EGTR_9.mp3", "LOOP_1.mp3", "PAD_1.mp3", "click.mp3", "guia.mp3"],
    ),
    (
        "FIESTA EN EL DESIERTO MONTESANTO",
        &["AG.mp3", "BGVS.mp3", "Bass.mp3", "Choir 2.mp3", "Choir.mp3", "Click Track.mp3", "Drums (Live).mp3", "EG 1.mp3", "EG 2.mp3", "EG 3.mp3", "EG 4.mp3", "EG 5.mp3", "Guide.mp3", "Keys 1.mp3", "Keys 2.mp3", "Keys 3.mp3", "Perc.mp3", "Piano.mp3", "Synth Bass.mp3"],
    ),
    (
        "Goodness of God",
        &["AG 2.wav", "AG.wav", "BGVS.wav", "Bass.wav", "Click Track.wav", "Drums.wav", "EG 1.wav", "EG 2.wav", "EG 3.wav", "Guide.wav", "Keys 1.wav", "Lap Steel.wav", "Organ.wav", "Perc.wav", "Piano.wav"],
    ),
    (
        "POEMA DE SALVACION",
        &["ACUSTICA 1_01.wav", "ACUSTICA 2_01.wav", "CHORUS_04.wav", "CLICK_02.wav", "COALO_01.wav", "DISTOR 1_06.wav", "DISTORSION_12.wav", "GUIA_01.wav", "LOOP_01.wav", "PAD_01.wav"],
    ),
    (
        "QUIERO CONOCER A JESUS + NUESTRO DIOS G12",
        &["AG.mp3", "BGVS.mp3", "Bass.mp3", "Choir.mp3", "Click Track.mp3", "Drums (Live).mp3", "EG 1.mp3", "Guide.mp3", "Keys 1.mp3", "Keys 2.mp3", "Piano.mp3", "Synth Bass.mp3"],
    ),
    (
        "Rey de Reyes - Marco Barrientos",
        &["Alto.wav", "Bass.wav", "Click Track.wav", "Drums.wav", "EG 1.wav", "EG 2.wav", "EG 3.wav", "FX.wav", "Guide.wav", "Key 1.wav", "Key 2.wav", "Loop.wav", "Piano.wav", "Tenor.wav"],
    ),
    (
        "Es Él-Felipe S. Santos Bb 70 Bpm",
        &["Bass.wav", "Click Track.wav", "Drums.wav", "EG 1.wav", "EG 2.wav", "EG 3.wav", "EG 4.wav", "Guide.wav", "Keys 1.wav", "Keys 2.wav", "Keys 3.wav", "Keys 4.wav", "Keys 5.wav", "Perc.wav", "Piano.wav", "Strings.wav", "Synth 1.wav", "Synth Bass.wav", "Synth FX.wav", "Synth Loop.wav", "Voz FX.wav"],
    ),
    (
        "Digno - Yvonne 65 Bpm E - A",
        &["BGVS.mp3", "Bass.mp3", "Click Track.mp3", "Drums.mp3", "EG 1.mp3", "EG 2.mp3", "EG 3.mp3", "Guide.mp3", "Keys 1.mp3", "Perc.mp3", "Piano.mp3"],
    ),
    (
        "Digno de Adorar-MSM-D-71bpm",
        &["AG.wav", "BGVS.wav", "Bass.wav", "Choir 2.wav", "Choir.wav", "Click Track.wav", "Drums.wav", "EG 1.wav", "EG 2.wav", "EG 3.wav", "FX.wav", "Guide.wav", "Keys 1.wav", "Keys 2.wav", "Perc.wav", "Piano.wav"],
    ),
];

const STEM_SECONDS: u32 = 1;
/// Hueco entre canciones al colocarlas en la línea de tiempo.
const SONG_PITCH: f64 = 10.0;

/// Lo que un técnico de sonido esperaría para cada stem con la plantilla de
/// serie (español). `None` = no hay grupo razonable. Varios = vale cualquiera.
fn expected_builtin_group(stem: &str) -> &'static [&'static str] {
    let s = stem.to_lowercase();
    let s = s.rsplit_once('.').map(|(name, _)| name).unwrap_or(&s);
    match s {
        s if s.starts_with("click") => &["Click"],
        s if s.starts_with("guide") || s.starts_with("guia") || s.starts_with("cues") => &["Guía"],
        s if s.starts_with("drums") || s.starts_with("perc") || s.starts_with("loop") => &["Batería"],
        s if s.starts_with("bass") || s == "synth bass" => &["Bajo"],
        s if s.starts_with("acustica")
            || s.starts_with("egtr")
            || s.starts_with("eg ")
            || s.starts_with("ag")
            || s.starts_with("distor")
            || s == "lap steel" =>
        {
            &["Guitarras"]
        }
        s if s.starts_with("key") || s == "piano" || s == "organ" => &["Teclados"],
        s if s.starts_with("pad") || s == "strings" || s == "synth 1" || s == "synth loop" => {
            &["Synth y pads"]
        }
        "synth fx" => &["Synth y pads", "Efectos"],
        "voz fx" => &["Voces", "Efectos"],
        s if s.starts_with("bgvs")
            || s.starts_with("choir")
            || s.starts_with("chorus")
            || s == "alto"
            || s == "tenor" =>
        {
            &["Voces"]
        }
        "fx" => &["Efectos"],
        _ => &[],
    }
}

/// Borra al salir (también si el test entra en pánico) las carpetas que
/// `session_with_song_dir` deja en el temporal: cada vuelta de la matriz son
/// cientos de WAVs y sin esto llenan el disco.
struct TempCleanup(Vec<std::path::PathBuf>);

impl TempCleanup {
    fn session(&mut self, session: &DesktopSession) {
        if let Some(root) = session.song_dir.as_ref().and_then(|dir| dir.parent()) {
            self.0.push(root.to_path_buf());
        }
    }
}

impl Drop for TempCleanup {
    fn drop(&mut self) {
        for dir in &self.0 {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Template {
    None,
    Builtin,
    Custom,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Entry {
    /// Soltar los archivos en el timeline DAW (biblioteca o explorador del SO,
    /// los dos acaban en `create_audio_tracks_with_clips`) y renombrar después
    /// la canción, que nace como «Canción N».
    DawFiles,
    /// Soltar una carpeta de la biblioteca en el DAW (`libraryFolderDrop`).
    DawLibraryFolder,
    /// «+ Nueva canción» en compacta/Setlist y soltar los stems en su columna
    /// (biblioteca o explorador: `create_clips_with_auto_tracks`).
    NewSongThenColumnDrop,
    /// Lo mismo, pero los stems de uno en uno (arrastres sucesivos).
    NewSongThenOneByOne,
    /// Importar un `.ltpkg` de cada canción.
    Ltpkg,
}

fn layout_name(layout: SongImportTrackMode) -> &'static str {
    match layout {
        SongImportTrackMode::MergeIntoExisting => "shared",
        SongImportTrackMode::SongFolder => "songFolder",
        SongImportTrackMode::KeepSeparate => "separate",
    }
}

fn audio_with(template: Option<&str>, layout: SongImportTrackMode) -> AudioController {
    let audio = AudioController::default();
    let mut settings = audio.current_settings().expect("settings");
    settings.default_song_template = template.map(str::to_string);
    settings.song_track_layout = Some(layout_name(layout).to_string());
    settings.locale = Some("es".into());
    audio.replace_settings(settings).expect("replace settings");
    audio
}

fn track(id: &str, name: &str, kind: TrackKind, parent: Option<&str>, color: &str, audio_to: &str, aliases: &[&str]) -> Track {
    Track {
        id: id.into(),
        name: name.into(),
        kind,
        parent_track_id: parent.map(str::to_string),
        volume: 1.0,
        pan: 0.0,
        muted: false,
        solo: false,
        transpose_enabled: true,
        audio_to: audio_to.into(),
        mono_downmix: false,
        color: Some(color.into()),
        auto_created: false,
        midi_port: None,
        midi_channel: 1,
        midi_enabled: true,
        collapsed: false,
        height_offset: None,
        match_aliases: aliases.iter().map(|a| a.to_string()).collect(),
        song_region_id: None,
    }
}

/// Una plantilla de usuario: Click y Guía a los cascos (`ext:2-3`), carpetas
/// anidadas (Ritmo > Batería), un destino que es pista (Bajo) y alias propios
/// para lo que la de serie no conoce.
fn custom_template_tracks() -> Vec<Track> {
    vec![
        track("t_click", "Click", TrackKind::Audio, None, "#101010", "ext:2-3", &["click"]),
        track("t_guide", "Guía", TrackKind::Audio, None, "#202020", "ext:2-3", &["guide", "guia", "cues"]),
        track("t_rhythm", "Ritmo", TrackKind::Folder, None, "#AA0000", "master", &[]),
        track("t_drums", "Batería", TrackKind::Folder, Some("t_rhythm"), "#BB0000", "inherit", &["drums", "perc", "loop"]),
        track("t_bass", "Bajo", TrackKind::Audio, Some("t_rhythm"), "#CC0000", "inherit", &["bass", "synth bass"]),
        track("t_gtr", "Guitarras", TrackKind::Folder, None, "#00AA00", "master", &["eg", "ag", "egtr", "acustica", "distor", "distorsion", "lap steel"]),
        track("t_keys", "Teclados", TrackKind::Folder, None, "#0000AA", "master", &["keys", "key", "piano", "organ", "synth", "pad", "strings"]),
        track("t_vox", "Voces", TrackKind::Folder, None, "#AA00AA", "master", &["bgvs", "choir", "alto", "tenor", "chorus", "voz"]),
    ]
}

fn write_custom_template(dir: &Path) -> String {
    let mut song = build_empty_song("tpl".into(), "Mi banda".into());
    song.tracks = custom_template_tracks();
    let path = dir.join("Mi banda.lttemplate");
    save_song_to_file(&path, &song).expect("save template");
    path.to_string_lossy().to_string()
}

fn wav_name(stem: &str) -> String {
    let base = stem.rsplit_once('.').map(|(name, _)| name).unwrap_or(stem);
    format!("{base}.wav")
}

/// Escribe los stems de una canción bajo `audio/<canción>/` y devuelve las rutas
/// relativas en el orden del setlist.
fn write_song_stems(session: &DesktopSession, song: &str, stems: &[&str]) -> Vec<String> {
    let song_dir = session.song_dir.clone().expect("song dir");
    stems
        .iter()
        .map(|stem| {
            let file = wav_name(stem);
            write_silent_test_wav(&song_dir.join("audio").join(song).join(&file), STEM_SECONDS);
            format!("audio/{song}/{file}")
        })
        .collect()
}

/// El nombre que pone `humanizeLibraryTrackName` en el frontend.
fn humanize(file_path: &str) -> String {
    let name = file_path.rsplit('/').next().unwrap_or(file_path);
    let base = name.rsplit_once('.').map(|(n, _)| n).unwrap_or(name);
    base.split(|c: char| !c.is_alphanumeric())
        .filter(|p| !p.is_empty())
        .map(|p| {
            let mut chars = p.chars();
            let first = chars.next().unwrap().to_uppercase().collect::<String>();
            first + &chars.as_str().to_lowercase()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn loaded(session: &DesktopSession) -> Song {
    session.engine.song().cloned().expect("song loaded")
}

fn next_start(session: &DesktopSession) -> f64 {
    loaded(session)
        .regions
        .iter()
        .map(|r| r.end_seconds)
        .fold(0.0, f64::max)
        .max(0.0)
        + if loaded(session).regions.is_empty() { 0.0 } else { SONG_PITCH }
}

/// Mete una canción por la punta de entrada `entry`. Devuelve cuántas entradas
/// de deshacer se esperan de más (para comprobar el historial).
fn add_song(
    session: &mut DesktopSession,
    audio: &AudioController,
    entry: Entry,
    song_name: &str,
    files: &[String],
    package: Option<&Path>,
    problems: &mut Vec<String>,
) {
    let tag = format!("[{song_name}]");
    let start = next_start(session);
    let region_at = |session: &DesktopSession, t: f64| {
        loaded(session)
            .regions
            .iter()
            .find(|r| t >= r.start_seconds - 1e-6 && t < r.end_seconds)
            .cloned()
    };
    match entry {
        Entry::DawFiles => {
            let depth = session.undo_stack.len();
            let requests: Vec<_> = files
                .iter()
                .map(|f| CreateAudioTrackWithClipRequest {
                    track_name: humanize(f),
                    file_path: f.clone(),
                    timeline_start_seconds: start,
                })
                .collect();
            session.create_audio_tracks_with_clips(&requests, audio).expect("daw drop");
            if session.undo_stack.len() != depth + 1 {
                problems.push(format!("{tag} DAW drop pushed {} undo steps", session.undo_stack.len() - depth));
            }
            let region = region_at(session, start).expect("drop created a song");
            session
                .update_song_region(&region.id, song_name, region.start_seconds, region.end_seconds, audio)
                .expect("rename");
        }
        Entry::DawLibraryFolder => {
            let requests: Vec<_> = files
                .iter()
                .map(|f| CreateAudioTrackWithClipRequest {
                    track_name: humanize(f),
                    file_path: f.clone(),
                    timeline_start_seconds: start,
                })
                .collect();
            session.create_audio_tracks_with_clips(&requests, audio).expect("folder drop");
            session
                .create_song_region(start, start + STEM_SECONDS as f64, audio)
                .expect("wrap folder in a song");
            let region = region_at(session, start).expect("folder song");
            session
                .update_song_region(&region.id, song_name, region.start_seconds, region.end_seconds, audio)
                .expect("name after folder");
        }
        Entry::NewSongThenColumnDrop | Entry::NewSongThenOneByOne => {
            session.create_empty_song(Some(song_name), None, audio).expect("new song");
            let region = loaded(session)
                .regions
                .iter()
                .find(|r| r.name == song_name)
                .cloned()
                .expect("new song exists");
            let requests: Vec<_> = files
                .iter()
                .map(|f| CreateClipWithAutoTrackRequest {
                    file_path: f.clone(),
                    timeline_start_seconds: region.start_seconds,
                })
                .collect();
            if entry == Entry::NewSongThenColumnDrop {
                let depth = session.undo_stack.len();
                session.create_clips_with_auto_tracks(&requests, audio).expect("column drop");
                if session.undo_stack.len() != depth + 1 {
                    problems.push(format!("{tag} column drop pushed {} undo steps", session.undo_stack.len() - depth));
                }
            } else {
                for request in requests {
                    session
                        .create_clips_with_auto_tracks(std::slice::from_ref(&request), audio)
                        .expect("single drop");
                }
            }
        }
        Entry::Ltpkg => {
            let layout = audio.current_settings().unwrap().track_layout();
            session
                .import_song_package(&package.unwrap().to_string_lossy(), start, audio, layout)
                .expect("import ltpkg");
        }
    }
}

/// El grupo de la plantilla donde cayó una pista: ella misma o su antepasado
/// más cercano con nombre de grupo, o la pista destino de la que es hermana.
fn group_of(song: &Song, track_id: &str, groups: &HashMap<String, String>) -> Option<String> {
    let by_id: HashMap<&str, &Track> = song.tracks.iter().map(|t| (t.id.as_str(), t)).collect();
    let start = by_id.get(track_id)?;
    let mut current = Some(*start);
    while let Some(t) = current {
        if let Some(group) = groups.get(&t.name) {
            if t.kind == TrackKind::Folder || t.id == start.id {
                return Some(group.clone());
            }
        }
        current = t.parent_track_id.as_deref().and_then(|p| by_id.get(p).copied());
    }
    // Hermana de un destino pista: mismo padre y mismo color que él.
    song.tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Audio && groups.contains_key(&t.name) && !t.match_aliases.is_empty())
        .find(|t| t.parent_track_id == start.parent_track_id && t.color == start.color && t.audio_to == start.audio_to)
        .map(|t| groups[&t.name].clone())
}

struct Outcome {
    problems: Vec<String>,
    placement: BTreeMap<String, Option<String>>,
    tracks: usize,
}

fn run(layout: SongImportTrackMode, template: Template, entry: Entry) -> Outcome {
    let label = format!("{}/{:?}/{:?}", layout_name(layout), template, entry);
    let mut problems: Vec<String> = Vec::new();
    let tpl_dir = tempdir().expect("tpl dir");
    let template_ref = match template {
        Template::None => None,
        Template::Builtin => Some(BUILTIN_BAND_TEMPLATE.to_string()),
        Template::Custom => Some(write_custom_template(tpl_dir.path())),
    };
    let audio = audio_with(template_ref.as_deref(), layout);
    let mut cleanup = TempCleanup(Vec::new());
    let mut session = session_with_song_dir(
        &format!("corpus-{}-{:?}-{:?}", layout_name(layout), template, entry),
        build_empty_song("song_1".into(), "Set".into()),
    );
    cleanup.session(&session);

    // Paquetes: cada canción exportada desde una sesión sin plantilla con una
    // pista por stem (como la sesión real del usuario).
    let packages: Vec<_> = if entry == Entry::Ltpkg {
        let source_audio = audio_with(None, SongImportTrackMode::KeepSeparate);
        let mut source = session_with_song_dir(
            &format!("corpus-src-{label}").replace('/', "-"),
            build_empty_song("src".into(), "Src".into()),
        );
        cleanup.session(&source);
        let out = tempdir().expect("pkg dir").keep();
        cleanup.0.push(out.clone());
        SETLIST
            .iter()
            .map(|(name, stems)| {
                let files = write_song_stems(&source, name, stems);
                let mut ignore = Vec::new();
                add_song(&mut source, &source_audio, Entry::DawFiles, name, &files, None, &mut ignore);
                let song = loaded(&source);
                let region = song.regions.iter().find(|r| r.name == *name).unwrap().clone();
                let path = out.join(format!("{}.ltpkg", region.id));
                export_region_as_package(
                    &out.join("cache"),
                    source.song_dir.as_ref().unwrap(),
                    &song,
                    &region.id,
                    &path,
                    true,
                )
                .expect("export ltpkg");
                path
            })
            .collect()
    } else {
        Vec::new()
    };

    let mut file_of_stem: Vec<(String, String, String)> = Vec::new(); // (song, stem, path)
    for (index, (name, stems)) in SETLIST.iter().enumerate() {
        let files = write_song_stems(&session, name, stems);
        for (stem, file) in stems.iter().zip(&files) {
            file_of_stem.push((name.to_string(), stem.to_string(), file.clone()));
        }
        add_song(&mut session, &audio, entry, name, &files, packages.get(index).map(|p| p.as_path()), &mut problems);
    }

    let song = loaded(&session);
    check_invariants(&label, &song, layout, template, entry, &file_of_stem, &mut problems);

    // Guardar y reabrir: lo mismo debe seguir siendo cierto.
    session.save_project().expect("save");
    let song_file = session.song_dir.as_ref().unwrap().join(SONG_FILE_NAME);
    let reopened = load_song_from_file(&song_file).expect("reopen");
    if reopened.tracks != song.tracks {
        let diffs: Vec<String> = song
            .tracks
            .iter()
            .zip(&reopened.tracks)
            .filter(|(a, b)| a != b)
            .take(2)
            .map(|(a, b)| format!("{a:?}
    vs {b:?}"))
            .collect();
        problems.push(format!(
            "{label}: tracks differ after save + reopen ({} vs {}): {diffs:?}",
            song.tracks.len(),
            reopened.tracks.len()
        ));
    }

    // Dónde cayó cada stem (solo para el informe).
    let groups: HashMap<String, String> = match template {
        Template::Builtin => super::song_templates::builtin_band_template(Some("es"))
            .into_iter()
            .map(|t| (t.name.clone(), t.name))
            .collect(),
        Template::Custom => custom_template_tracks().into_iter().map(|t| (t.name.clone(), t.name)).collect(),
        Template::None => HashMap::new(),
    };
    let mut placement = BTreeMap::new();
    for (song_name, stem, file) in &file_of_stem {
        let clip_track = song
            .clips
            .iter()
            .find(|c| c.file_path.replace('\\', "/").ends_with(file.trim_start_matches("audio/")))
            .map(|c| c.track_id.clone());
        let group = clip_track.and_then(|id| group_of(&song, &id, &groups));
        placement.insert(format!("{song_name} :: {stem}"), group);
    }

    // Borrar una canción en los modos por canción se lleva sus pistas vacías.
    if layout != SongImportTrackMode::MergeIntoExisting {
        let victim = song.regions[3].clone();
        let mut after = song.clone();
        after.clips.retain(|c| !(c.timeline_start_seconds >= victim.start_seconds && c.timeline_start_seconds < victim.end_seconds));
        // Las pistas de esa canción deben desaparecer con ella.
        let owned: usize = song.tracks.iter().filter(|t| t.song_region_id.as_deref() == Some(&victim.id)).count();
        let before = song.tracks.len();
        session.delete_song_region(&victim.id, &audio).expect("delete song");
        let after_delete = loaded(&session);
        if after_delete.tracks.iter().any(|t| t.song_region_id.as_deref() == Some(&victim.id)) {
            problems.push(format!("{label}: deleting '{}' left {} of its tracks behind", victim.name,
                after_delete.tracks.iter().filter(|t| t.song_region_id.as_deref() == Some(&victim.id)).count()));
        }
        if before - after_delete.tracks.len() != owned {
            problems.push(format!("{label}: deleting '{}' removed {} tracks, owned {owned}", victim.name, before - after_delete.tracks.len()));
        }
        session.undo_action(&audio).expect("undo delete");
        if loaded(&session).tracks != song.tracks {
            problems.push(format!("{label}: undoing the song deletion does not restore its tracks"));
        }
    }

    Outcome { problems, placement, tracks: song.tracks.len() }
}

fn check_invariants(
    label: &str,
    song: &Song,
    layout: SongImportTrackMode,
    template: Template,
    entry: Entry,
    stems: &[(String, String, String)],
    problems: &mut Vec<String>,
) {
    let by_id: HashMap<&str, &Track> = song.tracks.iter().map(|t| (t.id.as_str(), t)).collect();
    let root_of = |t: &Track| {
        let mut current = t;
        while let Some(parent) = current.parent_track_id.as_deref().and_then(|p| by_id.get(p)) {
            current = parent;
        }
        current.id.clone()
    };

    // Las canciones están todas y con su nombre.
    let names: Vec<&str> = song.regions.iter().map(|r| r.name.as_str()).collect();
    for (name, _) in SETLIST {
        if !names.contains(&name) {
            problems.push(format!("{label}: song '{name}' missing (regions: {names:?})"));
        }
    }
    if song.regions.len() != SETLIST.len() {
        problems.push(format!("{label}: {} songs, expected {}", song.regions.len(), SETLIST.len()));
    }

    // Cada stem tiene exactamente un clip, en una pista de audio, dentro de su canción.
    for (song_name, stem, file) in stems {
        let tail = file.trim_start_matches("audio/");
        let clips: Vec<_> = song.clips.iter().filter(|c| c.file_path.replace('\\', "/").ends_with(tail)).collect();
        if clips.len() != 1 {
            problems.push(format!("{label}: {song_name}::{stem} has {} clips", clips.len()));
            continue;
        }
        let clip = clips[0];
        let Some(track) = by_id.get(clip.track_id.as_str()) else {
            problems.push(format!("{label}: {song_name}::{stem} clip on a missing track"));
            continue;
        };
        if track.kind != TrackKind::Audio {
            problems.push(format!("{label}: {song_name}::{stem} on a {:?} track", track.kind));
        }
        let region = song
            .regions
            .iter()
            .find(|r| clip.timeline_start_seconds >= r.start_seconds - 1e-6 && clip.timeline_start_seconds < r.end_seconds);
        let Some(region) = region else {
            problems.push(format!("{label}: {song_name}::{stem} clip outside every song"));
            continue;
        };
        if region.name != *song_name {
            problems.push(format!("{label}: {song_name}::{stem} landed in song '{}'", region.name));
        }
        if layout != SongImportTrackMode::MergeIntoExisting {
            if track.song_region_id.as_deref() != Some(region.id.as_str()) {
                problems.push(format!(
                    "{label}: {song_name}::{stem} on track '{}' owned by {:?}, not its song",
                    track.name, track.song_region_id
                ));
            }
            // Ningún antepasado puede ser de otra canción.
            let mut current = *track;
            while let Some(parent) = current.parent_track_id.as_deref().and_then(|p| by_id.get(p)) {
                if parent.song_region_id.as_deref() != Some(region.id.as_str()) {
                    problems.push(format!("{label}: {song_name}::{stem} under '{}' owned by {:?}", parent.name, parent.song_region_id));
                    break;
                }
                current = parent;
            }
        }
        if layout == SongImportTrackMode::SongFolder {
            let root = by_id[root_of(track).as_str()];
            if root.kind != TrackKind::Folder || root.name != *song_name || root.song_region_id.as_deref() != Some(region.id.as_str()) {
                problems.push(format!(
                    "{label}: {song_name}::{stem} root is '{}' ({:?}), not the song folder",
                    root.name, root.kind
                ));
            }
        }
        if layout == SongImportTrackMode::MergeIntoExisting && track.song_region_id.is_some() {
            problems.push(format!("{label}: {song_name}::{stem} track '{}' tagged with a song in shared mode", track.name));
        }
    }

    // Carpeta por canción: exactamente una carpeta por canción, con su nombre.
    if layout == SongImportTrackMode::SongFolder {
        for region in &song.regions {
            let folders: Vec<_> = song
                .tracks
                .iter()
                .filter(|t| t.kind == TrackKind::Folder && t.parent_track_id.is_none() && t.song_region_id.as_deref() == Some(region.id.as_str()))
                .collect();
            if folders.len() != 1 || folders[0].name != region.name {
                problems.push(format!(
                    "{label}: song '{}' has folders {:?}",
                    region.name,
                    folders.iter().map(|f| &f.name).collect::<Vec<_>>()
                ));
            }
        }
        let roots_not_folders: Vec<_> = song.tracks.iter().filter(|t| t.parent_track_id.is_none() && t.song_region_id.is_none()).map(|t| &t.name).collect();
        if !roots_not_folders.is_empty() {
            problems.push(format!("{label}: root tracks outside any song folder: {roots_not_folders:?}"));
        }
    }

    // Una pista no tiene dos clips solapados.
    let mut per_track: HashMap<&str, Vec<(f64, f64)>> = HashMap::new();
    for clip in &song.clips {
        per_track.entry(&clip.track_id).or_default().push((clip.timeline_start_seconds, clip.timeline_start_seconds + clip.duration_seconds));
    }
    for (track_id, mut spans) in per_track {
        spans.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        if spans.windows(2).any(|w| w[1].0 < w[0].1 - 1e-6) {
            problems.push(format!("{label}: overlapping clips on track '{}'", by_id[track_id].name));
        }
    }

    // Copias de la plantilla: una por canción (o una en total si se comparte).
    if template != Template::None && entry != Entry::Ltpkg {
        let marker = "Guitarras";
        let copies = song.tracks.iter().filter(|t| t.kind == TrackKind::Folder && t.name == marker).count();
        let expected = if layout == SongImportTrackMode::MergeIntoExisting { 1 } else { SETLIST.len() };
        if copies != expected {
            problems.push(format!("{label}: {copies} copies of '{marker}', expected {expected}"));
        }
    }

    // Colores y routing.
    let template_tracks: Vec<Track> = match template {
        Template::Builtin => super::song_templates::builtin_band_template(Some("es")),
        Template::Custom => custom_template_tracks(),
        Template::None => Vec::new(),
    };
    let tpl_by_name: HashMap<&str, &Track> = template_tracks.iter().map(|t| (t.name.as_str(), t)).collect();
    for t in &song.tracks {
        // Las pistas copiadas de la plantilla conservan color, tipo y alias.
        if let Some(tpl) = tpl_by_name.get(t.name.as_str()) {
            if t.kind == tpl.kind && t.match_aliases.is_empty() == false {
                if t.color != tpl.color {
                    problems.push(format!("{label}: template track '{}' color {:?} != {:?}", t.name, t.color, tpl.color));
                }
                let parent_is_song_folder = t
                    .parent_track_id
                    .as_deref()
                    .and_then(|p| by_id.get(p))
                    .is_some_and(|p| p.match_aliases.is_empty() && p.song_region_id.is_some() && p.parent_track_id.is_none() && !tpl_by_name.contains_key(p.name.as_str()));
                let expected_to = if parent_is_song_folder && tpl.audio_to.eq_ignore_ascii_case("master") {
                    "inherit"
                } else {
                    tpl.audio_to.as_str()
                };
                if t.audio_to != expected_to {
                    problems.push(format!("{label}: template track '{}' routed to '{}', expected '{expected_to}'", t.name, t.audio_to));
                }
            }
        }
        // Una hija de una carpeta de plantilla hereda su color y suma por ella.
        if let Some(parent) = t.parent_track_id.as_deref().and_then(|p| by_id.get(p)) {
            if tpl_by_name.contains_key(parent.name.as_str()) && parent.kind == TrackKind::Folder && !parent.match_aliases.is_empty() && t.match_aliases.is_empty() {
                if t.color != parent.color {
                    problems.push(format!("{label}: '{}' in '{}' has color {:?}, folder {:?}", t.name, parent.name, t.color, parent.color));
                }
                if t.audio_to != "inherit" {
                    problems.push(format!("{label}: '{}' in '{}' routed to '{}'", t.name, parent.name, t.audio_to));
                }
            }
            // Dentro de la carpeta de la canción, lo que iba al master suma por ella.
            if parent.parent_track_id.is_none() && parent.song_region_id.is_some() && layout == SongImportTrackMode::SongFolder && t.audio_to == "master" {
                problems.push(format!("{label}: '{}' inside song folder '{}' bypasses it (master)", t.name, parent.name));
            }
        }
    }
}

fn report(outcomes: &[(String, Outcome)]) -> usize {
    let mut total = 0;
    for (label, outcome) in outcomes {
        println!("\n=== {label}: {} tracks, {} problems", outcome.tracks, outcome.problems.len());
        for problem in outcome.problems.iter().take(25) {
            println!("  - {problem}");
        }
        if outcome.problems.len() > 25 {
            println!("  … {} more", outcome.problems.len() - 25);
        }
        total += outcome.problems.len();
    }
    total
}

#[test]
#[ignore = "corpus real: cargo test ... corpus -- --ignored --nocapture"]
fn real_setlist_every_layout_template_and_entry_point() {
    let layouts = [SongImportTrackMode::MergeIntoExisting, SongImportTrackMode::SongFolder, SongImportTrackMode::KeepSeparate];
    let templates = [Template::Builtin, Template::Custom, Template::None];
    let entries = [Entry::DawFiles, Entry::DawLibraryFolder, Entry::NewSongThenColumnDrop, Entry::NewSongThenOneByOne, Entry::Ltpkg];
    let mut outcomes = Vec::new();
    let mut builtin_placement: Option<BTreeMap<String, Option<String>>> = None;
    for layout in layouts {
        for template in templates {
            for entry in entries {
                let label = format!("{}/{:?}/{:?}", layout_name(layout), template, entry);
                let outcome = std::panic::catch_unwind(|| run(layout, template, entry));
                match outcome {
                    Ok(outcome) => {
                        if template == Template::Builtin && entry == Entry::DawFiles && layout == SongImportTrackMode::SongFolder {
                            builtin_placement = Some(outcome.placement.clone());
                        }
                        outcomes.push((label, outcome));
                    }
                    Err(panic) => {
                        let message = panic
                            .downcast_ref::<String>()
                            .cloned()
                            .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                            .unwrap_or_default();
                        outcomes.push((label, Outcome { problems: vec![format!("PANIC: {message}")], placement: BTreeMap::new(), tracks: 0 }));
                    }
                }
            }
        }
    }

    if let Some(placement) = builtin_placement {
        println!("\n=== Plantilla de serie: dónde cae cada stem (✗ = no es lo esperado)");
        let mut misses = 0;
        for (stem, group) in &placement {
            let file = stem.split(" :: ").nth(1).unwrap();
            let expected = expected_builtin_group(file);
            let ok = match group {
                Some(g) => expected.contains(&g.as_str()),
                None => expected.is_empty(),
            };
            if !ok {
                misses += 1;
            }
            println!("  {} {stem:<70} → {:<14} (esperado {:?})", if ok { "✓" } else { "✗" }, group.as_deref().unwrap_or("—"), expected);
        }
        println!("  {misses} de {} stems fuera de lo esperado", placement.len());
    }

    let total = report(&outcomes);
    assert_eq!(total, 0, "{total} problems across the matrix (see output)");
}

fn tree(song: &Song) -> Vec<String> {
    fn walk(song: &Song, parent: Option<&str>, depth: usize, out: &mut Vec<String>) {
        for t in song.tracks.iter().filter(|t| t.parent_track_id.as_deref() == parent) {
            let clips = song.clips.iter().filter(|c| c.track_id == t.id).count();
            out.push(format!(
                "{}{} [{:?}{}] to={} color={:?} aliases={} clips={clips}",
                "  ".repeat(depth),
                t.name,
                t.kind,
                if t.song_region_id.is_some() { ", song" } else { "" },
                t.audio_to,
                t.color,
                t.match_aliases.len()
            ));
            walk(song, Some(&t.id), depth + 1, out);
        }
    }
    let mut out = Vec::new();
    walk(song, None, 0, &mut out);
    out
}

fn drop_daw(session: &mut DesktopSession, audio: &AudioController, index: usize) {
    let (name, stems) = SETLIST[index];
    let files = write_song_stems(session, name, stems);
    let mut problems = Vec::new();
    add_song(session, audio, Entry::DawFiles, name, &files, None, &mut problems);
    assert!(problems.is_empty(), "{problems:?}");
}

#[test]
#[ignore = "corpus real"]
fn scenario_real_session_tracks_shared_builtin() {
    let real = r"C:\Users\otoni\Desktop\TestsLibreTracks\TestMultiplesAnalisis\TestMultiplesAnalisis.ltsession";
    let Ok(mut real) = load_song_from_file(real) else { return };
    real.clips.clear();
    real.regions.clear();
    real.section_markers.clear();
    real.tempo_markers.clear();
    real.duration_seconds = 60.0;
    let before = real.tracks.len();
    let mut cleanup = TempCleanup(Vec::new());
    let mut session = session_with_song_dir("corpus-real-shared", real);
    cleanup.session(&session);
    let audio = audio_with(Some(BUILTIN_BAND_TEMPLATE), SongImportTrackMode::MergeIntoExisting);
    drop_daw(&mut session, &audio, 3);
    drop_daw(&mut session, &audio, 7);
    let song = loaded(&session);
    println!("tracks before {before}, after {}", song.tracks.len());
    for line in tree(&song).iter().filter(|l| !l.ends_with("aliases=0 clips=0")) {
        println!("{line}");
    }
}

#[test]
#[ignore = "corpus real"]
fn scenario_save_song_folder_session_as_template() {
    let mut cleanup = TempCleanup(Vec::new());
    let mut session = session_with_song_dir("corpus-save-tpl", build_empty_song("s".into(), "Set".into()));
    cleanup.session(&session);
    let audio = audio_with(Some(BUILTIN_BAND_TEMPLATE), SongImportTrackMode::SongFolder);
    drop_daw(&mut session, &audio, 0);
    let tpl = session.song_dir.as_ref().unwrap().parent().unwrap().join("Desde sesion.lttemplate");
    session.save_current_as_template(tpl.clone()).expect("save as template");
    let audio = audio_with(Some(&tpl.to_string_lossy()), SongImportTrackMode::SongFolder);
    drop_daw(&mut session, &audio, 3);
    let song = loaded(&session);
    println!("--- after second song with the saved template:");
    for line in tree(&song) {
        println!("{line}");
    }
}

#[test]
#[ignore = "corpus real"]
fn scenario_explicit_template_then_drop() {
    for layout in [SongImportTrackMode::MergeIntoExisting, SongImportTrackMode::SongFolder, SongImportTrackMode::KeepSeparate] {
        let mut cleanup = TempCleanup(Vec::new());
        let mut session = session_with_song_dir(&format!("corpus-explicit-{}", layout_name(layout)), build_empty_song("s".into(), "Set".into()));
        cleanup.session(&session);
        let custom = write_custom_template(session.song_dir.as_ref().unwrap().parent().unwrap());
        let audio = audio_with(Some(BUILTIN_BAND_TEMPLATE), layout);
        let (name, stems) = SETLIST[3];
        session.create_empty_song(Some(name), Some(&custom), &audio).expect("new song from custom");
        let after_create = loaded(&session).tracks.len();
        let files = write_song_stems(&session, name, stems);
        let start = loaded(&session).regions[0].start_seconds;
        let requests: Vec<_> = files
            .iter()
            .map(|f| CreateClipWithAutoTrackRequest { file_path: f.clone(), timeline_start_seconds: start })
            .collect();
        session.create_clips_with_auto_tracks(&requests, &audio).expect("drop");
        let song = loaded(&session);
        println!("\n--- {}: {after_create} tracks after create, {} after drop", layout_name(layout), song.tracks.len());
        for line in tree(&song) {
            println!("{line}");
        }
    }
}

/// Los stems de verdad de `D:\`, por ruta absoluta, como llegan al soltar desde
/// el explorador (se importan por referencia, sin copiar).
fn real_stems(song: &str) -> Vec<String> {
    let root = Path::new(r"D:\Iglesia\Megafonia - Alabanza\MultiTracks");
    let dir = [root.join(song), root.join(song).join("MultiTracks"), root.join(song).join("Media")]
        .into_iter()
        .find(|dir| {
            std::fs::read_dir(dir).is_ok_and(|mut entries| {
                entries.any(|e| e.is_ok_and(|e| e.path().extension().is_some_and(|x| x == "wav" || x == "mp3")))
            })
        });
    let Some(dir) = dir else { return Vec::new() };
    let mut files: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("wav") || x.eq_ignore_ascii_case("mp3")))
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    files.sort();
    files
}

#[test]
#[ignore = "corpus real: lee los multitracks de D:"]
fn scenario_real_files_from_disk() {
    for layout in [SongImportTrackMode::SongFolder, SongImportTrackMode::MergeIntoExisting] {
        let mut cleanup = TempCleanup(Vec::new());
        let mut session = session_with_song_dir(&format!("corpus-real-files-{}", layout_name(layout)), build_empty_song("s".into(), "Set".into()));
        cleanup.session(&session);
        let audio = audio_with(Some(BUILTIN_BAND_TEMPLATE), layout);
        for song in ["DIGNO ES EL SEÑOR MARCELA GANDARA", "POEMA DE SALVACION", "Es Él-Felipe S. Santos Bb 70 Bpm"] {
            let files = real_stems(song);
            if files.is_empty() {
                println!("!! no files found for {song} (accent in folder name?)");
                continue;
            }
            session.create_empty_song(Some(song), None, &audio).expect("new song");
            let start = loaded(&session).regions.iter().find(|r| r.name == song).unwrap().start_seconds;
            let requests: Vec<_> = files
                .iter()
                .map(|f| CreateClipWithAutoTrackRequest { file_path: f.clone(), timeline_start_seconds: start })
                .collect();
            let started = std::time::Instant::now();
            match session.create_clips_with_auto_tracks(&requests, &audio) {
                Ok(_) => println!("{song}: {} stems in {:?}, summary {:?}", files.len(), started.elapsed(), session.last_template_drop),
                Err(error) => println!("!! {song}: {error}"),
            }
        }
        let song = loaded(&session);
        println!("--- {}", layout_name(layout));
        for line in tree(&song) {
            println!("{line}");
        }
    }
}

#[test]
#[ignore = "corpus real"]
fn scenario_fill_a_setlist_created_first() {
    for template in [None, Some(BUILTIN_BAND_TEMPLATE)] {
        let mut cleanup = TempCleanup(Vec::new());
        let mut session = session_with_song_dir("corpus-setlist-first", build_empty_song("s".into(), "Set".into()));
        cleanup.session(&session);
        let audio = audio_with(template, SongImportTrackMode::SongFolder);
        for (name, _) in &SETLIST[..3] {
            session.create_empty_song(Some(name), None, &audio).expect("new song");
        }
        for (name, _) in &SETLIST[..3] {
            let files = real_stems(name);
            let start = loaded(&session).regions.iter().find(|r| r.name == *name).unwrap().start_seconds;
            let requests: Vec<_> = files
                .iter()
                .map(|f| CreateClipWithAutoTrackRequest { file_path: f.clone(), timeline_start_seconds: start })
                .collect();
            match session.create_clips_with_auto_tracks(&requests, &audio) {
                Ok(_) => println!("{template:?} {name}: ok"),
                Err(error) => println!("{template:?} {name}: ERROR {}", error.to_string().replace('\n', " ")),
            }
        }
    }
}
