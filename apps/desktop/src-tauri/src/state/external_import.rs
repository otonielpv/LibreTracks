//! Importing external DAW projects (Reaper, Ableton) into the current session:
//! detecting the project kind, parsing it into a `Song`, splicing the result in
//! at the requested timeline position, and the `imported_*` marker/entity
//! normalization helpers that back the parse (used only here).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use libretracks_core::{
    effective_bpm_at, Clip, Marker, MarkerKind, Song, SongRegion, TempoMarker, TimeSignatureMarker,
    Track, TrackKind,
};

use crate::audio::engine::{audio_debug_logging_enabled, AudioController};
use crate::error::DesktopError;
use crate::external_project::{
    detect_external_project_kind, parse_ableton_project, parse_reaper_project, ExternalProjectKind,
    ReaperProject,
};
use crate::models::SongPackageImportResponse;

use super::{
    import_audio_files_from_paths_to_library, list_library_assets, reconcile_regions_and_clips,
    slugify, timestamp_suffix, AudioChangeImpact, AudioFilePathImportPayload, DesktopSession,
};

impl DesktopSession {
    pub fn import_external_project(
        &mut self,
        project_path: &str,
        insert_at_seconds: f64,
        audio: &AudioController,
    ) -> Result<SongPackageImportResponse, DesktopError> {
        // Callers that already resolved the insert point (the dialog flows) keep
        // the position as-is.
        self.import_external_project_at(project_path, insert_at_seconds, false, audio)
    }

    /// Import an external project at `desired_seconds`. When `resolve_overlap` is
    /// true (the timeline OS-drag), the desired position is checked against the
    /// existing songs and bumped to the setlist end if it would overlap (a whole
    /// project becomes song region(s), which may not overlap). When false, the
    /// position is used verbatim.
    pub fn import_external_project_at(
        &mut self,
        project_path: &str,
        desired_seconds: f64,
        resolve_overlap: bool,
        audio: &AudioController,
    ) -> Result<SongPackageImportResponse, DesktopError> {
        let started_at = Instant::now();
        let project_path = Path::new(project_path);
        eprintln!(
            "[libretracks-import] begin external import path={} desired_seconds={:.3} resolve_overlap={}",
            project_path.to_string_lossy(),
            desired_seconds,
            resolve_overlap
        );
        let audio_debug_raw = std::env::var("LIBRETRACKS_AUDIO_DEBUG")
            .ok()
            .unwrap_or_else(|| "<unset>".to_string());
        let audio_debug_enabled = audio_debug_logging_enabled();
        eprintln!(
            "[libretracks-import] env LIBRETRACKS_AUDIO_DEBUG raw={} enabled={}",
            audio_debug_raw, audio_debug_enabled
        );
        let kind = detect_external_project_kind(project_path).ok_or_else(|| {
            DesktopError::AudioCommand(
                "formato no soportado. Usa un .rpp (Reaper) o .als (Ableton Live)".into(),
            )
        })?;
        eprintln!("[libretracks-import] detected kind={kind:?}");

        let result = match kind {
            ExternalProjectKind::Reaper => {
                let parse_started = Instant::now();
                let parsed =
                    parse_reaper_project(project_path).map_err(DesktopError::AudioCommand)?;
                eprintln!(
                    "[libretracks-import] parsed reaper title={} tracks={} regions={} markers={} tempo_markers={} time_signature_markers={} duration={:.3}s parse_ms={}",
                    parsed.title,
                    parsed.tracks.len(),
                    parsed.regions.len(),
                    parsed.section_markers.len(),
                    parsed.tempo_markers.len(),
                    parsed.time_signature_markers.len(),
                    parsed.duration_seconds,
                    parse_started.elapsed().as_millis()
                );
                let insert = if resolve_overlap {
                    self.resolve_external_insert_seconds(desired_seconds, parsed.duration_seconds)
                } else {
                    desired_seconds
                };
                self.import_reaper_project(parsed, insert, audio)
            }
            ExternalProjectKind::Ableton => {
                let parse_started = Instant::now();
                let parsed =
                    parse_ableton_project(project_path).map_err(DesktopError::AudioCommand)?;
                eprintln!(
                    "[libretracks-import] parsed ableton title={} tracks={} regions={} markers={} tempo_markers={} time_signature_markers={} duration={:.3}s parse_ms={}",
                    parsed.title,
                    parsed.tracks.len(),
                    parsed.regions.len(),
                    parsed.section_markers.len(),
                    parsed.tempo_markers.len(),
                    parsed.time_signature_markers.len(),
                    parsed.duration_seconds,
                    parse_started.elapsed().as_millis()
                );
                let insert = if resolve_overlap {
                    self.resolve_external_insert_seconds(desired_seconds, parsed.duration_seconds)
                } else {
                    desired_seconds
                };
                self.import_reaper_project(parsed, insert, audio)
            }
        };

        match &result {
            Ok(response) => {
                eprintln!(
                    "[libretracks-import] external import completed revision={} assets={} total_ms={}",
                    response.snapshot.project_revision,
                    response.library_assets.len(),
                    started_at.elapsed().as_millis()
                );
            }
            Err(error) => {
                eprintln!(
                    "[libretracks-import] external import failed after {}ms: {error}",
                    started_at.elapsed().as_millis()
                );
            }
        }

        result
    }

    fn import_reaper_project(
        &mut self,
        project: ReaperProject,
        insert_at_seconds: f64,
        audio: &AudioController,
    ) -> Result<SongPackageImportResponse, DesktopError> {
        let started_at = Instant::now();
        eprintln!(
            "[libretracks-import] import_reaper_project start title={} insert_at_seconds={:.3}",
            project.title, insert_at_seconds
        );
        let song_dir = self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)?;
        let current_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let insert_at_seconds = insert_at_seconds.max(0.0);

        let mut source_paths = Vec::<PathBuf>::new();
        let mut seen_sources = HashSet::<String>::new();
        for track in &project.tracks {
            for item in &track.items {
                if item.muted {
                    continue;
                }
                let source_key = normalize_external_source_key(&item.source_path);
                if seen_sources.insert(source_key) {
                    source_paths.push(item.source_path.clone());
                }
            }
        }

        if source_paths.is_empty() {
            return Err(DesktopError::AudioCommand(
                "el proyecto Reaper no contiene items de audio importables".into(),
            ));
        }
        eprintln!(
            "[libretracks-import] source discovery unique_paths={}",
            source_paths.len()
        );

        let import_payloads = source_paths
            .iter()
            .map(|source_path| {
                let file_name = source_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| {
                        DesktopError::AudioCommand(format!(
                            "ruta de audio invalida en Reaper: {}",
                            source_path.to_string_lossy()
                        ))
                    })?
                    .to_string();
                Ok(AudioFilePathImportPayload {
                    file_name,
                    source_path: source_path.to_string_lossy().to_string(),
                })
            })
            .collect::<Result<Vec<_>, DesktopError>>()?;

        let imported_assets = import_audio_files_from_paths_to_library(
            &song_dir,
            Some(&current_song),
            &import_payloads,
        )?;
        eprintln!(
            "[libretracks-import] imported assets count={}",
            imported_assets.len()
        );

        let mut imported_path_by_source = HashMap::<String, String>::new();
        for (source_path, imported_asset) in source_paths.iter().zip(imported_assets.iter()) {
            imported_path_by_source.insert(
                normalize_external_source_key(source_path),
                imported_asset.file_path.clone(),
            );
        }

        let mut next_song = current_song.clone();
        let mut used_track_ids = next_song
            .tracks
            .iter()
            .map(|track| track.id.clone())
            .collect::<HashSet<_>>();
        let mut used_clip_ids = next_song
            .clips
            .iter()
            .map(|clip| clip.id.clone())
            .collect::<HashSet<_>>();

        let import_debug_enabled = audio_debug_logging_enabled();
        if import_debug_enabled {
            let mut simulated_depth = 0_i32;
            let mut max_depth = 0_i32;
            let mut folder_tracks = 0_usize;
            for track in &project.tracks {
                if track.folder_depth_delta > 0 {
                    folder_tracks += 1;
                }
                simulated_depth = (simulated_depth + track.folder_depth_delta).max(0);
                max_depth = max_depth.max(simulated_depth);
            }
            eprintln!(
                "[libretracks-import] debug hierarchy input_tracks={} folder_tracks={} max_folder_depth={}",
                project.tracks.len(),
                folder_tracks,
                max_depth
            );
        }

        let imported_tracks = project.tracks;
        let use_inferred_folder_groups = imported_tracks
            .iter()
            .all(|track| track.folder_depth_delta == 0)
            && imported_tracks.iter().any(|track| track.items.is_empty())
            && imported_tracks.iter().any(|track| !track.items.is_empty());

        let mut inferred_parent_by_index = HashMap::<usize, usize>::new();
        if use_inferred_folder_groups {
            let mut active_parent_index = None::<usize>;
            for (index, track) in imported_tracks.iter().enumerate() {
                if track.items.is_empty() {
                    active_parent_index = Some(index);
                    continue;
                }
                if let Some(parent_index) = active_parent_index {
                    inferred_parent_by_index.insert(index, parent_index);
                }
            }
        }
        let inferred_folder_parent_indices = inferred_parent_by_index
            .values()
            .copied()
            .collect::<HashSet<_>>();

        if import_debug_enabled {
            eprintln!(
                "[libretracks-import] debug folder strategy explicit_depth={} inferred_groups={}",
                !use_inferred_folder_groups, use_inferred_folder_groups
            );
        }

        let mut created_clip_count = 0usize;
        let mut folder_stack = Vec::<String>::new();
        let mut imported_track_ids_by_index = Vec::<String>::new();
        for (track_index, track) in imported_tracks.into_iter().enumerate() {
            let parent_track_id = if use_inferred_folder_groups {
                inferred_parent_by_index
                    .get(&track_index)
                    .and_then(|parent_index| imported_track_ids_by_index.get(*parent_index))
                    .cloned()
            } else {
                folder_stack.last().cloned()
            };
            let is_folder_track = if use_inferred_folder_groups {
                inferred_folder_parent_indices.contains(&track_index)
            } else {
                track.folder_depth_delta > 0
            };
            let track_id = unique_song_entity_id("track", &track.name, &mut used_track_ids);
            if import_debug_enabled {
                eprintln!(
                    "[libretracks-import] debug track name={} parent={} folder_depth_delta={} items={} kind={}",
                    track.name,
                    parent_track_id
                        .as_deref()
                        .unwrap_or("<none>"),
                    track.folder_depth_delta,
                    track.items.len(),
                    if is_folder_track { "folder" } else { "audio" }
                );
            }
            next_song.tracks.push(Track {
                id: track_id.clone(),
                name: track.name.clone(),
                kind: if is_folder_track {
                    TrackKind::Folder
                } else {
                    TrackKind::Audio
                },
                parent_track_id: parent_track_id.clone(),
                volume: track.volume.max(0.0),
                pan: track.pan.clamp(-1.0, 1.0),
                muted: track.muted,
                solo: track.solo,
                transpose_enabled: true,
                audio_to: if parent_track_id.is_some() {
                    "inherit".to_string()
                } else {
                    "master".to_string()
                },
                color: None,
                auto_created: false,
            });
            imported_track_ids_by_index.push(track_id.clone());

            for item in track.items {
                if item.muted {
                    continue;
                }
                let Some(imported_file_path) = imported_path_by_source
                    .get(&normalize_external_source_key(&item.source_path))
                    .cloned()
                else {
                    continue;
                };

                let clip_id = unique_song_entity_id("clip", &track.name, &mut used_clip_ids);
                next_song.clips.push(Clip {
                    id: clip_id,
                    track_id: track_id.clone(),
                    file_path: imported_file_path,
                    timeline_start_seconds: insert_at_seconds + item.position_seconds,
                    source_start_seconds: item.source_start_seconds,
                    duration_seconds: item.length_seconds,
                    gain: item.gain.max(0.0),
                    fade_in_seconds: None,
                    fade_out_seconds: None,
                    color: None,
                });
                created_clip_count += 1;
            }

            if !use_inferred_folder_groups {
                if track.folder_depth_delta > 0 {
                    for _ in 0..track.folder_depth_delta {
                        folder_stack.push(track_id.clone());
                    }
                } else if track.folder_depth_delta < 0 {
                    for _ in 0..(-track.folder_depth_delta) {
                        if folder_stack.pop().is_none() {
                            break;
                        }
                    }
                }
            }

            if import_debug_enabled {
                eprintln!(
                    "[libretracks-import] debug folder_stack_depth={} after track_id={}",
                    folder_stack.len(),
                    track_id
                );
            }
        }

        if created_clip_count == 0 {
            return Err(DesktopError::AudioCommand(
                "no se pudieron convertir clips de Reaper".into(),
            ));
        }
        eprintln!(
            "[libretracks-import] arrangement materialized tracks_added={} clips_added={}",
            next_song
                .tracks
                .len()
                .saturating_sub(current_song.tracks.len()),
            created_clip_count
        );

        let is_empty_session = current_song.tracks.is_empty() && current_song.clips.is_empty();

        // Import full Reaper tempo map. For empty sessions, the first marker at
        // t=0 becomes the song base BPM and later points become tempo markers.
        if project.tempo_markers.is_empty() {
            if let Some(project_bpm) = project.bpm {
                if is_empty_session {
                    next_song.bpm = project_bpm;
                } else if (effective_bpm_at(&next_song, insert_at_seconds) - project_bpm).abs()
                    > 0.001
                {
                    upsert_imported_tempo_marker(&mut next_song, insert_at_seconds, project_bpm);
                }
            }
        } else {
            for tempo_marker in &project.tempo_markers {
                let marker_start_seconds = insert_at_seconds + tempo_marker.start_seconds.max(0.0);
                if is_empty_session && marker_start_seconds <= 0.0001 {
                    next_song.bpm = tempo_marker.bpm;
                } else {
                    upsert_imported_tempo_marker(
                        &mut next_song,
                        marker_start_seconds,
                        tempo_marker.bpm,
                    );
                }
            }
        }

        // Import full Reaper time signature map with strict ordering guarantees.
        if project.time_signature_markers.is_empty() {
            if let Some(time_signature) = project.time_signature.as_ref() {
                if is_empty_session {
                    next_song.time_signature = time_signature.clone();
                } else {
                    upsert_imported_time_signature_marker(
                        &mut next_song,
                        insert_at_seconds,
                        time_signature,
                    );
                }
            }
        } else {
            for time_signature_marker in &project.time_signature_markers {
                let marker_start_seconds =
                    insert_at_seconds + time_signature_marker.start_seconds.max(0.0);
                if is_empty_session && marker_start_seconds <= 0.0001 {
                    next_song.time_signature = time_signature_marker.signature.clone();
                } else {
                    upsert_imported_time_signature_marker(
                        &mut next_song,
                        marker_start_seconds,
                        &time_signature_marker.signature,
                    );
                }
            }
        }

        for section_marker in &project.section_markers {
            append_imported_section_marker(
                &mut next_song,
                insert_at_seconds + section_marker.start_seconds.max(0.0),
                &section_marker.name,
            );
        }

        if project.regions.is_empty() {
            next_song.regions.push(SongRegion {
                id: format!("region_import_{}", timestamp_suffix()),
                name: project.title.clone(),
                start_seconds: insert_at_seconds,
                end_seconds: insert_at_seconds + project.duration_seconds.max(1.0),
                transpose_semitones: 0,
                key: None,
                warp_enabled: false,
                warp_source_bpm: None,
                master: libretracks_core::SongMaster::default(),
            });
        } else {
            for imported_region in &project.regions {
                next_song.regions.push(SongRegion {
                    id: format!("region_import_{}", timestamp_suffix()),
                    name: imported_region.name.clone(),
                    start_seconds: insert_at_seconds + imported_region.start_seconds.max(0.0),
                    end_seconds: insert_at_seconds
                        + imported_region
                            .end_seconds
                            .max(imported_region.start_seconds + 0.001),
                    transpose_semitones: 0,
                    key: None,
                    warp_enabled: false,
                    warp_source_bpm: None,
                    master: libretracks_core::SongMaster::default(),
                });
            }
        }

        normalize_imported_section_markers(&mut next_song.section_markers);
        ensure_unique_imported_song_entity_ids(&mut next_song);
        next_song.regions.sort_by(|left, right| {
            left.start_seconds
                .partial_cmp(&right.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        next_song.duration_seconds = next_song
            .duration_seconds
            .max(insert_at_seconds + project.duration_seconds.max(1.0));

        // Engine session validation requires markers to be strictly inside the
        // song range (`marker.frame < song.end_frame`) and regions to be
        // bounded by song end. External DAWs often place a marker exactly at
        // project end, so clamp imported boundaries to a safe epsilon.
        let max_timeline_seconds = (next_song.duration_seconds - 0.001).max(0.0);
        for marker in &mut next_song.section_markers {
            marker.start_seconds = marker.start_seconds.clamp(0.0, max_timeline_seconds);
        }
        next_song.regions.retain_mut(|region| {
            let start = region.start_seconds.clamp(0.0, max_timeline_seconds);
            let mut end = region.end_seconds.max(start + 0.001);
            if end > next_song.duration_seconds {
                end = next_song.duration_seconds;
            }
            if end <= start {
                return false;
            }
            region.start_seconds = start;
            region.end_seconds = end;
            true
        });
        normalize_imported_section_markers(&mut next_song.section_markers);
        ensure_unique_imported_song_entity_ids(&mut next_song);

        // A clip may not cross a region (song) boundary — the engine rejects it.
        // Reaper region END boundaries don't always coincide with the audio item
        // lengths (e.g. a click item is a few ms longer than the region), and
        // when several songs sit on the timeline a clip that overruns its
        // region's end invades the next song. Reconcile: split any clip that
        // straddles a region boundary, then grow each region's end to cover the
        // clips that start inside it (bounded by the next region's start).
        reconcile_regions_and_clips(&mut next_song);

        eprintln!("[libretracks-import] persisting song update (structure rebuild)");
        self.persist_song_update(next_song, audio, AudioChangeImpact::StructureRebuild, true)?;
        eprintln!("[libretracks-import] persist_song_update completed");

        let loaded_song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        self.prime_waveform_cache(&song_dir, &loaded_song)?;
        eprintln!(
            "[libretracks-import] deferred post-import source/waveform preparation (non-blocking)"
        );
        eprintln!(
            "[libretracks-import] deferred eager playback prearm after external import (non-blocking)"
        );

        let library_assets = list_library_assets(&song_dir, self.engine.song())?;
        eprintln!(
            "[libretracks-import] import_reaper_project done assets={} total_ms={}",
            library_assets.len(),
            started_at.elapsed().as_millis()
        );
        Ok(SongPackageImportResponse {
            snapshot: self.snapshot(),
            library_assets,
        })
    }
}

fn normalize_external_source_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
}

fn unique_song_entity_id(prefix: &str, seed: &str, used: &mut HashSet<String>) -> String {
    let slug_seed = slugify(seed);
    let base = if slug_seed.is_empty() {
        "item"
    } else {
        &slug_seed
    };
    let mut index = 0_u32;
    loop {
        let candidate = if index == 0 {
            format!("{prefix}_{base}")
        } else {
            format!("{prefix}_{base}_{index}")
        };
        if used.insert(candidate.clone()) {
            return candidate;
        }
        index += 1;
    }
}

fn upsert_imported_tempo_marker(song: &mut Song, start_seconds: f64, bpm: f64) {
    let start_seconds = start_seconds.max(0.0);
    if let Some(existing_marker) = song
        .tempo_markers
        .iter_mut()
        .find(|marker| (marker.start_seconds - start_seconds).abs() <= 0.0001)
    {
        existing_marker.bpm = bpm;
        return;
    }

    song.tempo_markers.push(TempoMarker {
        id: format!("tempo_marker_import_{}", timestamp_suffix()),
        start_seconds,
        bpm,
    });
    song.tempo_markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

fn upsert_imported_time_signature_marker(song: &mut Song, start_seconds: f64, signature: &str) {
    let start_seconds = start_seconds.max(0.0);

    if start_seconds <= 0.0001 {
        song.time_signature = signature.to_string();
        return;
    }

    if let Some(existing_marker) = song
        .time_signature_markers
        .iter_mut()
        .find(|marker| (marker.start_seconds - start_seconds).abs() <= 0.0001)
    {
        existing_marker.signature = signature.to_string();
        return;
    }

    song.time_signature_markers.push(TimeSignatureMarker {
        id: format!("time_signature_marker_import_{}", timestamp_suffix()),
        start_seconds,
        signature: signature.to_string(),
    });
    song.time_signature_markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

fn append_imported_section_marker(song: &mut Song, start_seconds: f64, name: &str) {
    let start_seconds = start_seconds.max(0.0);
    if song
        .section_markers
        .iter()
        .any(|marker| (marker.start_seconds - start_seconds).abs() <= 0.0001)
    {
        return;
    }

    song.section_markers.push(Marker {
        id: format!("marker_import_{}", timestamp_suffix()),
        name: name.trim().to_string(),
        start_seconds,
        digit: None,
        // Imported markers carry only a freeform label from the external DAW, so
        // they land as untyped Custom sections (kind palette / voice bank fall
        // back to the base). The user can retag them afterwards.
        kind: MarkerKind::Custom,
        variant: None,
        color: None,
    });
}

fn normalize_imported_section_markers(markers: &mut Vec<Marker>) {
    markers.sort_by(|left, right| {
        left.start_seconds
            .partial_cmp(&right.start_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut deduped = Vec::<Marker>::new();
    for marker in markers.drain(..) {
        if deduped
            .iter()
            .any(|existing| (existing.start_seconds - marker.start_seconds).abs() <= 0.0001)
        {
            continue;
        }
        deduped.push(marker);
    }

    *markers = deduped;
}

fn ensure_unique_imported_song_entity_ids(song: &mut Song) {
    let mut used = HashSet::<String>::new();

    used.insert(song.id.clone());
    for track in &song.tracks {
        used.insert(track.id.clone());
    }
    for clip in &song.clips {
        used.insert(clip.id.clone());
    }

    for marker in &mut song.section_markers {
        if marker.id.trim().is_empty() || !used.insert(marker.id.clone()) {
            marker.id = unique_song_entity_id("marker_import", &marker.name, &mut used);
        }
    }

    for region in &mut song.regions {
        if region.id.trim().is_empty() || !used.insert(region.id.clone()) {
            region.id = unique_song_entity_id("region_import", &region.name, &mut used);
        }
    }

    for marker in &mut song.tempo_markers {
        if marker.id.trim().is_empty() || !used.insert(marker.id.clone()) {
            marker.id = unique_song_entity_id(
                "tempo_marker_import",
                &format!("{:.3}", marker.start_seconds),
                &mut used,
            );
        }
    }

    for marker in &mut song.time_signature_markers {
        if marker.id.trim().is_empty() || !used.insert(marker.id.clone()) {
            marker.id =
                unique_song_entity_id("time_signature_marker_import", &marker.signature, &mut used);
        }
    }
}
