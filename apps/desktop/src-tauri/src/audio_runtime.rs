use std::{
    fs::File,
    io::BufReader,
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, Sender},
    thread,
    time::Duration,
};

use libretracks_core::{Clip, Song};
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source};

use crate::state::DesktopError;

pub struct AudioRuntime {
    _stream: OutputStream,
    handle: OutputStreamHandle,
    sinks: Vec<ClipSink>,
}

pub struct AudioController {
    sender: Sender<AudioCommand>,
}

struct ClipSink {
    track_id: String,
    clip_gain: f32,
    sink: Sink,
}

#[derive(Debug, Clone, PartialEq)]
struct RuntimeClipSpec {
    clip_id: String,
    track_id: String,
    file_path: String,
    delay_seconds: f64,
    source_offset_seconds: f64,
    play_duration_seconds: f64,
    initial_gain: f64,
}

enum AudioCommand {
    Play {
        song_dir: PathBuf,
        song: Song,
        position_seconds: f64,
        respond_to: Sender<Result<(), String>>,
    },
    SyncSong {
        song: Song,
        respond_to: Sender<Result<(), String>>,
    },
    Stop {
        respond_to: Sender<Result<(), String>>,
    },
    Shutdown,
}

impl AudioRuntime {
    pub fn new() -> Result<Self, DesktopError> {
        let (stream, handle) = OutputStream::try_default()?;

        Ok(Self {
            _stream: stream,
            handle,
            sinks: Vec::new(),
        })
    }

    pub fn stop_all(&mut self) {
        for sink in self.sinks.drain(..) {
            sink.sink.stop();
        }
    }

    pub fn restart(
        &mut self,
        song_dir: &Path,
        song: &Song,
        position_seconds: f64,
    ) -> Result<(), DesktopError> {
        self.stop_all();

        for clip in build_runtime_clip_specs(song, position_seconds)? {
            let file = File::open(song_dir.join(&clip.file_path))?;
            let decoder = Decoder::new(BufReader::new(file))?;
            let source = decoder
                .skip_duration(Duration::from_secs_f64(clip.source_offset_seconds))
                .take_duration(Duration::from_secs_f64(clip.play_duration_seconds))
                .amplify(clip.initial_gain as f32);

            let sink = Sink::try_new(&self.handle)?;
            sink.pause();
            if clip.delay_seconds > 0.0 {
                sink.append(source.delay(Duration::from_secs_f64(clip.delay_seconds)));
            } else {
                sink.append(source);
            }
            self.sinks.push(ClipSink {
                track_id: clip.track_id,
                clip_gain: clip.initial_gain as f32,
                sink,
            });
        }

        for sink in &self.sinks {
            sink.sink.play();
        }

        Ok(())
    }

    pub fn sync_song(&mut self, song: &Song) -> Result<(), DesktopError> {
        for clip_sink in &self.sinks {
            let gain = resolve_track_clip_gain(song, &clip_sink.track_id, f64::from(clip_sink.clip_gain))?;
            clip_sink.sink.set_volume(gain as f32);
        }

        Ok(())
    }
}

impl AudioController {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::channel();

        thread::Builder::new()
            .name("libretracks-audio".into())
            .spawn(move || run_audio_thread(receiver))
            .expect("audio thread should start");

        Self { sender }
    }

    pub fn play(&self, song_dir: PathBuf, song: Song, position_seconds: f64) -> Result<(), DesktopError> {
        self.request(|respond_to| AudioCommand::Play {
            song_dir,
            song,
            position_seconds,
            respond_to,
        })
    }

    pub fn sync_song(&self, song: Song) -> Result<(), DesktopError> {
        self.request(|respond_to| AudioCommand::SyncSong { song, respond_to })
    }

    pub fn stop(&self) -> Result<(), DesktopError> {
        self.request(|respond_to| AudioCommand::Stop { respond_to })
    }

    fn request(
        &self,
        command: impl FnOnce(Sender<Result<(), String>>) -> AudioCommand,
    ) -> Result<(), DesktopError> {
        let (respond_to, response) = mpsc::channel();

        self.sender
            .send(command(respond_to))
            .map_err(|_| DesktopError::AudioThreadUnavailable)?;

        response
            .recv()
            .map_err(|_| DesktopError::AudioThreadUnavailable)?
            .map_err(DesktopError::AudioCommand)
    }
}

impl Default for AudioController {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for AudioController {
    fn drop(&mut self) {
        let _ = self.sender.send(AudioCommand::Shutdown);
    }
}

fn run_audio_thread(receiver: Receiver<AudioCommand>) {
    let mut runtime: Option<AudioRuntime> = None;

    while let Ok(command) = receiver.recv() {
        match command {
            AudioCommand::Play {
                song_dir,
                song,
                position_seconds,
                respond_to,
            } => {
                let result = ensure_runtime(&mut runtime)
                    .and_then(|runtime| runtime.restart(&song_dir, &song, position_seconds))
                    .map_err(|error| error.to_string());

                let _ = respond_to.send(result);
            }
            AudioCommand::SyncSong { song, respond_to } => {
                let result = ensure_runtime(&mut runtime)
                    .and_then(|runtime| runtime.sync_song(&song))
                    .map_err(|error| error.to_string());

                let _ = respond_to.send(result);
            }
            AudioCommand::Stop { respond_to } => {
                if let Some(runtime) = runtime.as_mut() {
                    runtime.stop_all();
                }

                let _ = respond_to.send(Ok(()));
            }
            AudioCommand::Shutdown => break,
        }
    }
}

fn ensure_runtime(runtime: &mut Option<AudioRuntime>) -> Result<&mut AudioRuntime, DesktopError> {
    if runtime.is_none() {
        *runtime = Some(AudioRuntime::new()?);
    }

    Ok(runtime.as_mut().expect("runtime should exist"))
}

fn build_runtime_clip_specs(
    song: &Song,
    position_seconds: f64,
) -> Result<Vec<RuntimeClipSpec>, DesktopError> {
    let mut specs = Vec::new();

    for clip in &song.clips {
        let clip_end = clip.timeline_start_seconds + clip.duration_seconds;
        if clip_end <= position_seconds {
            continue;
        }

        let elapsed_inside_clip = (position_seconds - clip.timeline_start_seconds).max(0.0);
        let remaining_duration = (clip.duration_seconds - elapsed_inside_clip).max(0.0);
        if remaining_duration <= 0.0 {
            continue;
        }

        specs.push(RuntimeClipSpec {
            clip_id: clip.id.clone(),
            track_id: clip.track_id.clone(),
            file_path: clip.file_path.clone(),
            delay_seconds: (clip.timeline_start_seconds - position_seconds).max(0.0),
            source_offset_seconds: clip.source_start_seconds + elapsed_inside_clip,
            play_duration_seconds: remaining_duration,
            initial_gain: resolve_clip_initial_gain(song, clip)?,
        });
    }

    Ok(specs)
}

fn resolve_clip_initial_gain(song: &Song, clip: &Clip) -> Result<f64, DesktopError> {
    Ok(resolve_track_clip_gain(song, &clip.track_id, clip.gain)?)
}

fn resolve_track_clip_gain(song: &Song, track_id: &str, clip_gain: f64) -> Result<f64, DesktopError> {
    let track = song
        .tracks
        .iter()
        .find(|track| track.id == track_id)
        .ok_or_else(|| DesktopError::TrackNotFound(track_id.to_string()))?;

    if track.muted {
        return Ok(0.0);
    }

    let group_gain = match track.group_id.as_deref() {
        Some(group_id) => {
            let group = song
                .groups
                .iter()
                .find(|group| group.id == group_id)
                .ok_or_else(|| DesktopError::GroupNotFound(group_id.to_string()))?;

            if group.muted {
                0.0
            } else {
                group.volume
            }
        }
        None => 1.0,
    };

    Ok(track.volume * group_gain * clip_gain)
}

#[cfg(test)]
mod tests {
    use libretracks_core::{OutputBus, Song, Track, TrackGroup};

    use super::{build_runtime_clip_specs, resolve_track_clip_gain};

    fn demo_song() -> Song {
        Song {
            id: "song_audio".into(),
            title: "Audio Runtime".into(),
            artist: None,
            bpm: 120.0,
            key: None,
            time_signature: "4/4".into(),
            duration_seconds: 20.0,
            tracks: vec![
                Track {
                    id: "track_click".into(),
                    name: "Click".into(),
                    group_id: Some("group_monitor".into()),
                    volume: 0.8,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Monitor.id(),
                },
                Track {
                    id: "track_drums".into(),
                    name: "Drums".into(),
                    group_id: Some("group_main".into()),
                    volume: 0.5,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    output_bus_id: OutputBus::Main.id(),
                },
            ],
            groups: vec![
                TrackGroup {
                    id: "group_monitor".into(),
                    name: "Monitor".into(),
                    volume: 0.5,
                    muted: false,
                    output_bus_id: OutputBus::Monitor.id(),
                },
                TrackGroup {
                    id: "group_main".into(),
                    name: "Main".into(),
                    volume: 0.7,
                    muted: false,
                    output_bus_id: OutputBus::Main.id(),
                },
            ],
            clips: vec![
                libretracks_core::Clip {
                    id: "clip_click".into(),
                    track_id: "track_click".into(),
                    file_path: "audio/click.wav".into(),
                    timeline_start_seconds: 0.0,
                    source_start_seconds: 0.0,
                    duration_seconds: 5.0,
                    gain: 1.0,
                    fade_in_seconds: None,
                    fade_out_seconds: None,
                },
                libretracks_core::Clip {
                    id: "clip_drums".into(),
                    track_id: "track_drums".into(),
                    file_path: "audio/drums.wav".into(),
                    timeline_start_seconds: 10.0,
                    source_start_seconds: 0.0,
                    duration_seconds: 4.0,
                    gain: 0.9,
                    fade_in_seconds: None,
                    fade_out_seconds: None,
                },
            ],
            sections: vec![],
        }
    }

    #[test]
    fn build_runtime_clip_specs_keeps_current_and_future_clips() {
        let specs = build_runtime_clip_specs(&demo_song(), 1.0).expect("specs should build");

        assert_eq!(specs.len(), 2);
        assert_eq!(specs[0].clip_id, "clip_click");
        assert!((specs[0].source_offset_seconds - 1.0).abs() < 0.0001);
        assert!((specs[0].play_duration_seconds - 4.0).abs() < 0.0001);
        assert_eq!(specs[0].delay_seconds, 0.0);

        assert_eq!(specs[1].clip_id, "clip_drums");
        assert!((specs[1].delay_seconds - 9.0).abs() < 0.0001);
        assert!((specs[1].play_duration_seconds - 4.0).abs() < 0.0001);
    }

    #[test]
    fn muted_tracks_resolve_to_zero_gain_without_dropping_other_tracks() {
        let mut song = demo_song();
        song.tracks[0].muted = true;

        let click_gain =
            resolve_track_clip_gain(&song, "track_click", 1.0).expect("click gain should resolve");
        let drums_gain =
            resolve_track_clip_gain(&song, "track_drums", 0.9).expect("drums gain should resolve");

        assert_eq!(click_gain, 0.0);
        assert!((drums_gain - 0.315).abs() < 0.0001);
    }
}
