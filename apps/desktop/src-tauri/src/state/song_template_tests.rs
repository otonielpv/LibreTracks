//! Plantillas de canción de punta a punta sobre `DesktopSession`: ajustes
//! reales en el `AudioController`, WAVs en disco y el historial de deshacer.
//! La lógica fina (matching, modos, hermanas) está probada en
//! `song_templates.rs`; aquí se prueba que los caminos de la app la usan, y
//! sobre todo que **sin plantilla nada cambia**.

use libretracks_core::{Song, TrackKind};

use super::build_empty_song;
use super::song_templates::{TemplateDropSummary, BUILTIN_BAND_TEMPLATE, NO_TEMPLATE};
use super::tests::{session_with_song_dir, write_silent_test_wav};
use super::{CreateAudioTrackWithClipRequest, CreateClipWithAutoTrackRequest, DesktopSession};
use crate::audio::engine::AudioController;

const MULTITRACK: [&str; 5] = [
    "Way Maker - Click.wav",
    "Way Maker - EG 1.wav",
    "Way Maker - EG 2.wav",
    "Way Maker - Keys.wav",
    "Way Maker - Banjo.wav",
];

fn audio_with(template: Option<&str>, layout: Option<&str>) -> AudioController {
    let audio = AudioController::default();
    let mut settings = audio.current_settings().expect("settings");
    settings.default_song_template = template.map(str::to_string);
    settings.song_track_layout = layout.map(str::to_string);
    settings.locale = Some("es".into());
    audio.replace_settings(settings).expect("replace settings");
    audio
}

fn empty_session(name: &str) -> DesktopSession {
    session_with_song_dir(name, build_empty_song("song_1".into(), "Set".into()))
}

fn write_stems(session: &DesktopSession, files: &[&str]) -> Vec<String> {
    let song_dir = session.song_dir.clone().expect("song dir");
    files
        .iter()
        .map(|file| {
            write_silent_test_wav(&song_dir.join("audio").join(file), 4);
            format!("audio/{file}")
        })
        .collect()
}

fn loaded(session: &DesktopSession) -> Song {
    session.engine.song().cloned().expect("song loaded")
}

fn track_name_of_clip(song: &Song, file: &str) -> String {
    let clip = song
        .clips
        .iter()
        .find(|clip| clip.file_path.ends_with(file))
        .unwrap_or_else(|| panic!("no clip for {file}"));
    song.tracks
        .iter()
        .find(|track| track.id == clip.track_id)
        .expect("clip track")
        .name
        .clone()
}

fn parent_name_of_clip(song: &Song, file: &str) -> Option<String> {
    let clip = song
        .clips
        .iter()
        .find(|clip| clip.file_path.ends_with(file))?;
    let track = song.tracks.iter().find(|track| track.id == clip.track_id)?;
    let parent = track.parent_track_id.as_ref()?;
    song.tracks
        .iter()
        .find(|track| &track.id == parent)
        .map(|track| track.name.clone())
}

#[test]
fn new_song_without_a_template_comes_out_empty_as_always() {
    let mut session = empty_session("tpl-new-song-none");
    let audio = audio_with(None, None);
    session
        .create_empty_song(None, None, &audio)
        .expect("create song");
    let song = loaded(&session);
    assert_eq!(song.regions.len(), 1);
    assert!(song.tracks.is_empty());
}

#[test]
fn new_song_is_laid_out_from_the_default_template() {
    let mut session = empty_session("tpl-new-song-default");
    let audio = audio_with(Some(BUILTIN_BAND_TEMPLATE), None);
    session
        .create_empty_song(None, None, &audio)
        .expect("first song");
    let after_first = loaded(&session).tracks.len();
    assert_eq!(after_first, 9, "the band template's nine targets");
    assert!(loaded(&session).tracks.iter().any(|t| t.name == "Batería"));

    // Shared (the default layout): the second song adds nothing.
    session
        .create_empty_song(None, None, &audio)
        .expect("second song");
    assert_eq!(loaded(&session).tracks.len(), after_first);
}

#[test]
fn an_explicit_template_wins_over_having_none_by_default() {
    let mut session = empty_session("tpl-new-song-explicit");
    let audio = audio_with(None, Some("songFolder"));
    session
        .create_empty_song(Some("Way Maker"), Some(BUILTIN_BAND_TEMPLATE), &audio)
        .expect("create song");
    let song = loaded(&session);
    let folder = &song.tracks[0];
    assert_eq!(folder.kind, TrackKind::Folder);
    assert_eq!(folder.name, "Way Maker");
    assert_eq!(folder.song_region_id.as_ref(), Some(&song.regions[0].id));
}

#[test]
fn an_explicit_none_skips_the_default_template() {
    let mut session = empty_session("tpl-explicit-none");
    let audio = audio_with(Some(BUILTIN_BAND_TEMPLATE), None);
    session
        .create_empty_song(None, Some(NO_TEMPLATE), &audio)
        .expect("create song");
    assert!(loaded(&session).tracks.is_empty());
}

#[test]
fn a_missing_default_template_file_counts_as_no_template() {
    let mut session = empty_session("tpl-missing-file");
    let audio = audio_with(Some("C:/no/such/template.lttemplate"), None);
    session
        .create_empty_song(None, None, &audio)
        .expect("create song");
    assert!(loaded(&session).tracks.is_empty());
}

#[test]
fn compact_drop_without_a_template_keeps_one_auto_track_per_file() {
    let mut session = empty_session("tpl-drop-none");
    let audio = audio_with(None, None);
    let files = write_stems(&session, &MULTITRACK);
    let requests: Vec<_> = files
        .iter()
        .map(|file_path| CreateClipWithAutoTrackRequest {
            file_path: file_path.clone(),
            timeline_start_seconds: 0.0,
        })
        .collect();
    session
        .create_clips_with_auto_tracks(&requests, &audio)
        .expect("drop");
    let song = loaded(&session);
    assert_eq!(song.tracks.len(), MULTITRACK.len());
    assert!(song
        .tracks
        .iter()
        .all(|t| t.auto_created && t.parent_track_id.is_none()));
    assert_eq!(
        track_name_of_clip(&song, "Way Maker - Click.wav"),
        "Way Maker - Click"
    );
    assert_eq!(
        session.last_template_drop, None,
        "nothing organised, no toast"
    );
}

#[test]
fn compact_drop_with_a_template_organises_the_stems_in_one_undo_step() {
    let mut session = empty_session("tpl-drop-shared");
    let audio = audio_with(Some(BUILTIN_BAND_TEMPLATE), None);
    let files = write_stems(&session, &MULTITRACK);
    let requests: Vec<_> = files
        .iter()
        .map(|file_path| CreateClipWithAutoTrackRequest {
            file_path: file_path.clone(),
            timeline_start_seconds: 0.0,
        })
        .collect();
    let undo_depth = session.undo_stack.len();
    session
        .create_clips_with_auto_tracks(&requests, &audio)
        .expect("drop");

    let song = loaded(&session);
    assert_eq!(track_name_of_clip(&song, "Click.wav"), "Click");
    assert_eq!(track_name_of_clip(&song, "EG 1.wav"), "EG 1");
    assert_eq!(
        parent_name_of_clip(&song, "EG 1.wav").as_deref(),
        Some("Guitarras")
    );
    assert_eq!(
        parent_name_of_clip(&song, "EG 2.wav").as_deref(),
        Some("Guitarras")
    );
    assert_eq!(
        parent_name_of_clip(&song, "Keys.wav").as_deref(),
        Some("Teclados")
    );
    // The banjo has no place: it gets its auto track at the root, as always.
    assert_eq!(track_name_of_clip(&song, "Banjo.wav"), "Way Maker - Banjo");
    assert_eq!(parent_name_of_clip(&song, "Banjo.wav"), None);
    assert_eq!(
        session.last_template_drop,
        Some(TemplateDropSummary {
            matched: 4,
            unmatched: 1
        })
    );

    // One step back undoes the whole drop, template tracks included.
    assert_eq!(session.undo_stack.len(), undo_depth + 1);
    session.undo_action(&audio).expect("undo");
    let undone = loaded(&session);
    assert!(undone.clips.is_empty());
    assert!(undone.tracks.is_empty());
}

#[test]
fn timeline_drop_without_a_template_still_respects_song_folder_layout() {
    let mut session = empty_session("tpl-drop-folder-no-template");
    let audio = audio_with(None, Some("songFolder"));
    let files = write_stems(&session, &MULTITRACK);
    let requests: Vec<_> = files
        .iter()
        .map(|file_path| CreateAudioTrackWithClipRequest {
            track_name: file_path
                .trim_start_matches("audio/")
                .trim_end_matches(".wav")
                .into(),
            file_path: file_path.clone(),
            timeline_start_seconds: 0.0,
        })
        .collect();
    let undo_depth = session.undo_stack.len();
    session
        .create_audio_tracks_with_clips(&requests, &audio)
        .expect("drop");
    let song = loaded(&session);
    let region = &song.regions[0];
    assert_eq!(
        song_folder_of(&song, &region.id).as_deref(),
        Some(region.name.as_str())
    );
    for file in MULTITRACK {
        assert_eq!(
            parent_name_of_clip(&song, file).as_deref(),
            Some(region.name.as_str())
        );
    }
    assert_eq!(session.last_template_drop, None);
    assert_eq!(session.undo_stack.len(), undo_depth + 1);
    session.undo_action(&audio).expect("undo drop");
    assert!(loaded(&session).tracks.is_empty());
    assert!(loaded(&session).clips.is_empty());
}

#[test]
fn compact_drops_without_a_template_reuse_the_song_folder() {
    let mut session = empty_session("tpl-compact-folder-no-template");
    let audio = audio_with(None, Some("songFolder"));
    let files = write_stems(&session, &MULTITRACK);
    for file_path in &files {
        session
            .create_clips_with_auto_tracks(
                &[CreateClipWithAutoTrackRequest {
                    file_path: file_path.clone(),
                    timeline_start_seconds: 0.0,
                }],
                &audio,
            )
            .expect("drop into song");
    }
    let song = loaded(&session);
    assert_eq!(song.tracks.len(), MULTITRACK.len() + 1);
    let region = &song.regions[0];
    for file in MULTITRACK {
        assert_eq!(
            parent_name_of_clip(&song, file).as_deref(),
            Some(region.name.as_str())
        );
    }
    session
        .create_empty_song(Some("Second song"), None, &audio)
        .expect("create second song");
    let song = loaded(&session);
    let second = song.regions.last().expect("second song");
    assert_eq!(
        song_folder_of(&song, &second.id).as_deref(),
        Some("Second song")
    );
    session
        .create_clips_with_auto_tracks(
            &[CreateClipWithAutoTrackRequest {
                file_path: files[0].clone(),
                timeline_start_seconds: second.start_seconds,
            }],
            &audio,
        )
        .expect("drop into second song");
    let song = loaded(&session);
    let last_clip = song.clips.last().expect("second song clip");
    let track = song
        .tracks
        .iter()
        .find(|track| track.id == last_clip.track_id)
        .expect("second song track");
    assert_eq!(track.song_region_id.as_deref(), Some(second.id.as_str()));
    assert_eq!(song.tracks.len(), MULTITRACK.len() + 3);
}

#[test]
fn timeline_drop_in_song_folder_mode_keeps_each_song_together() {
    let mut session = empty_session("tpl-drop-folder");
    let audio = audio_with(Some(BUILTIN_BAND_TEMPLATE), Some("songFolder"));
    let files = write_stems(&session, &MULTITRACK);
    let requests: Vec<_> = files
        .iter()
        .map(|file_path| CreateAudioTrackWithClipRequest {
            track_name: file_path
                .trim_start_matches("audio/")
                .trim_end_matches(".wav")
                .into(),
            file_path: file_path.clone(),
            timeline_start_seconds: 0.0,
        })
        .collect();
    session
        .create_audio_tracks_with_clips(&requests, &audio)
        .expect("drop");

    let song = loaded(&session);
    let region = &song.regions[0];
    let folder = song
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Folder && t.parent_track_id.is_none())
        .expect("song folder");
    assert_eq!(folder.name, region.name);
    // Every track lives inside the song and belongs to it — the unmatched
    // banjo too, which is a persistent track because it came from the DAW.
    assert!(song
        .tracks
        .iter()
        .all(|t| t.song_region_id.as_ref() == Some(&region.id)));
    assert_eq!(
        parent_name_of_clip(&song, "Banjo.wav").as_deref(),
        Some(region.name.as_str())
    );
    let banjo_track = song
        .tracks
        .iter()
        .find(|t| t.name == "Way Maker - Banjo")
        .expect("banjo track");
    assert!(!banjo_track.auto_created);
    assert_eq!(banjo_track.audio_to, "inherit");
}

fn song_folder_of(song: &Song, region_id: &str) -> Option<String> {
    song.tracks
        .iter()
        .find(|t| {
            t.kind == TrackKind::Folder
                && t.parent_track_id.is_none()
                && t.song_region_id.as_deref() == Some(region_id)
        })
        .map(|t| t.name.clone())
}

#[test]
fn renaming_a_song_renames_its_folder() {
    let mut session = empty_session("tpl-rename-folder");
    let audio = audio_with(Some(BUILTIN_BAND_TEMPLATE), Some("songFolder"));
    session
        .create_empty_song(Some("Way Maker"), None, &audio)
        .expect("create song");
    let region = loaded(&session).regions[0].clone();
    session
        .update_song_region(
            &region.id,
            "Way Maker (live)",
            region.start_seconds,
            region.end_seconds,
            &audio,
        )
        .expect("rename");
    assert_eq!(
        song_folder_of(&loaded(&session), &region.id).as_deref(),
        Some("Way Maker (live)")
    );
}

#[test]
fn a_folder_renamed_by_hand_keeps_its_name() {
    let mut session = empty_session("tpl-rename-folder-by-hand");
    let audio = audio_with(Some(BUILTIN_BAND_TEMPLATE), Some("songFolder"));
    session
        .create_empty_song(Some("Way Maker"), None, &audio)
        .expect("create song");
    let song = loaded(&session);
    let region = song.regions[0].clone();
    let folder_id = song
        .tracks
        .iter()
        .find(|t| t.song_region_id.as_deref() == Some(&region.id) && t.parent_track_id.is_none())
        .expect("song folder")
        .id
        .clone();
    session
        .update_track(&folder_id, Some("Opener"), None, None, None, None, None, &audio)
        .expect("rename folder");
    session
        .update_song_region(
            &region.id,
            "Way Maker (live)",
            region.start_seconds,
            region.end_seconds,
            &audio,
        )
        .expect("rename song");
    assert_eq!(
        song_folder_of(&loaded(&session), &region.id).as_deref(),
        Some("Opener")
    );
}

#[test]
fn deleting_a_song_takes_its_empty_tracks_in_one_undo_step() {
    let mut session = empty_session("tpl-delete-song-folder");
    let audio = audio_with(Some(BUILTIN_BAND_TEMPLATE), Some("songFolder"));
    session
        .create_empty_song(Some("Way Maker"), None, &audio)
        .expect("first song");
    let files = write_stems(&session, &MULTITRACK);
    let requests: Vec<_> = files
        .iter()
        .map(|file_path| CreateClipWithAutoTrackRequest {
            file_path: file_path.clone(),
            timeline_start_seconds: 0.0,
        })
        .collect();
    session
        .create_clips_with_auto_tracks(&requests, &audio)
        .expect("drop into the first song");
    session
        .create_empty_song(Some("Song Two"), None, &audio)
        .expect("second song");
    let song = loaded(&session);
    let first = song.regions[0].id.clone();
    let second = song.regions[1].id.clone();
    let before = loaded(&session);
    let second_tracks = before
        .tracks
        .iter()
        .filter(|t| t.song_region_id.as_deref() == Some(&second))
        .count();

    let undo_depth = session.undo_stack.len();
    session.delete_song_region(&first, &audio).expect("delete");
    let after = loaded(&session);
    assert!(after
        .tracks
        .iter()
        .all(|t| t.song_region_id.as_deref() != Some(&first)));
    // The other song keeps everything.
    assert_eq!(
        after
            .tracks
            .iter()
            .filter(|t| t.song_region_id.as_deref() == Some(&second))
            .count(),
        second_tracks
    );

    assert_eq!(session.undo_stack.len(), undo_depth + 1);
    session.undo_action(&audio).expect("undo");
    assert_eq!(loaded(&session).tracks.len(), before.tracks.len());
}

#[test]
fn deleting_a_song_keeps_shared_tracks() {
    let mut session = empty_session("tpl-delete-song-shared");
    let audio = audio_with(Some(BUILTIN_BAND_TEMPLATE), None);
    session
        .create_empty_song(None, None, &audio)
        .expect("create song");
    let tracks = loaded(&session).tracks.len();
    let region = loaded(&session).regions[0].id.clone();
    session.delete_song_region(&region, &audio).expect("delete");
    assert_eq!(loaded(&session).tracks.len(), tracks);
}

/// Soltar una carpeta de la biblioteca: los audios crean su canción al
/// colocarse y después `libraryFolderDrop` crea la definitiva encima y le pone
/// el nombre de la carpeta. La plantilla no debe hacer una segunda copia.
fn drop_library_folder(layout: &str, template: Option<&str>) -> Song {
    let mut session = empty_session(&format!("tpl-folder-drop-{layout}-{}", template.is_some()));
    let audio = audio_with(template, Some(layout));
    let files = write_stems(&session, &MULTITRACK);
    let requests: Vec<_> = files
        .iter()
        .map(|file_path| CreateAudioTrackWithClipRequest {
            track_name: file_path
                .trim_start_matches("audio/")
                .trim_end_matches(".wav")
                .into(),
            file_path: file_path.clone(),
            timeline_start_seconds: 0.0,
        })
        .collect();
    session
        .create_audio_tracks_with_clips(&requests, &audio)
        .expect("place the folder's audio");
    session
        .create_song_region(0.0, 4.0, &audio)
        .expect("wrap it in a song");
    let region = loaded(&session).regions[0].clone();
    session
        .update_song_region(&region.id, "Way Maker", 0.0, region.end_seconds, &audio)
        .expect("name it after the folder");
    loaded(&session)
}

fn band_folder_copies(song: &Song) -> usize {
    song.tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Folder && t.name == "Batería")
        .count()
}

#[test]
fn a_library_folder_drop_lays_the_template_out_once() {
    for layout in ["shared", "separate", "songFolder"] {
        let song = drop_library_folder(layout, Some(BUILTIN_BAND_TEMPLATE));
        assert_eq!(song.regions.len(), 1, "{layout}");
        assert_eq!(band_folder_copies(&song), 1, "{layout}: one copy of the band");
        if layout != "shared" {
            let region_id = &song.regions[0].id;
            assert!(
                song.tracks
                    .iter()
                    .all(|t| t.song_region_id.as_ref() == Some(region_id)),
                "{layout}: every track belongs to the song that exists"
            );
        }
        if layout == "songFolder" {
            assert_eq!(
                song_folder_of(&song, &song.regions[0].id).as_deref(),
                Some("Way Maker")
            );
        }
    }
}

#[test]
fn a_library_folder_drop_without_a_template_respects_the_track_layout() {
    for layout in ["shared", "separate", "songFolder"] {
        let song = drop_library_folder(layout, None);
        assert_eq!(song.regions.len(), 1, "{layout}");
        let region = &song.regions[0];
        assert_eq!(region.name, "Way Maker");
        assert_eq!(
            song.tracks.len(),
            MULTITRACK.len() + usize::from(layout == "songFolder"),
            "{layout}: no duplicate folders"
        );
        for track in &song.tracks {
            assert_eq!(
                track.song_region_id.as_ref(),
                (layout != "shared").then_some(&region.id),
                "{layout}: track ownership survives region replacement"
            );
        }
        for file in MULTITRACK {
            assert_eq!(
                parent_name_of_clip(&song, file).as_deref(),
                (layout == "songFolder").then_some("Way Maker"),
                "{layout}"
            );
        }
    }
}

fn drop_multitrack_in_daw(session: &mut DesktopSession, audio: &AudioController, at: f64) {
    let files = write_stems(session, &MULTITRACK);
    let requests: Vec<_> = files
        .iter()
        .map(|file_path| CreateAudioTrackWithClipRequest {
            track_name: file_path
                .trim_start_matches("audio/")
                .trim_end_matches(".wav")
                .into(),
            file_path: file_path.clone(),
            timeline_start_seconds: at,
        })
        .collect();
    session
        .create_audio_tracks_with_clips(&requests, audio)
        .expect("drop");
}

/// «Guardar como plantilla» en carpeta por canción: la plantilla lleva una
/// sola copia de la banda, sin la carpeta de la canción ni sus stems, y la
/// canción siguiente sale con un único nivel de carpeta.
#[test]
fn saving_a_song_folder_session_as_template_keeps_one_clean_band() {
    let mut session = empty_session("tpl-save-song-folder");
    let audio = audio_with(Some(BUILTIN_BAND_TEMPLATE), Some("songFolder"));
    drop_multitrack_in_daw(&mut session, &audio, 0.0);
    drop_multitrack_in_daw(&mut session, &audio, 20.0);
    let song = loaded(&session);
    assert_eq!(song.regions.len(), 2);

    let template_path = session
        .song_dir
        .clone()
        .unwrap()
        .parent()
        .unwrap()
        .join("Banda.lttemplate");
    session
        .save_current_as_template(template_path.clone())
        .expect("save as template");
    let template = libretracks_project::load_song_from_file(&template_path).expect("template");
    let names: Vec<&str> = template.tracks.iter().map(|t| t.name.as_str()).collect();
    for region in &song.regions {
        assert!(!names.contains(&region.name.as_str()), "{names:?}");
    }
    assert_eq!(band_folder_copies(&template), 1, "{names:?}");
    // Ni carriles de stems ni el banjo suelto: solo lo que tiene alias.
    assert!(template.tracks.iter().all(|t| !t.match_aliases.is_empty()), "{names:?}");
    // Lo que sumaba por la carpeta de la canción vuelve al master.
    assert!(template
        .tracks
        .iter()
        .filter(|t| t.parent_track_id.is_none())
        .all(|t| t.audio_to == "master"));

    let audio = audio_with(Some(&template_path.to_string_lossy()), Some("songFolder"));
    session
        .create_empty_song(Some("Tercera"), None, &audio)
        .expect("song from the saved template");
    let song = loaded(&session);
    let third = song.regions.iter().find(|r| r.name == "Tercera").unwrap();
    let folder = song_folder_of(&song, &third.id).expect("its folder");
    assert_eq!(folder, "Tercera");
    let folder_id = song
        .tracks
        .iter()
        .find(|t| t.parent_track_id.is_none() && t.song_region_id.as_ref() == Some(&third.id))
        .unwrap()
        .id
        .clone();
    let children: Vec<&str> = song
        .tracks
        .iter()
        .filter(|t| t.parent_track_id.as_deref() == Some(folder_id.as_str()))
        .map(|t| t.name.as_str())
        .collect();
    assert!(children.contains(&"Guitarras"), "{children:?}");
    assert!(song
        .tracks
        .iter()
        .filter(|t| t.song_region_id.as_ref() == Some(&third.id))
        .all(|t| t.kind != TrackKind::Folder || t.name == "Tercera" || !t.match_aliases.is_empty()));
}

/// Sin alias en la sesión, una plantilla de sesión sigue guardando todas las
/// pistas, también las que tienen audio.
#[test]
fn a_session_template_without_aliases_keeps_every_track() {
    let mut session = empty_session("tpl-save-plain");
    let audio = audio_with(None, None);
    drop_multitrack_in_daw(&mut session, &audio, 0.0);
    let tracks = loaded(&session).tracks.len();
    let template_path = session
        .song_dir
        .clone()
        .unwrap()
        .parent()
        .unwrap()
        .join("Plana.lttemplate");
    session
        .save_current_as_template(template_path.clone())
        .expect("save as template");
    let template = libretracks_project::load_song_from_file(&template_path).expect("template");
    assert_eq!(template.tracks.len(), tracks);
}

/// Sin alias, una plantilla de sesión guarda las pistas de todas las canciones
/// aunque el modo las haga de cada canción (el E2E de plantillas de sesión).
#[test]
fn a_session_template_without_aliases_keeps_the_tracks_of_every_song() {
    for layout in ["separate", "songFolder"] {
        let mut session = empty_session(&format!("tpl-save-plain-{layout}"));
        let audio = audio_with(None, Some(layout));
        drop_multitrack_in_daw(&mut session, &audio, 0.0);
        drop_multitrack_in_daw(&mut session, &audio, 20.0);
        let tracks = loaded(&session).tracks.len();
        let template_path = session
            .song_dir
            .clone()
            .unwrap()
            .parent()
            .unwrap()
            .join("Plana.lttemplate");
        session
            .save_current_as_template(template_path.clone())
            .expect("save as template");
        let template = libretracks_project::load_song_from_file(&template_path).expect("template");
        assert_eq!(template.tracks.len(), tracks, "{layout}");
    }
}
