//! Identity of a prepared render: one track already put through warp and
//! pitch, so playback can read it instead of running the stretcher.
//!
//! Not to be confused with [`crate::prepared_audio`], which decodes a source
//! to PCM at export time and applies no DSP at all. That one moves decoding
//! off the receiving device; this one moves the stretcher off the audio
//! thread. They share a word and nothing else.
//!
//! A prepared render only works if we can tell, cheaply and without listening
//! to it, whether the file still matches the session. This module answers that
//! and nothing else: it computes the key, writes and reads the manifest, and
//! decides whether a file on disk is still usable. Rendering, scheduling and
//! quotas live elsewhere.
//!
//! # What the audio actually depends on
//!
//! The bench prototype's key covered the source, the warp ratio, the semitones,
//! the buffer and the format — and missed everything about the clips. That was
//! wrong: the renderer bakes clip gain, fades, offsets and length into the
//! output (`effective_gain = track gain × clip gain` in `track_renderer.cpp`),
//! so editing a clip's gain would have left the old audio playing. Everything
//! the renderer bakes has to be in the key, and everything the mixer applies
//! afterwards — track gain, pan, mute, solo, master — must NOT be, because
//! those stay live controls over the prepared file.
//!
//! # Two deliberate approximations
//!
//! **Sources are identified by size and mtime, not by content.** Hashing
//! gigabytes on every session load is not affordable, and this is the same
//! trade-off [`crate::waveform`] already makes for peak caches. A source
//! replaced with a same-size file within the same millisecond would go
//! undetected; in exchange, opening a session costs one `stat` per clip.
//!
//! **Times are quantized to frames and floats enter the key as raw bits.**
//! Frames because the engine bakes the timeline that way, so two sessions that
//! differ below a frame genuinely produce the same audio. Raw bits because
//! comparing floats with a tolerance risks the unsafe direction: the failure
//! mode here must always be regenerating a file we did not need to, never
//! reusing one we should have thrown away.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use libretracks_core::model::{Song, TrackKind};

/// Bumped whenever the meaning of a key or the layout of a prepared file
/// changes. Every existing file becomes unusable, which is the point.
pub const PREPARED_RENDER_VERSION: u32 = 1;

/// Sample format of the prepared audio on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreparedRenderFormat {
    /// 16-bit PCM, the format the decode cache already uses. Half the disk of
    /// float32, with the quantization floor 80 dB under the programme — but it
    /// has a ceiling, and warp raises peaks, so `clipped_samples` matters.
    Pcm16,
    /// 32-bit float. No ceiling, twice the disk.
    Float32,
}

impl PreparedRenderFormat {
    pub fn bytes_per_sample(self) -> u64 {
        match self {
            PreparedRenderFormat::Pcm16 => 2,
            PreparedRenderFormat::Float32 => 4,
        }
    }

    fn tag(self) -> u8 {
        match self {
            PreparedRenderFormat::Pcm16 => 1,
            PreparedRenderFormat::Float32 => 2,
        }
    }
}

/// How a source file is recognised. See the module note on approximations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSignature {
    /// Path as the session stores it, so moving a session does not invalidate.
    pub relative_path: String,
    pub size: u64,
    pub modified_millis: u128,
}

impl SourceSignature {
    /// Reads the signature from disk. A file that cannot be stat'd yields zeros,
    /// which is a distinct key from any real file: an unreadable source must
    /// never collide with the readable one it used to be.
    pub fn read(song_dir: &Path, relative_path: &str) -> Self {
        let absolute = song_dir.join(relative_path);
        let (size, modified_millis) = match fs::metadata(&absolute) {
            Ok(metadata) => (
                metadata.len(),
                metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|since| since.as_millis())
                    .unwrap_or(0),
            ),
            Err(_) => (0, 0),
        };
        Self {
            relative_path: relative_path.to_string(),
            size,
            modified_millis,
        }
    }
}

/// One audio clip, in the terms the renderer actually consumes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRenderClip {
    pub source: SourceSignature,
    pub timeline_start_frames: i64,
    pub source_start_frames: i64,
    pub length_frames: i64,
    pub gain: f64,
    pub fade_in_frames: i64,
    pub fade_out_frames: i64,
}

/// The region parameters that reach the stretcher.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRenderRegion {
    pub start_frames: i64,
    pub end_frames: i64,
    pub transpose_semitones: i32,
    pub warp_enabled: bool,
    pub warp_source_bpm: Option<f64>,
}

/// A tempo change. Warp stretches the source so its own tempo lines up with the
/// timeline's, so the tempo map is an input to the audio, not just to the grid.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRenderTempo {
    pub start_frames: i64,
    pub bpm: f64,
}

/// How the prepared file is written, and by what. Grouped rather than passed as
/// four loose arguments: the order of a sample rate, a channel count and a
/// format is exactly the kind of thing a caller gets wrong silently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedRenderOutput {
    pub sample_rate: u32,
    pub channels: u16,
    pub format: PreparedRenderFormat,
    /// Identity of the DSP that produced the audio. A different stretcher, or a
    /// change to how the renderer feeds it, must invalidate every file: the
    /// audio would be different and nothing else in the spec would say so.
    pub dsp_identity: String,
}

/// Everything one prepared track file depends on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRenderSpec {
    pub track_id: String,
    /// Whether the region's transposition reaches this track at all.
    pub transpose_enabled: bool,
    pub sample_rate: u32,
    pub channels: u16,
    pub format: PreparedRenderFormat,
    pub clips: Vec<PreparedRenderClip>,
    pub regions: Vec<PreparedRenderRegion>,
    pub tempo: Vec<PreparedRenderTempo>,
    /// See [`PreparedRenderOutput::dsp_identity`].
    pub dsp_identity: String,
}

fn seconds_to_frames(seconds: f64, sample_rate: u32) -> i64 {
    if !seconds.is_finite() {
        return 0;
    }
    (seconds * f64::from(sample_rate.max(1))).round() as i64
}

impl PreparedRenderSpec {
    /// Builds the spec for one track of a song, reading source signatures from
    /// disk relative to `song_dir`.
    ///
    /// Regions and tempo markers are narrowed to the track's own clip span: a
    /// session with ten songs should not regenerate every prepared file because
    /// the user edited a region that this track never reaches. The tempo marker
    /// immediately before the span is kept, because tempo is a step function and
    /// that marker sets the tempo the span starts at.
    pub fn from_song(
        song: &Song,
        track_id: &str,
        song_dir: &Path,
        output: &PreparedRenderOutput,
    ) -> Option<Self> {
        let sample_rate = output.sample_rate;
        let track = song.tracks.iter().find(|track| track.id == track_id)?;
        if track.kind != TrackKind::Audio {
            return None;
        }

        let mut clips: Vec<PreparedRenderClip> = song
            .clips
            .iter()
            .filter(|clip| clip.track_id == track_id)
            .map(|clip| PreparedRenderClip {
                source: SourceSignature::read(song_dir, &clip.file_path),
                timeline_start_frames: seconds_to_frames(clip.timeline_start_seconds, sample_rate),
                source_start_frames: seconds_to_frames(clip.source_start_seconds, sample_rate),
                length_frames: seconds_to_frames(clip.duration_seconds, sample_rate),
                gain: clip.gain,
                fade_in_frames: seconds_to_frames(clip.fade_in_seconds.unwrap_or(0.0), sample_rate),
                fade_out_frames: seconds_to_frames(
                    clip.fade_out_seconds.unwrap_or(0.0),
                    sample_rate,
                ),
            })
            .collect();
        if clips.is_empty() {
            return None;
        }
        // Clip order in the session is an editing artefact, not audio: two
        // sessions whose clip lists differ only in order render the same file.
        clips.sort_by(|a, b| {
            a.timeline_start_frames
                .cmp(&b.timeline_start_frames)
                .then_with(|| a.source.relative_path.cmp(&b.source.relative_path))
                .then_with(|| a.source_start_frames.cmp(&b.source_start_frames))
        });

        let span_start = clips
            .iter()
            .map(|clip| clip.timeline_start_frames)
            .min()
            .unwrap_or(0);
        let span_end = clips
            .iter()
            .map(|clip| clip.timeline_start_frames + clip.length_frames.max(0))
            .max()
            .unwrap_or(0);

        let mut regions: Vec<PreparedRenderRegion> = song
            .regions
            .iter()
            .map(|region| PreparedRenderRegion {
                start_frames: seconds_to_frames(region.start_seconds, sample_rate),
                end_frames: seconds_to_frames(region.end_seconds, sample_rate),
                transpose_semitones: region.transpose_semitones,
                warp_enabled: region.warp_enabled,
                warp_source_bpm: region.warp_source_bpm,
            })
            .filter(|region| region.end_frames > span_start && region.start_frames < span_end)
            .collect();
        regions.sort_by_key(|region| region.start_frames);

        let mut tempo: Vec<PreparedRenderTempo> = song
            .tempo_markers
            .iter()
            .map(|marker| PreparedRenderTempo {
                start_frames: seconds_to_frames(marker.start_seconds, sample_rate),
                bpm: marker.bpm,
            })
            .collect();
        tempo.sort_by_key(|marker| marker.start_frames);
        let carried_in = tempo
            .iter()
            .rposition(|marker| marker.start_frames <= span_start);
        let first_kept = carried_in.unwrap_or(0);
        tempo.retain(|marker| marker.start_frames < span_end);
        if first_kept > 0 {
            tempo.drain(..first_kept.min(tempo.len()));
        }

        Some(Self {
            track_id: track_id.to_string(),
            transpose_enabled: track.transpose_enabled,
            sample_rate,
            channels: output.channels,
            format: output.format,
            clips,
            regions,
            tempo,
            dsp_identity: output.dsp_identity.clone(),
        })
    }

    /// SHA-256 over an explicit encoding of every field, in a fixed order.
    ///
    /// Hand-rolled rather than hashing the serde output: the key has to stay
    /// stable, and serialization is free to change how it renders a float or a
    /// field name. What is stable here is what this function writes.
    pub fn key(&self) -> String {
        let mut hasher = Sha256::new();
        let mut field = |bytes: &[u8]| {
            // Length-prefixed so ("ab","c") can never hash like ("a","bc").
            hasher.update((bytes.len() as u64).to_le_bytes());
            hasher.update(bytes);
        };
        field(&PREPARED_RENDER_VERSION.to_le_bytes());
        field(self.track_id.as_bytes());
        field(&[u8::from(self.transpose_enabled)]);
        field(&self.sample_rate.to_le_bytes());
        field(&self.channels.to_le_bytes());
        field(&[self.format.tag()]);
        field(self.dsp_identity.as_bytes());

        field(&(self.clips.len() as u64).to_le_bytes());
        for clip in &self.clips {
            field(clip.source.relative_path.as_bytes());
            field(&clip.source.size.to_le_bytes());
            field(&clip.source.modified_millis.to_le_bytes());
            field(&clip.timeline_start_frames.to_le_bytes());
            field(&clip.source_start_frames.to_le_bytes());
            field(&clip.length_frames.to_le_bytes());
            field(&clip.gain.to_bits().to_le_bytes());
            field(&clip.fade_in_frames.to_le_bytes());
            field(&clip.fade_out_frames.to_le_bytes());
        }

        field(&(self.regions.len() as u64).to_le_bytes());
        for region in &self.regions {
            field(&region.start_frames.to_le_bytes());
            field(&region.end_frames.to_le_bytes());
            field(&region.transpose_semitones.to_le_bytes());
            field(&[u8::from(region.warp_enabled)]);
            // An absent tempo and a tempo of zero are different sessions.
            match region.warp_source_bpm {
                Some(bpm) => {
                    field(&[1]);
                    field(&bpm.to_bits().to_le_bytes());
                }
                None => field(&[0]),
            }
        }

        field(&(self.tempo.len() as u64).to_le_bytes());
        for marker in &self.tempo {
            field(&marker.start_frames.to_le_bytes());
            field(&marker.bpm.to_bits().to_le_bytes());
        }

        format!("{:x}", hasher.finalize())
    }
}

/// What a prepared file on disk claims to be.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRenderManifest {
    pub version: u32,
    pub key: String,
    pub track_id: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub format: PreparedRenderFormat,
    /// Where the prepared audio starts on the timeline. The file covers the
    /// track's own clip span, not the whole song: a ten-second clip in a
    /// five-minute song must not cost five minutes of silence on disk.
    pub timeline_start_frames: i64,
    pub frames: u64,
    pub output_bytes: u64,
    /// Samples the format's ceiling had to clamp. Warp and pitch raise peaks
    /// above the source's, so a hot stem can reach it in PCM16; a non-zero
    /// count means the file carries distortion, not just quantization noise.
    #[serde(default)]
    pub clipped_samples: u64,
    pub created_millis: u128,
}

pub fn prepared_render_dir(song_dir: impl AsRef<Path>) -> PathBuf {
    song_dir.as_ref().join("cache").join("prepared")
}

/// Audio and manifest paths for a key. The key alone names the file: it is hex,
/// so it is always a legal filename, and it already covers the track id.
pub fn prepared_render_audio_path(song_dir: impl AsRef<Path>, key: &str) -> PathBuf {
    prepared_render_dir(song_dir).join(format!("{key}.ltprep.wav"))
}

pub fn prepared_render_manifest_path(song_dir: impl AsRef<Path>, key: &str) -> PathBuf {
    prepared_render_dir(song_dir).join(format!("{key}.ltprep.json"))
}

/// Why a prepared file cannot be used. Returned instead of a bare bool so the
/// caller can tell "never prepared" from "prepared and now stale", which are
/// different things to report and to act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreparedRenderRejection {
    Missing,
    UnreadableManifest,
    WrongVersion { found: u32 },
    KeyMismatch,
    AudioMissing,
    SizeMismatch { expected: u64, found: u64 },
}

/// Loads the manifest for a spec and checks the file on disk still matches it.
///
/// The source files are not re-checked here: `spec` is built by reading them,
/// so a source edited since the file was prepared already produces a different
/// key and fails the key check above.
pub fn load_usable_prepared_render(
    song_dir: impl AsRef<Path>,
    spec: &PreparedRenderSpec,
) -> Result<PreparedRenderManifest, PreparedRenderRejection> {
    let song_dir = song_dir.as_ref();
    let key = spec.key();
    let manifest_path = prepared_render_manifest_path(song_dir, &key);
    let raw = match fs::read_to_string(&manifest_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(PreparedRenderRejection::Missing)
        }
        Err(_) => return Err(PreparedRenderRejection::UnreadableManifest),
    };
    let manifest: PreparedRenderManifest =
        serde_json::from_str(&raw).map_err(|_| PreparedRenderRejection::UnreadableManifest)?;
    if manifest.version != PREPARED_RENDER_VERSION {
        return Err(PreparedRenderRejection::WrongVersion {
            found: manifest.version,
        });
    }
    if manifest.key != key {
        return Err(PreparedRenderRejection::KeyMismatch);
    }
    let audio_path = prepared_render_audio_path(song_dir, &key);
    let metadata = fs::metadata(&audio_path).map_err(|_| PreparedRenderRejection::AudioMissing)?;
    if metadata.len() != manifest.output_bytes {
        return Err(PreparedRenderRejection::SizeMismatch {
            expected: manifest.output_bytes,
            found: metadata.len(),
        });
    }
    Ok(manifest)
}

/// Writes the manifest last, and through a temporary file, so a reader can
/// never find a manifest pointing at audio that is still being written or was
/// interrupted. A prepared file without its manifest is invisible and gets
/// swept up as an orphan; the other order would hand out truncated audio.
pub fn publish_prepared_render_manifest(
    song_dir: impl AsRef<Path>,
    manifest: &PreparedRenderManifest,
) -> std::io::Result<()> {
    let song_dir = song_dir.as_ref();
    fs::create_dir_all(prepared_render_dir(song_dir))?;
    let final_path = prepared_render_manifest_path(song_dir, &manifest.key);
    let temporary = final_path.with_extension("json.tmp");
    let encoded = serde_json::to_vec_pretty(manifest)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    fs::write(&temporary, encoded)?;
    fs::rename(&temporary, &final_path)
}

/// Prepared files whose key no longer matches any live spec, with their sizes.
/// Callers use this to reclaim disk; nothing here deletes anything.
pub fn orphaned_prepared_render_files(
    song_dir: impl AsRef<Path>,
    live_keys: &[String],
) -> Vec<(PathBuf, u64)> {
    let directory = prepared_render_dir(song_dir);
    let Ok(entries) = fs::read_dir(&directory) else {
        return Vec::new();
    };
    let mut orphans = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(key) = name
            .strip_suffix(".ltprep.wav")
            .or_else(|| name.strip_suffix(".ltprep.json"))
        else {
            continue;
        };
        if live_keys.iter().any(|live| live == key) {
            continue;
        }
        let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        orphans.push((path, size));
    }
    orphans.sort();
    orphans
}

pub fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::{Clip, SongMaster, SongRegion, TempoMarker, Track, TrackKind};
    use std::fs;
    use tempfile::TempDir;

    const DSP: &str = "engine-1+bungee-2.4.24";

    fn song_dir_with_source(bytes: usize) -> TempDir {
        let dir = TempDir::new().expect("tempdir");
        fs::create_dir_all(dir.path().join("audio")).expect("audio dir");
        fs::write(dir.path().join("audio/x.wav"), vec![7u8; bytes]).expect("source");
        dir
    }

    fn track(id: &str) -> Track {
        Track {
            id: id.into(),
            name: id.into(),
            kind: TrackKind::Audio,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: true,
            audio_to: "master".into(),
            color: None,
            auto_created: false,
            midi_port: None,
            midi_channel: 1,
            midi_enabled: true,
            collapsed: false,
            height_offset: None,
        }
    }

    fn clip(id: &str, start: f64, duration: f64) -> Clip {
        Clip {
            id: id.into(),
            track_id: "t1".into(),
            file_path: "audio/x.wav".into(),
            timeline_start_seconds: start,
            source_start_seconds: 0.0,
            duration_seconds: duration,
            gain: 1.0,
            fade_in_seconds: None,
            fade_out_seconds: None,
            color: None,
        }
    }

    fn region(start: f64, end: f64) -> SongRegion {
        SongRegion {
            id: "r1".into(),
            name: "R1".into(),
            start_seconds: start,
            end_seconds: end,
            transpose_semitones: 0,
            key: None,
            warp_enabled: true,
            warp_source_bpm: Some(100.0),
            master: SongMaster::default(),
            compact_column_width_rem: None,
        }
    }

    fn base_song() -> Song {
        Song {
            id: "song".into(),
            title: "Song".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 60.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![region(0.0, 60.0)],
            tracks: vec![track("t1")],
            clips: vec![clip("c1", 0.0, 30.0)],
            midi_clips: vec![],
            section_markers: vec![],
        }
    }

    fn output(rate: u32, format: PreparedRenderFormat, dsp: &str) -> PreparedRenderOutput {
        PreparedRenderOutput {
            sample_rate: rate,
            channels: 2,
            format,
            dsp_identity: dsp.into(),
        }
    }

    fn spec_for(song: &Song, dir: &TempDir) -> PreparedRenderSpec {
        PreparedRenderSpec::from_song(
            song,
            "t1",
            dir.path(),
            &output(48_000, PreparedRenderFormat::Pcm16, DSP),
        )
        .expect("spec")
    }

    type Mutation = (&'static str, Box<dyn Fn(&mut Song)>);

    /// Every edit here changes what the renderer writes, so every one has to
    /// change the key. Clip gain is the one the bench prototype's key missed:
    /// the renderer bakes `track gain x clip gain`, so editing it would have
    /// left the old audio playing.
    #[test]
    fn every_edit_the_renderer_bakes_changes_the_key() {
        let dir = song_dir_with_source(1024);
        let base = base_song();
        let original = spec_for(&base, &dir).key();

        let mutations: Vec<Mutation> = vec![
            ("clip gain", Box::new(|s: &mut Song| s.clips[0].gain = 0.5)),
            (
                "clip timeline position",
                Box::new(|s: &mut Song| s.clips[0].timeline_start_seconds = 1.0),
            ),
            (
                "clip source offset",
                Box::new(|s: &mut Song| s.clips[0].source_start_seconds = 2.0),
            ),
            (
                "clip length",
                Box::new(|s: &mut Song| s.clips[0].duration_seconds = 29.0),
            ),
            (
                "clip fade in",
                Box::new(|s: &mut Song| s.clips[0].fade_in_seconds = Some(0.5)),
            ),
            (
                "clip fade out",
                Box::new(|s: &mut Song| s.clips[0].fade_out_seconds = Some(0.5)),
            ),
            (
                "a second clip",
                Box::new(|s: &mut Song| s.clips.push(clip("c2", 40.0, 5.0))),
            ),
            (
                "region transposition",
                Box::new(|s: &mut Song| s.regions[0].transpose_semitones = 3),
            ),
            (
                "region warp toggle",
                Box::new(|s: &mut Song| s.regions[0].warp_enabled = false),
            ),
            (
                "region source tempo",
                Box::new(|s: &mut Song| s.regions[0].warp_source_bpm = Some(90.0)),
            ),
            (
                "region source tempo cleared",
                Box::new(|s: &mut Song| s.regions[0].warp_source_bpm = None),
            ),
            (
                "track transposition disabled",
                Box::new(|s: &mut Song| s.tracks[0].transpose_enabled = false),
            ),
            (
                "a tempo marker inside the span",
                Box::new(|s: &mut Song| {
                    s.tempo_markers.push(TempoMarker {
                        id: "m1".into(),
                        start_seconds: 10.0,
                        bpm: 140.0,
                    })
                }),
            ),
        ];

        for (name, mutate) in mutations {
            let mut song = base.clone();
            mutate(&mut song);
            assert_ne!(
                original,
                spec_for(&song, &dir).key(),
                "{name} must invalidate the prepared render"
            );
        }
    }

    /// The other half of the contract. These are applied by the mixer AFTER the
    /// prepared file is read, so baking them would be a bug and invalidating on
    /// them would throw away good audio every time a fader moves.
    #[test]
    fn mixer_controls_never_change_the_key() {
        let dir = song_dir_with_source(1024);
        let base = base_song();
        let original = spec_for(&base, &dir).key();

        let mutations: Vec<Mutation> = vec![
            (
                "track volume",
                Box::new(|s: &mut Song| s.tracks[0].volume = 0.25),
            ),
            ("track pan", Box::new(|s: &mut Song| s.tracks[0].pan = -1.0)),
            ("track mute", Box::new(|s: &mut Song| s.tracks[0].muted = true)),
            ("track solo", Box::new(|s: &mut Song| s.tracks[0].solo = true)),
            (
                "region master gain",
                Box::new(|s: &mut Song| s.regions[0].master = SongMaster { gain: 0.3 }),
            ),
            (
                "track colour",
                Box::new(|s: &mut Song| s.tracks[0].color = Some("#ff0000".into())),
            ),
            (
                "song title",
                Box::new(|s: &mut Song| s.title = "Other".into()),
            ),
        ];

        for (name, mutate) in mutations {
            let mut song = base.clone();
            mutate(&mut song);
            assert_eq!(
                original,
                spec_for(&song, &dir).key(),
                "{name} is a live control and must not invalidate the prepared render"
            );
        }
    }

    #[test]
    fn editing_the_source_file_invalidates_but_reordering_clips_does_not() {
        let dir = song_dir_with_source(1024);
        let mut song = base_song();
        song.clips.push(clip("c2", 40.0, 5.0));
        let original = spec_for(&song, &dir).key();

        let mut reordered = song.clone();
        reordered.clips.reverse();
        assert_eq!(
            original,
            spec_for(&reordered, &dir).key(),
            "clip order in the session is an editing artefact, not audio"
        );

        // A source replaced with a different one must never keep playing from
        // the old prepared file.
        fs::write(dir.path().join("audio/x.wav"), vec![7u8; 2048]).expect("rewrite source");
        assert_ne!(original, spec_for(&song, &dir).key());
    }

    #[test]
    fn a_tempo_marker_the_track_never_reaches_does_not_invalidate_it() {
        let dir = song_dir_with_source(1024);
        let song = base_song();
        let original = spec_for(&song, &dir).key();

        let mut later = song.clone();
        later.tempo_markers.push(TempoMarker {
            id: "far".into(),
            start_seconds: 45.0,
            bpm: 200.0,
        });
        assert_eq!(
            original,
            spec_for(&later, &dir).key(),
            "a tempo change after the track ends cannot alter its audio"
        );

        // But the marker that sets the tempo the span STARTS at does matter,
        // even though it sits before the first clip.
        let mut carried = song.clone();
        carried.clips = vec![clip("c1", 20.0, 10.0)];
        let mut with_early_marker = carried.clone();
        with_early_marker.tempo_markers.push(TempoMarker {
            id: "early".into(),
            start_seconds: 5.0,
            bpm: 90.0,
        });
        assert_ne!(
            spec_for(&carried, &dir).key(),
            spec_for(&with_early_marker, &dir).key(),
            "the tempo carried into the span is an input to the warp ratio"
        );
    }

    #[test]
    fn output_settings_and_dsp_identity_are_part_of_the_key() {
        let dir = song_dir_with_source(1024);
        let song = base_song();
        let base = spec_for(&song, &dir).key();

        let build = |rate: u32, format: PreparedRenderFormat, dsp: &str| {
            PreparedRenderSpec::from_song(&song, "t1", dir.path(), &output(rate, format, dsp))
                .expect("spec")
                .key()
        };
        assert_ne!(base, build(48_000, PreparedRenderFormat::Float32, DSP));
        assert_ne!(base, build(44_100, PreparedRenderFormat::Pcm16, DSP));
        assert_ne!(
            base,
            build(48_000, PreparedRenderFormat::Pcm16, "engine-2+bungee-2.4.24"),
            "a different stretcher produces different audio and nothing else says so"
        );
    }

    #[test]
    fn a_track_without_audio_clips_has_nothing_to_prepare() {
        let dir = song_dir_with_source(1024);
        let build = |song: &Song| {
            PreparedRenderSpec::from_song(
                song,
                "t1",
                dir.path(),
                &output(48_000, PreparedRenderFormat::Pcm16, DSP),
            )
        };

        let mut empty = base_song();
        empty.clips.clear();
        assert!(build(&empty).is_none());

        let mut folder = base_song();
        folder.tracks[0].kind = TrackKind::Folder;
        assert!(build(&folder).is_none());
    }

    fn manifest_for(spec: &PreparedRenderSpec, bytes: u64) -> PreparedRenderManifest {
        PreparedRenderManifest {
            version: PREPARED_RENDER_VERSION,
            key: spec.key(),
            track_id: spec.track_id.clone(),
            timeline_start_frames: 0,
            sample_rate: spec.sample_rate,
            channels: spec.channels,
            format: spec.format,
            frames: bytes / 4,
            output_bytes: bytes,
            clipped_samples: 0,
            created_millis: now_millis(),
        }
    }

    fn publish(dir: &TempDir, spec: &PreparedRenderSpec, bytes: u64) -> PreparedRenderManifest {
        let manifest = manifest_for(spec, bytes);
        fs::create_dir_all(prepared_render_dir(dir.path())).expect("cache dir");
        fs::write(
            prepared_render_audio_path(dir.path(), &manifest.key),
            vec![0u8; bytes as usize],
        )
        .expect("audio");
        publish_prepared_render_manifest(dir.path(), &manifest).expect("manifest");
        manifest
    }

    #[test]
    fn a_published_render_is_usable_until_something_makes_it_stale() {
        let dir = song_dir_with_source(1024);
        let song = base_song();
        let spec = spec_for(&song, &dir);
        assert_eq!(
            load_usable_prepared_render(dir.path(), &spec),
            Err(PreparedRenderRejection::Missing)
        );

        let manifest = publish(&dir, &spec, 512);
        assert_eq!(
            load_usable_prepared_render(dir.path(), &spec).expect("usable"),
            manifest
        );

        // An edit anywhere in the spec makes the key miss the file entirely.
        let mut edited = song.clone();
        edited.clips[0].gain = 0.5;
        assert_eq!(
            load_usable_prepared_render(dir.path(), &spec_for(&edited, &dir)),
            Err(PreparedRenderRejection::Missing),
            "a stale key must not resolve to the old file"
        );
    }

    #[test]
    fn a_truncated_or_mislabelled_file_is_refused() {
        let dir = song_dir_with_source(1024);
        let song = base_song();
        let spec = spec_for(&song, &dir);
        let manifest = publish(&dir, &spec, 512);

        // Truncated audio: the size the manifest promised is the only cheap
        // check standing between a half-written render and playback.
        fs::write(
            prepared_render_audio_path(dir.path(), &manifest.key),
            vec![0u8; 128],
        )
        .expect("truncate");
        assert_eq!(
            load_usable_prepared_render(dir.path(), &spec),
            Err(PreparedRenderRejection::SizeMismatch {
                expected: 512,
                found: 128
            })
        );

        // Audio gone entirely.
        fs::remove_file(prepared_render_audio_path(dir.path(), &manifest.key)).expect("remove");
        assert_eq!(
            load_usable_prepared_render(dir.path(), &spec),
            Err(PreparedRenderRejection::AudioMissing)
        );

        // A manifest from a future format version is not ours to interpret.
        let mut future = manifest.clone();
        future.version = PREPARED_RENDER_VERSION + 1;
        fs::write(
            prepared_render_manifest_path(dir.path(), &manifest.key),
            serde_json::to_vec(&future).expect("encode"),
        )
        .expect("write");
        assert_eq!(
            load_usable_prepared_render(dir.path(), &spec),
            Err(PreparedRenderRejection::WrongVersion {
                found: PREPARED_RENDER_VERSION + 1
            })
        );

        // Corrupted manifest.
        fs::write(
            prepared_render_manifest_path(dir.path(), &manifest.key),
            b"{ not json",
        )
        .expect("write");
        assert_eq!(
            load_usable_prepared_render(dir.path(), &spec),
            Err(PreparedRenderRejection::UnreadableManifest)
        );
    }

    #[test]
    fn files_no_live_key_claims_are_reported_as_orphans() {
        let dir = song_dir_with_source(1024);
        let song = base_song();
        let spec = spec_for(&song, &dir);
        let manifest = publish(&dir, &spec, 512);

        let mut stale = song.clone();
        stale.clips[0].gain = 0.5;
        let stale_manifest = publish(&dir, &spec_for(&stale, &dir), 256);

        let orphans = orphaned_prepared_render_files(dir.path(), std::slice::from_ref(&manifest.key));
        let names: Vec<String> = orphans
            .iter()
            .map(|(path, _)| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names
            .iter()
            .any(|name| name == &format!("{}.ltprep.wav", stale_manifest.key)));
        assert!(names
            .iter()
            .all(|name| !name.starts_with(&manifest.key)), "a live key is not an orphan");
        assert_eq!(
            orphans.iter().map(|(_, size)| *size).sum::<u64>(),
            256 + orphans
                .iter()
                .filter(|(path, _)| path.extension().and_then(|e| e.to_str()) == Some("json"))
                .map(|(_, size)| *size)
                .sum::<u64>(),
            "the reported sizes are what reclaiming them would free"
        );
    }
}
