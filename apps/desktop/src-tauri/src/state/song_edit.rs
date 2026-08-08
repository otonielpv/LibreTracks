//! Free helpers that rewrite a `Song`'s clips and regions: clip-window
//! validation, appending a clip (creating an auto-track/region if needed),
//! batch clip moves with region reshape, and the empty-region / auto-track
//! pruning that runs after edits. Shared by `arrangement.rs`, `regions.rs` and
//! `mod.rs`; pure functions, no `self`.

use std::path::Path;

use libretracks_core::{Clip, Song, SongRegion, TrackKind};
use libretracks_project::read_audio_metadata;

use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;

use super::{
    resolve_audio_file_path, sort_song_regions, timestamp_suffix, ClipMoveRequest,
    CreateClipRequest,
};

pub(super) fn normalize_timeline_start_seconds(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

/// Format a duration as `m:ss` so rejection messages talk in the units the
/// user reads off the timeline instead of raw seconds.
fn format_duration_label(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as i64;
    format!("{}:{:02}", total / 60, total % 60)
}

/// The UI language the user picked, lowercased, or `None` when settings can't
/// be read. Auto-created songs are named in this language.
pub(super) fn ui_locale(audio: &AudioController) -> Option<String> {
    audio
        .current_settings()
        .ok()
        .and_then(|settings| settings.locale)
        .map(|locale| locale.to_ascii_lowercase())
}

/// Default name for the `index`-th auto-created song, in the user's language.
///
/// Every path that creates a song without the user typing a name must go
/// through here. Regions born from a clip drop used to hardcode `"Song N"`
/// while the ones created from the timeline header were localized, so the same
/// session ended up with a mix of "Canción 1" and "Song 2".
pub(super) fn default_region_name(locale: Option<&str>, index: usize) -> String {
    match locale {
        Some("es") => format!("Canción {}", index + 1),
        _ => format!("Song {}", index + 1),
    }
}

/// Last path segment, for naming the offending file in an error message.
fn file_label(file_path: &str) -> String {
    file_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(file_path)
        .to_string()
}

pub(super) fn validate_clip_window(
    song_dir: &std::path::Path,
    clip_file_path: &str,
    timeline_start_seconds: f64,
    source_start_seconds: f64,
    duration_seconds: f64,
) -> Result<(), DesktopError> {
    if !timeline_start_seconds.is_finite() || source_start_seconds < 0.0 || duration_seconds < 0.05
    {
        return Err(DesktopError::InvalidClipRange);
    }

    let audio_metadata = read_audio_metadata(resolve_audio_file_path(song_dir, clip_file_path))?;
    if source_start_seconds + duration_seconds > audio_metadata.duration_seconds + 0.0001 {
        return Err(DesktopError::InvalidClipRange);
    }

    Ok(())
}

pub(super) fn append_clip_to_song(
    song: &mut Song,
    song_dir: &Path,
    request: &CreateClipRequest,
    locale: Option<&str>,
) -> Result<(), DesktopError> {
    let track = song
        .tracks
        .iter()
        .find(|track| track.id == request.track_id)
        .ok_or_else(|| DesktopError::TrackNotFound(request.track_id.clone()))?;
    if track.kind == TrackKind::Folder {
        return Err(DesktopError::AudioCommand(
            "clip cannot target a folder track".into(),
        ));
    }

    let normalized_file_path = request.file_path.replace('\\', "/");
    let wav_metadata =
        read_audio_metadata(resolve_audio_file_path(song_dir, &normalized_file_path))?;
    let clip_id = format!("clip_{}_{}", timestamp_suffix(), song.clips.len());
    let clip_start = normalize_timeline_start_seconds(request.timeline_start_seconds);
    let clip_end = clip_start + wav_metadata.duration_seconds;

    // Enforce the "clip lives inside one region" invariant by either
    // extending the region the clip lands in, or creating a new region
    // around it when it falls between songs. A clip whose span would
    // invade a neighbouring song is rejected — naming the file so the
    // rejection is actionable instead of a bare "no cabe".
    ensure_region_covers_clip_for_file(
        song,
        clip_start,
        clip_end,
        Some(&normalized_file_path),
        locale,
    )?;

    song.clips.push(Clip {
        id: clip_id,
        track_id: request.track_id.clone(),
        file_path: normalized_file_path,
        timeline_start_seconds: clip_start,
        source_start_seconds: 0.0,
        duration_seconds: wav_metadata.duration_seconds,
        gain: 1.0,
        fade_in_seconds: None,
        fade_out_seconds: None,
        color: None,
    });

    Ok(())
}

/// Make sure exactly one region covers `[clip_start, clip_end)`.
///
/// Cases handled (with the user-facing contract from steps 4.3 + 4.4 of the
/// song-model plan):
///
/// 1. A region already contains `[clip_start, clip_end)` end-to-end. No-op.
/// 2. A region contains `clip_start` but the clip overflows its end. Extend
///    that region's end to `clip_end`. If the new end would overlap a
///    following region, the drop is rejected (the user's clip would invade
///    the next song).
/// 3. The clip falls outside every region. Create a fresh region around it,
///    unless that new region would overlap a neighbour, in which case the
///    drop is rejected.
///
/// We never shift `clip_start` backward into an earlier region's tail — the
/// invariant is about containment, and a clip whose start sits at exactly
/// `region.end` belongs to whatever follows, not to that region.
pub(super) fn ensure_region_covers_clip(
    song: &mut Song,
    clip_start: f64,
    clip_end: f64,
    locale: Option<&str>,
) -> Result<(), DesktopError> {
    ensure_region_covers_clip_for_file(song, clip_start, clip_end, None, locale)
}

/// Same as [`ensure_region_covers_clip`], but names the audio file in the
/// rejection message.
///
/// The common failure is dropping a full-length track between two songs that
/// sit back to back: there is no free time before the next song starts, so the
/// clip is refused. The bare "would extend into the next song" gave the user no
/// way to act — it named neither the file nor how much room was missing, and
/// the library badge only showed the generic "Error al importar", which reads
/// as if the audio file itself were broken. We report which file, how long it
/// is, how much space is actually free, and by how much it overflows.
pub(super) fn ensure_region_covers_clip_for_file(
    song: &mut Song,
    clip_start: f64,
    clip_end: f64,
    file_path: Option<&str>,
    locale: Option<&str>,
) -> Result<(), DesktopError> {
    if clip_end <= clip_start {
        return Err(DesktopError::AudioCommand(
            "clip must have a positive duration".into(),
        ));
    }

    // "<file> (m:ss) " prefix when we know which file we are placing.
    let subject = |duration: f64| match file_path {
        Some(path) => format!(
            "'{}' ({})",
            file_label(path),
            format_duration_label(duration)
        ),
        None => format!("el clip ({})", format_duration_label(duration)),
    };
    let clip_duration = clip_end - clip_start;

    // Pre-sort so neighbour lookups are deterministic.
    sort_song_regions(&mut song.regions);

    // Case 1 / 2: clip starts inside an existing region.
    if let Some(idx) = song
        .regions
        .iter()
        .position(|region| clip_start >= region.start_seconds && clip_start < region.end_seconds)
    {
        let region_end = song.regions[idx].end_seconds;
        if clip_end <= region_end {
            return Ok(());
        }
        // Need to extend forward. Reject if a following region sits before
        // clip_end — extending would either overlap it (invariant break)
        // or implicitly delete it (data loss).
        if let Some(next) = song.regions.get(idx + 1) {
            if clip_end > next.start_seconds {
                let available = next.start_seconds - clip_start;
                let overflow = clip_end - next.start_seconds;
                return Err(DesktopError::AudioCommand(format!(
                    "{} no cabe donde lo has soltado.\n\n\
                     Solo hay {} libres antes de que empiece '{}', \
                     asi que se pasa {}.\n\n\
                     Puedes alargar la cancion '{}', soltarlo mas atras, \
                     o mover '{}' para hacer sitio.",
                    subject(clip_duration),
                    format_duration_label(available),
                    next.name,
                    format_duration_label(overflow),
                    song.regions[idx].name,
                    next.name,
                )));
            }
        }
        song.regions[idx].end_seconds = clip_end;
        return Ok(());
    }

    // Case 3: clip is outside every region. Build a fresh region. Reject if
    // its bounds would straddle a neighbour.
    if let Some(neighbour) = song
        .regions
        .iter()
        .find(|region| !(clip_end <= region.start_seconds || clip_start >= region.end_seconds))
    {
        // Dropping into the gap between two songs is the common case here, and
        // the useful number is how big that gap actually is: the free run from
        // the drop point to whatever starts next. Without it the user only
        // learns that it did not fit, not how much room they need to make.
        let gap_until_neighbour = neighbour.start_seconds - clip_start;
        let gap_hint = if gap_until_neighbour > 0.0 {
            format!(
                "El hueco donde lo has soltado solo tiene {} antes de que empiece '{}'.\n\n",
                format_duration_label(gap_until_neighbour),
                neighbour.name,
            )
        } else {
            String::new()
        };
        return Err(DesktopError::AudioCommand(format!(
            "{} no cabe en este hueco.\n\n\
             {}Sueltalo dentro de '{}', o haz un hueco de {} o mas \
             moviendo las canciones de alrededor.",
            subject(clip_duration),
            gap_hint,
            neighbour.name,
            format_duration_label(clip_duration),
        )));
    }
    let region_index = song.regions.len();
    song.regions.push(SongRegion {
        id: format!("region_{}_{}", timestamp_suffix(), region_index),
        name: default_region_name(locale, region_index),
        start_seconds: clip_start,
        end_seconds: clip_end,
        transpose_semitones: 0,
        key: None,
        warp_enabled: false,
        warp_source_bpm: None,
        master: libretracks_core::SongMaster::default(),
    });
    sort_song_regions(&mut song.regions);
    Ok(())
}

/// Apply a batch of clip moves with the same per-clip region reshaping the
/// single-clip path uses. Moves are applied in order so the region layout
/// after each clip's reshape is visible to the next. Failure on any single
/// move aborts the whole batch — callers see a single all-or-nothing
/// outcome, matching how the user perceives a multi-select drag.
pub(super) fn apply_clip_moves_with_region_reshape(
    song: &mut Song,
    moves: &[ClipMoveRequest],
    locale: Option<&str>,
) -> Result<(), DesktopError> {
    for request in moves {
        let new_start = normalize_timeline_start_seconds(request.timeline_start_seconds);
        let clip_duration = song
            .clips
            .iter()
            .find(|clip| clip.id == request.clip_id)
            .map(|clip| clip.duration_seconds)
            .ok_or_else(|| DesktopError::ClipNotFound(request.clip_id.clone()))?;
        // When the move reassigns the clip to another track, validate the
        // destination before touching anything (same rule as
        // move_clip_to_track: target must exist and must not be a folder).
        if let Some(target_track_id) = &request.target_track_id {
            let target_kind = song
                .tracks
                .iter()
                .find(|track| &track.id == target_track_id)
                .map(|track| track.kind)
                .ok_or_else(|| DesktopError::TrackNotFound(target_track_id.clone()))?;
            if target_kind == libretracks_core::TrackKind::Folder {
                return Err(DesktopError::AudioCommand(
                    "no se puede mover un clip a un folder".into(),
                ));
            }
        }
        ensure_region_covers_clip(song, new_start, new_start + clip_duration, locale)?;
        let clip = song
            .clips
            .iter_mut()
            .find(|clip| clip.id == request.clip_id)
            .ok_or_else(|| DesktopError::ClipNotFound(request.clip_id.clone()))?;
        clip.timeline_start_seconds = new_start;
        if let Some(target_track_id) = &request.target_track_id {
            clip.track_id = target_track_id.clone();
        }
    }
    Ok(())
}

/// Drop any region that no longer has at least one clip whose start falls
/// inside it. Per the song-model plan (step 4.5), a song that loses its last
/// clip ceases to exist — the user does not have to clean it up by hand.
///
/// The size of surviving regions is left alone (user request: "if clips are
/// moved leave the size as-is, the user can adjust"). Only completely empty
/// regions are removed.
pub(super) fn prune_empty_regions(song: &mut Song) {
    song.regions.retain(|region| {
        song.clips.iter().any(|clip| {
            clip.timeline_start_seconds >= region.start_seconds
                && clip.timeline_start_seconds < region.end_seconds
        })
    });
}

/// Remove any track whose `auto_created` flag is set and that holds no clip
/// at all. User-created tracks (auto_created = false) are left alone even
/// when empty — the user may want a placeholder before they drop audio in.
///
/// Used by every flow that can leave a track empty: delete_clip, the move-
/// clip paths, and the upcoming move_clip_to_track. A track auto-created
/// for a single audio drop disappears the moment the user moves that clip
/// to another track, leaving the mixer view tidy without an explicit
/// "delete track" step.
/// Strip the directory path and extension off a file path to derive a
/// reasonable initial track name. "audio/kick.wav" → "kick". Falls back to
/// the raw path if nothing sensible remains.
pub(super) fn file_stem_for_auto_track(file_path: &str) -> String {
    let normalised = file_path.replace('\\', "/");
    let basename = normalised.rsplit('/').next().unwrap_or(&normalised);
    let stem = match basename.rfind('.') {
        Some(idx) if idx > 0 => &basename[..idx],
        _ => basename,
    };
    let trimmed = stem.trim();
    if trimmed.is_empty() {
        return file_path.to_string();
    }
    trimmed.to_string()
}

pub(super) fn prune_auto_created_empty_tracks(song: &mut Song) {
    let used_track_ids: std::collections::HashSet<&str> = song
        .clips
        .iter()
        .map(|clip| clip.track_id.as_str())
        .collect();
    // Folder tracks are kept around even when "empty" — a folder with no
    // children is still a structural choice. We only prune leaf audio
    // tracks that the system created and nobody is using.
    song.tracks.retain(|track| {
        !(track.auto_created
            && track.kind != libretracks_core::TrackKind::Folder
            && !used_track_ids.contains(track.id.as_str()))
    });
}

#[cfg(test)]
mod region_message_tests {
    use super::*;

    fn region(name: &str, start: f64, end: f64) -> SongRegion {
        SongRegion {
            id: format!("region_{name}"),
            name: name.to_string(),
            start_seconds: start,
            end_seconds: end,
            transpose_semitones: 0,
            key: None,
            warp_enabled: false,
            warp_source_bpm: None,
            master: libretracks_core::SongMaster::default(),
        }
    }

    fn song_with_regions(regions: Vec<SongRegion>) -> Song {
        Song {
            id: "song_test".into(),
            title: "Test".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 600.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions,
            tracks: vec![],
            clips: vec![],
            midi_clips: vec![],
            section_markers: vec![],
        }
    }

    /// Two songs back to back, as in a real set list: there is no free time
    /// between them.
    fn setlist_song() -> Song {
        song_with_regions(vec![
            region("Digno", 0.0, 180.0),
            region("Si tu presencia", 180.0, 400.0),
        ])
    }

    fn error_text(result: Result<(), DesktopError>) -> String {
        match result {
            Ok(()) => panic!("expected the placement to be rejected"),
            Err(error) => error.to_string(),
        }
    }

    #[test]
    fn rejection_names_the_file_the_space_left_and_the_overflow() {
        let mut song = setlist_song();
        // A 4-minute track dropped 20s into the first song. Only 2:40 is free
        // before "Si tu presencia" starts, so it overflows by 1:20.
        let message = error_text(ensure_region_covers_clip_for_file(
            &mut song,
            20.0,
            260.0,
            Some("C:/audio/Dios es Real - Bajo.mp3"),
            None,
        ));

        assert!(
            message.contains("Dios es Real - Bajo.mp3"),
            "must name the offending file, got: {message}"
        );
        assert!(
            message.contains("2:40"),
            "must state the free space, got: {message}"
        );
        assert!(
            message.contains("1:20"),
            "must state the overflow, got: {message}"
        );
        assert!(
            message.contains("Si tu presencia"),
            "must name the song in the way, got: {message}"
        );
    }

    #[test]
    fn straddling_rejection_names_the_song_and_the_room_required() {
        // Gap between the two songs, but the clip is longer than the gap.
        let mut song = song_with_regions(vec![
            region("Digno", 0.0, 180.0),
            region("Si tu presencia", 300.0, 500.0),
        ]);

        let message = error_text(ensure_region_covers_clip_for_file(
            &mut song,
            200.0,
            380.0,
            Some("audio/Guia.wav"),
            None,
        ));

        assert!(message.contains("Guia.wav"), "got: {message}");
        assert!(message.contains("Si tu presencia"), "got: {message}");
        // 180s of audio -> needs a 3:00 slot.
        assert!(message.contains("3:00"), "got: {message}");
    }

    #[test]
    fn placements_that_already_worked_are_unaffected() {
        // Fits inside the first song.
        let mut song = setlist_song();
        assert!(
            ensure_region_covers_clip_for_file(&mut song, 20.0, 100.0, Some("a.wav"), None).is_ok()
        );

        // Free space after the last song: a region is auto-created.
        let mut song = setlist_song();
        assert!(
            ensure_region_covers_clip_for_file(&mut song, 400.0, 640.0, Some("b.wav"), None).is_ok()
        );
        assert_eq!(song.regions.len(), 3);

        // Extending the LAST song has no neighbour to collide with.
        let mut song = setlist_song();
        assert!(
            ensure_region_covers_clip_for_file(&mut song, 380.0, 700.0, Some("c.wav"), None).is_ok()
        );
        assert_eq!(song.regions.len(), 2);

        // A stacked multitrack keeps extending the SAME region rather than
        // creating one per stem.
        let mut song = song_with_regions(vec![region("Song 1", 0.0, 60.0)]);
        for end in [30.0, 200.0, 120.0] {
            assert!(
                ensure_region_covers_clip_for_file(&mut song, 0.0, end, Some("stem.wav"), None)
                    .is_ok()
            );
        }
        assert_eq!(song.regions.len(), 1, "a multitrack must stay one region");
        assert!((song.regions[0].end_seconds - 200.0).abs() < 0.001);
    }

    /// Dropping audio onto empty timeline used to hardcode "Song N" while the
    /// timeline header's "create song" was localized, so a Spanish session
    /// ended up mixing "Canción 1" with "Song 2".
    #[test]
    fn an_auto_created_region_is_named_in_the_ui_language() {
        let mut song = song_with_regions(vec![]);
        ensure_region_covers_clip_for_file(&mut song, 0.0, 180.0, Some("a.wav"), Some("es"))
            .expect("an empty timeline always has room");
        assert_eq!(song.regions[0].name, "Canción 1");

        let mut song = song_with_regions(vec![]);
        ensure_region_covers_clip_for_file(&mut song, 0.0, 180.0, Some("a.wav"), Some("en"))
            .expect("an empty timeline always has room");
        assert_eq!(song.regions[0].name, "Song 1");
    }

    #[test]
    fn region_names_fall_back_to_english_for_unknown_locales() {
        assert_eq!(default_region_name(Some("es"), 0), "Canción 1");
        assert_eq!(default_region_name(Some("en"), 1), "Song 2");
        assert_eq!(default_region_name(None, 2), "Song 3");
        assert_eq!(default_region_name(Some("pt"), 0), "Song 1");
    }

    #[test]
    fn duration_labels_render_as_minutes_and_seconds() {
        assert_eq!(format_duration_label(0.0), "0:00");
        assert_eq!(format_duration_label(59.4), "0:59");
        assert_eq!(format_duration_label(60.0), "1:00");
        assert_eq!(format_duration_label(245.0), "4:05");
        // Never renders a negative slot.
        assert_eq!(format_duration_label(-5.0), "0:00");
    }

    #[test]
    fn file_label_takes_the_last_path_segment() {
        assert_eq!(file_label("C:/audio/Bajo.mp3"), "Bajo.mp3");
        assert_eq!(file_label("audio\\Guia.wav"), "Guia.wav");
        assert_eq!(file_label("kick.wav"), "kick.wav");
    }

    fn clip_on(track_id: &str, start: f64, duration: f64) -> Clip {
        Clip {
            id: format!("clip_{track_id}"),
            track_id: track_id.to_string(),
            file_path: format!("audio/{track_id}.wav"),
            timeline_start_seconds: start,
            source_start_seconds: 0.0,
            duration_seconds: duration,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            color: None,
        }
    }

    /// Regression for the ghost region left behind by `delete_tracks`.
    ///
    /// Deleting a track drops its clips, which can empty a region. Every other
    /// clip-removing path prunes those; `delete_tracks` did not, so removing
    /// all of a song's tracks left the region on the timeline with nothing in
    /// it — and a later re-import landed inside that leftover region instead of
    /// creating a fresh one.
    #[test]
    fn a_region_that_loses_all_its_clips_is_pruned() {
        let mut song = song_with_regions(vec![
            region("Cancion A", 0.0, 180.0),
            region("Cancion B", 180.0, 400.0),
        ]);
        song.clips = vec![
            clip_on("t_a1", 0.0, 180.0),
            clip_on("t_b1", 180.0, 220.0),
        ];

        // Simulate delete_tracks removing every clip of "Cancion B".
        song.clips.retain(|clip| clip.track_id != "t_b1");
        prune_empty_regions(&mut song);

        assert_eq!(
            song.regions.len(),
            1,
            "the emptied region must not survive: {:?}",
            song.regions.iter().map(|r| &r.name).collect::<Vec<_>>()
        );
        assert_eq!(song.regions[0].name, "Cancion A");
    }

    /// With the ghost region gone, re-importing the deleted song creates a new
    /// region sized to the audio instead of inheriting the stale bounds.
    #[test]
    fn reimporting_after_deleting_a_song_creates_a_fresh_region() {
        let mut song = song_with_regions(vec![
            region("Cancion A", 0.0, 180.0),
            region("Cancion B", 180.0, 400.0),
        ]);
        song.clips = vec![clip_on("t_a1", 0.0, 180.0), clip_on("t_b1", 180.0, 220.0)];

        song.clips.retain(|clip| clip.track_id != "t_b1");
        prune_empty_regions(&mut song);

        // Re-import a 5-minute version where the old song used to be.
        ensure_region_covers_clip_for_file(&mut song, 180.0, 480.0, Some("Cancion B.mp3"), None)
            .expect("the slot is free once the ghost region is gone");

        let created = song
            .regions
            .iter()
            .find(|r| (r.start_seconds - 180.0).abs() < 0.01)
            .expect("a region should be created for the re-import");
        assert!(
            (created.end_seconds - 480.0).abs() < 0.01,
            "the new region must match the re-imported audio, got {}",
            created.end_seconds
        );
    }

    /// A region that still holds clips is never pruned.
    #[test]
    fn regions_that_still_have_clips_survive() {
        let mut song = song_with_regions(vec![
            region("Cancion A", 0.0, 180.0),
            region("Cancion B", 180.0, 400.0),
        ]);
        song.clips = vec![clip_on("t_a1", 0.0, 180.0), clip_on("t_b1", 180.0, 220.0)];

        prune_empty_regions(&mut song);

        assert_eq!(song.regions.len(), 2);
    }

    /// Regression for a session that saved fine and then refused to reopen.
    ///
    /// Drawing an empty region past the last clip (the "create the song now,
    /// drop the audio in later" flow) left `duration_seconds` behind, because
    /// `create_song_region` was the one region path that never called
    /// `refresh_song_duration`. The engine's validator rejects any region that
    /// reaches past the song with "Region X is outside its song", so the user
    /// could not open their own session — and the region it named was one they
    /// had just created by hand. An empty region is legitimate; a region
    /// outside the song is not.
    #[test]
    fn an_empty_region_drawn_past_the_last_clip_stays_inside_the_song() {
        let mut song = song_with_regions(vec![region("Cancion A", 0.0, 180.0)]);
        song.clips = vec![clip_on("t_a1", 0.0, 180.0)];
        crate::state::refresh_song_duration(&mut song);
        assert!((song.duration_seconds - 180.0).abs() < 0.001);

        // The user draws "Cancion 4" in empty space well past the last clip.
        song.regions.push(region("Cancion 4", 982.97, 1183.96));
        crate::state::refresh_song_duration(&mut song);

        let max_region_end = song
            .regions
            .iter()
            .map(|r| r.end_seconds)
            .fold(0.0_f64, f64::max);
        assert!(
            song.duration_seconds >= max_region_end,
            "the song must envelop every region or the session cannot be \
             reopened: duration={} but a region ends at {}",
            song.duration_seconds,
            max_region_end
        );
    }
}
