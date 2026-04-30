use super::*;
use libretracks_core::{parse_audio_output_route, Track, TrackKind};
use tauri::Emitter;

const METRONOME_ACCENT_FREQUENCY_HZ: f32 = 1_000.0;
const METRONOME_BEAT_FREQUENCY_HZ: f32 = 500.0;
const METRONOME_BEEP_DURATION_SECONDS: f32 = 0.045;
const METRONOME_PEAK_GAIN: f32 = 0.6;
const DECLICK_FADE_MS: f32 = 5.0;

#[derive(Debug, Clone)]
pub(crate) struct LiveTrackMix {
    parent_track_id: Option<String>,
    kind: TrackKind,
    audio_to: String,
    volume: f32,
    pan: f32,
    muted: bool,
    solo: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct PlaybackClipPlan {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) clip_id: String,
    pub(crate) track_id: String,
    pub(crate) file_path: PathBuf,
    pub(crate) clip_gain: f32,
    pub(crate) timeline_start_frame: u64,
    pub(crate) duration_frames: u64,
    pub(crate) fade_in_frames: u64,
    pub(crate) fade_out_frames: u64,
    pub(crate) source_start_seconds: f64,
}

pub(crate) struct Mixer {
    song_dir: PathBuf,
    song: Song,
    live_mix_state: SharedTrackMixState,
    audio_settings: SharedAudioSettings,
    cached_live_mix: LiveMixSnapshot,
    audio_buffers: source::AudioBufferCache,
    pub(crate) output_sample_rate: u32,
    pub(crate) output_channels: usize,
    pub(crate) timeline_cursor_frame: u64,
    pub(crate) song_duration_frames: u64,
    next_plan_index: usize,
    plans: Vec<PlaybackClipPlan>,
    active_clips: Vec<MixClipState>,
    needs_declick: bool,
    last_output_frame: Vec<f32>,
    debug_config: telemetry::AudioDebugConfig,
    opened_files: usize,
    track_meter_indices: HashMap<String, usize>,
    track_child_indices: Vec<Vec<usize>>,
    meter_emitter: MeterEmitterState,
    master_gain: f32,
    master_fade: Option<MasterFadeState>,
    metronome_voice: MetronomeVoice,
}

pub(crate) struct MixClipState {
    plan: PlaybackClipPlan,
    reader: source::MemoryClipReader,
    current_gain: f32,
    current_pan: f32,
}

#[derive(Debug, Clone, Copy)]
struct MasterFadeState {
    start_gain: f32,
    target_gain: f32,
    total_frames: u64,
    elapsed_frames: u64,
}

#[derive(Debug, Clone, Copy)]
struct MetronomeVoice {
    phase: f32,
    frequency_hz: f32,
    frames_remaining: u32,
}

#[derive(Debug, Clone)]
struct MetronomeSettingsSnapshot {
    enabled: bool,
    volume: f32,
    audio_to: String,
}

#[derive(Debug, Clone, Copy)]
struct ResolvedTempoBeatRegion {
    start_seconds: f64,
    end_seconds: f64,
    beat_duration_seconds: f64,
    cumulative_beats_start: f64,
    beats_per_bar: u32,
}

#[derive(Debug, Clone, Copy)]
struct MetronomeBeatEvent {
    frame_offset: usize,
    is_downbeat: bool,
}

#[derive(Clone, Default)]
pub(crate) struct LiveMixSnapshot {
    pub(crate) tracks: HashMap<String, LiveTrackMix>,
    pub(crate) is_any_track_soloed: bool,
}

struct MeterEmitterState {
    app_handle: SharedAppHandle,
    remote_handle: SharedRemoteHandle,
    resolved_app_handle: Option<AppHandle>,
    pending_track_meters: Vec<AudioMeterLevel>,
    last_emit_at: Option<Instant>,
}

impl PlaybackClipPlan {
    pub(crate) fn timeline_end_frame(&self) -> u64 {
        self.timeline_start_frame
            .saturating_add(self.duration_frames)
    }

    pub(crate) fn edge_gain(&self, clip_frame_position: u64) -> f32 {
        let fade_in_gain = if self.fade_in_frames == 0 || clip_frame_position >= self.fade_in_frames
        {
            1.0
        } else {
            clip_frame_position as f32 / self.fade_in_frames as f32
        };

        let remaining_frames = self.duration_frames.saturating_sub(clip_frame_position);
        let fade_out_gain = if self.fade_out_frames == 0 || remaining_frames >= self.fade_out_frames
        {
            1.0
        } else {
            remaining_frames as f32 / self.fade_out_frames as f32
        };

        fade_in_gain.min(fade_out_gain).clamp(0.0, 1.0)
    }
}

impl LiveTrackMix {
    fn from_track(track: &Track) -> Self {
        Self {
            parent_track_id: track.parent_track_id.clone(),
            kind: track.kind,
            audio_to: track.audio_to.clone(),
            volume: track.volume as f32,
            pan: track.pan as f32,
            muted: track.muted,
            solo: track.solo,
        }
    }
}

impl LiveMixSnapshot {
    fn from_tracks(tracks: &HashMap<String, LiveTrackMix>) -> Self {
        Self {
            tracks: tracks.clone(),
            is_any_track_soloed: tracks.values().any(|track| track.solo),
        }
    }

    fn from_song(song: &Song) -> Self {
        let tracks = build_live_mix_map(song);
        Self {
            is_any_track_soloed: tracks.values().any(|track| track.solo),
            tracks,
        }
    }
}

impl Mixer {
    pub(crate) fn new(
        song_dir: PathBuf,
        song: Song,
        position_seconds: f64,
        output_sample_rate: u32,
        output_channels: usize,
        app_handle: SharedAppHandle,
        remote_handle: SharedRemoteHandle,
        live_mix_state: SharedTrackMixState,
        audio_settings: SharedAudioSettings,
        debug_config: telemetry::AudioDebugConfig,
        audio_buffers: source::AudioBufferCache,
    ) -> Self {
        let _ = replace_shared_live_mix(&live_mix_state, &song);
        let plans = build_playback_plans(&song_dir, &song, output_sample_rate);
        let track_meter_indices = song
            .tracks
            .iter()
            .enumerate()
            .map(|(index, track)| (track.id.clone(), index))
            .collect();
        let track_child_indices = vec![Vec::new(); song.tracks.len()];
        let mut mixer = Self {
            song_dir,
            song,
            live_mix_state,
            audio_settings,
            cached_live_mix: LiveMixSnapshot::default(),
            audio_buffers,
            output_sample_rate,
            output_channels,
            timeline_cursor_frame: 0,
            song_duration_frames: 0,
            next_plan_index: 0,
            plans,
            active_clips: Vec::new(),
            needs_declick: false,
            last_output_frame: vec![0.0; output_channels.max(1)],
            debug_config,
            opened_files: 0,
            track_meter_indices,
            track_child_indices,
            meter_emitter: MeterEmitterState::new(app_handle, remote_handle),
            master_gain: 1.0,
            master_fade: None,
            metronome_voice: MetronomeVoice::default(),
        };
        mixer.cached_live_mix = LiveMixSnapshot::from_song(&mixer.song);
        mixer.seek(mixer.song.clone(), position_seconds);
        mixer
    }

    pub(crate) fn apply_song_update(&mut self, song: Song) {
        let _ = replace_shared_live_mix(&self.live_mix_state, &song);
        self.song = song;
        self.cached_live_mix = LiveMixSnapshot::from_song(&self.song);
        self.plans = build_playback_plans(&self.song_dir, &self.song, self.output_sample_rate);
        self.rebuild_track_meter_indices();
    }

    pub(crate) fn seek(&mut self, song: Song, position_seconds: f64) {
        let _ = replace_shared_live_mix(&self.live_mix_state, &song);
        self.song = song;
        self.cached_live_mix = LiveMixSnapshot::from_song(&self.song);
        self.plans = build_playback_plans(&self.song_dir, &self.song, self.output_sample_rate);
        self.rebuild_track_meter_indices();
        self.song_duration_frames =
            seconds_to_frames(self.song.duration_seconds, self.output_sample_rate);
        self.timeline_cursor_frame = seconds_to_frames(position_seconds, self.output_sample_rate);
        self.next_plan_index = self
            .plans
            .partition_point(|plan| plan.timeline_end_frame() <= self.timeline_cursor_frame);
        self.needs_declick = true;
        self.active_clips.clear();
        self.opened_files = 0;
        self.activate_due_clips(
            self.timeline_cursor_frame
                .saturating_add(DISK_RENDER_BLOCK_FRAMES as u64),
        );
    }

    pub(crate) fn render_next_block(&mut self, block_frames: usize) -> Vec<f32> {
        let block_start = self.timeline_cursor_frame;
        let block_end = block_start + block_frames as u64;
        let mut master_mixed = vec![0.0_f32; block_frames * self.output_channels.max(1)];
        let mut direct_mixed = vec![0.0_f32; block_frames * self.output_channels.max(1)];
        let should_capture_track_meters = self.meter_emitter.capture_enabled();
        let mut track_meters = should_capture_track_meters.then(|| self.empty_track_meters());
        let metronome_settings = self.read_metronome_settings();
        self.prune_inactive_clips(block_start);
        self.activate_due_clips(block_end);
        {
            let live_mix_state = &self.cached_live_mix.tracks;
            let is_any_track_soloed = self.cached_live_mix.is_any_track_soloed;

            for clip_state in &mut self.active_clips {
                let overlap_start = block_start.max(clip_state.plan.timeline_start_frame);
                let overlap_end = block_end.min(clip_state.plan.timeline_end_frame());
                if overlap_end <= overlap_start {
                    continue;
                }

                let offset_frames = (overlap_start - block_start) as usize;
                let overlap_frames = (overlap_end - overlap_start) as usize;
                let target_gain = resolve_clip_runtime_gain(
                    live_mix_state,
                    &clip_state.plan.track_id,
                    clip_state.plan.clip_gain,
                    is_any_track_soloed,
                );
                let target_pan =
                    resolve_track_runtime_pan(live_mix_state, &clip_state.plan.track_id);
                let parent_gain =
                    resolve_parent_track_runtime_gain(live_mix_state, &clip_state.plan.track_id)
                        .unwrap_or(1.0);
                let audio_to = resolve_track_audio_to(live_mix_state, &clip_state.plan.track_id);
                let output_routing = parse_audio_output_route(audio_to, self.output_channels);
                let target_buffer = if is_master_route(audio_to) {
                    &mut master_mixed
                } else {
                    &mut direct_mixed
                };

                let (left_peak, right_peak) = clip_state.mix_into(
                    target_buffer,
                    offset_frames,
                    overlap_frames,
                    self.output_channels,
                    overlap_start,
                    target_gain,
                    target_pan,
                    &output_routing,
                );

                if let Some(index) = track_meters.as_ref().and_then(|_| {
                    self.track_meter_indices
                        .get(clip_state.plan.track_id.as_str())
                        .copied()
                }) {
                    if let Some(track_meter_levels) = track_meters.as_mut() {
                        let meter_left_peak = if parent_gain.abs() <= GAIN_EPSILON {
                            0.0
                        } else {
                            left_peak / parent_gain
                        };
                        let meter_right_peak = if parent_gain.abs() <= GAIN_EPSILON {
                            0.0
                        } else {
                            right_peak / parent_gain
                        };
                        track_meter_levels[index].left_peak =
                            track_meter_levels[index].left_peak.max(meter_left_peak);
                        track_meter_levels[index].right_peak =
                            track_meter_levels[index].right_peak.max(meter_right_peak);
                    }
                }
            }
        }

        if let Some(track_meter_levels) = track_meters.as_mut() {
            self.roll_up_folder_track_meters(track_meter_levels);
        }

        if let Some(track_meter_levels) = track_meters.as_ref() {
            self.meter_emitter.emit(track_meter_levels);
        }

        self.active_clips.retain(|clip_state| {
            !clip_state.reader.eof && block_end < clip_state.plan.timeline_end_frame()
        });
        if is_master_route(&metronome_settings.audio_to) {
            self.mix_metronome_into_output(
                &mut master_mixed,
                block_start,
                block_frames,
                &metronome_settings,
            );
        } else {
            self.mix_metronome_into_output(
                &mut direct_mixed,
                block_start,
                block_frames,
                &metronome_settings,
            );
        }
        self.apply_master_gain(&mut master_mixed, block_frames);
        let mut mixed = master_mixed;
        for (sample, direct_sample) in mixed.iter_mut().zip(direct_mixed) {
            *sample += direct_sample;
        }
        self.apply_declick_crossfade(&mut mixed, block_frames);
        self.capture_last_output_frame(&mixed, block_frames);
        self.timeline_cursor_frame += block_frames as u64;

        mixed
    }

    fn prune_inactive_clips(&mut self, timeline_frame: u64) {
        self.active_clips.retain(|clip_state| {
            !clip_state.reader.eof && timeline_frame < clip_state.plan.timeline_end_frame()
        });
    }

    fn activate_due_clips(&mut self, window_end_frame: u64) {
        let activation_start_frame = self.timeline_cursor_frame;
        let pre_roll_frames = self.output_sample_rate;
        while self.next_plan_index < self.plans.len()
            && self.plans[self.next_plan_index].timeline_start_frame
                < window_end_frame.saturating_add(pre_roll_frames as u64)
        {
            let plan = self.plans[self.next_plan_index].clone();
            self.next_plan_index += 1;

            if plan.timeline_end_frame() <= activation_start_frame {
                continue;
            }

            match source::StreamingClipReader::open(
                &plan,
                self.output_sample_rate,
                &self.audio_buffers,
                activation_start_frame,
            ) {
                Ok(reader) => {
                    let current_gain = resolve_clip_runtime_gain(
                        &self.cached_live_mix.tracks,
                        &plan.track_id,
                        plan.clip_gain,
                        self.cached_live_mix.is_any_track_soloed,
                    );
                    let current_pan =
                        resolve_track_runtime_pan(&self.cached_live_mix.tracks, &plan.track_id);
                    self.active_clips.push(MixClipState {
                        plan,
                        reader,
                        current_gain,
                        current_pan,
                    });
                }
                Err(error) => {
                    if self.debug_config.enabled || self.debug_config.log_commands {
                        eprintln!("[libretracks-audio] failed to open clip reader: {error}");
                    }
                }
            }
        }
    }

    fn rebuild_track_meter_indices(&mut self) {
        self.track_meter_indices = self
            .song
            .tracks
            .iter()
            .enumerate()
            .map(|(index, track)| (track.id.clone(), index))
            .collect();
        self.track_child_indices = vec![Vec::new(); self.song.tracks.len()];

        for (child_index, track) in self.song.tracks.iter().enumerate() {
            let Some(parent_track_id) = track.parent_track_id.as_deref() else {
                continue;
            };
            let Some(&parent_index) = self.track_meter_indices.get(parent_track_id) else {
                continue;
            };
            self.track_child_indices[parent_index].push(child_index);
        }
    }

    fn empty_track_meters(&self) -> Vec<AudioMeterLevel> {
        self.song
            .tracks
            .iter()
            .map(|track| AudioMeterLevel {
                track_id: track.id.clone(),
                left_peak: 0.0,
                right_peak: 0.0,
            })
            .collect()
    }

    pub(crate) fn roll_up_folder_track_meters(&self, track_meters: &mut [AudioMeterLevel]) {
        for track_index in (0..self.song.tracks.len()).rev() {
            let track = &self.song.tracks[track_index];
            if track.kind != TrackKind::Folder {
                continue;
            }

            let mut left_peak = 0.0_f32;
            let mut right_peak = 0.0_f32;

            for &child_index in &self.track_child_indices[track_index] {
                left_peak = left_peak.max(track_meters[child_index].left_peak);
                right_peak = right_peak.max(track_meters[child_index].right_peak);
            }

            let folder_gain = self
                .cached_live_mix
                .tracks
                .get(track.id.as_str())
                .map(|track_mix| track_mix.volume.clamp(0.0, 1.0))
                .unwrap_or(0.0);
            track_meters[track_index].left_peak = (left_peak * folder_gain).clamp(0.0, 1.0);
            track_meters[track_index].right_peak = (right_peak * folder_gain).clamp(0.0, 1.0);
        }
    }

    pub(crate) fn refresh_cached_live_mix(&mut self) {
        if let Ok(live_mix_state) = self.live_mix_state.try_read() {
            self.cached_live_mix = LiveMixSnapshot::from_tracks(&live_mix_state);
        }
    }

    pub(crate) fn start_master_fade(&mut self, target_gain: f32, duration_seconds: f64) {
        let duration_frames =
            seconds_to_frames(duration_seconds.max(0.0), self.output_sample_rate).max(1);
        let target_gain = target_gain.clamp(0.0, 1.0);
        if duration_frames <= 1 {
            self.master_gain = target_gain;
            self.master_fade = None;
            return;
        }

        self.master_fade = Some(MasterFadeState {
            start_gain: self.master_gain,
            target_gain,
            total_frames: duration_frames,
            elapsed_frames: 0,
        });
    }

    pub(crate) fn master_gain(&self) -> f32 {
        self.master_gain
    }

    pub(crate) fn is_master_fade_active(&self) -> bool {
        self.master_fade.is_some()
    }

    fn read_metronome_settings(&self) -> MetronomeSettingsSnapshot {
        self.audio_settings
            .read()
            .map(|settings| MetronomeSettingsSnapshot {
                enabled: settings.metronome_enabled,
                volume: settings.metronome_volume.clamp(0.0, 1.0) as f32,
                audio_to: settings.metronome_output.clone(),
            })
            .unwrap_or(MetronomeSettingsSnapshot {
                enabled: false,
                volume: 0.0,
                audio_to: "master".to_string(),
            })
    }

    fn mix_metronome_into_output(
        &mut self,
        buffer: &mut [f32],
        block_start_frame: u64,
        block_frames: usize,
        settings: &MetronomeSettingsSnapshot,
    ) {
        if !settings.enabled || settings.volume <= 0.0 || block_frames == 0 {
            return;
        }

        let beat_events = metronome_events_for_block(
            &self.song,
            block_start_frame,
            block_frames,
            self.output_sample_rate,
        );
        let output_routing = parse_audio_output_route(&settings.audio_to, self.output_channels);
        let mut next_event_index = 0;

        for frame_offset in 0..block_frames {
            while next_event_index < beat_events.len()
                && beat_events[next_event_index].frame_offset == frame_offset
            {
                self.metronome_voice.trigger(
                    beat_events[next_event_index].is_downbeat,
                    self.output_sample_rate,
                );
                next_event_index += 1;
            }

            let sample =
                self.metronome_voice.next_sample(self.output_sample_rate) * settings.volume;
            if sample.abs() <= GAIN_EPSILON {
                continue;
            }

            write_frame_to_output(
                buffer,
                frame_offset,
                self.output_channels,
                &output_routing,
                sample,
                sample,
            );
        }
    }

    fn apply_master_gain(&mut self, mixed: &mut [f32], block_frames: usize) {
        let output_channels = self.output_channels.max(1);
        let Some(mut fade) = self.master_fade else {
            if (self.master_gain - 1.0).abs() <= GAIN_EPSILON {
                return;
            }
            for frame in mixed.chunks_exact_mut(output_channels) {
                for channel in 0..output_channels.min(2) {
                    frame[channel] *= self.master_gain;
                }
            }
            return;
        };

        for frame_index in 0..block_frames {
            let frame_gain = interpolated_gain(
                fade.start_gain,
                fade.target_gain,
                fade.elapsed_frames as usize,
                fade.total_frames as usize,
            );
            let frame_base = frame_index * output_channels;
            for channel in 0..output_channels.min(2) {
                mixed[frame_base + channel] *= frame_gain;
            }
            fade.elapsed_frames = fade.elapsed_frames.saturating_add(1);
        }

        if fade.elapsed_frames >= fade.total_frames {
            self.master_gain = fade.target_gain;
            self.master_fade = None;
        } else {
            self.master_gain = interpolated_gain(
                fade.start_gain,
                fade.target_gain,
                fade.elapsed_frames as usize,
                fade.total_frames as usize,
            );
            self.master_fade = Some(fade);
        }
    }

    fn apply_declick_crossfade(&mut self, mixed: &mut [f32], block_frames: usize) {
        if !self.needs_declick || block_frames == 0 {
            return;
        }

        let fade_frames =
            ((DECLICK_FADE_MS / 1000.0) * self.output_sample_rate as f32).round() as usize;
        let fade_frames = fade_frames.max(1);
        let frames_to_process = fade_frames.min(block_frames);
        let output_channels = self.output_channels.max(1);

        for frame_idx in 0..frames_to_process {
            let fade_in = frame_idx as f32 / fade_frames as f32;
            let fade_out = 1.0 - fade_in;
            let base_idx = frame_idx * output_channels;

            for ch in 0..output_channels {
                let old_sample = self.last_output_frame[ch];
                let new_sample = mixed[base_idx + ch];
                mixed[base_idx + ch] = (old_sample * fade_out) + (new_sample * fade_in);
            }
        }

        self.needs_declick = false;
    }

    fn capture_last_output_frame(&mut self, mixed: &[f32], block_frames: usize) {
        if block_frames == 0 {
            return;
        }

        let output_channels = self.output_channels.max(1);
        let last_frame_base = (block_frames - 1) * output_channels;
        self.last_output_frame
            .copy_from_slice(&mixed[last_frame_base..last_frame_base + output_channels]);
    }
}

#[cfg(test)]
impl Mixer {
    pub(crate) fn plans(&self) -> &[PlaybackClipPlan] {
        &self.plans
    }

    pub(crate) fn active_clips(&self) -> &[MixClipState] {
        &self.active_clips
    }
}

#[cfg(test)]
impl MixClipState {
    pub(crate) fn plan(&self) -> &PlaybackClipPlan {
        &self.plan
    }

    pub(crate) fn reader_current_frame(&self) -> usize {
        self.reader.current_frame()
    }
}

impl MeterEmitterState {
    fn new(app_handle: SharedAppHandle, remote_handle: SharedRemoteHandle) -> Self {
        Self {
            app_handle,
            remote_handle,
            resolved_app_handle: None,
            pending_track_meters: Vec::new(),
            last_emit_at: None,
        }
    }

    fn capture_enabled(&mut self) -> bool {
        self.cached_app_handle().is_some()
    }

    fn cached_app_handle(&mut self) -> Option<AppHandle> {
        if self.resolved_app_handle.is_none() {
            self.resolved_app_handle = self
                .app_handle
                .read()
                .ok()
                .and_then(|app_handle| app_handle.as_ref().cloned());
        }

        self.resolved_app_handle.clone()
    }

    fn emit(&mut self, track_meters: &[AudioMeterLevel]) {
        let Some(app_handle) = self.cached_app_handle() else {
            return;
        };

        self.accumulate(track_meters);

        let now = Instant::now();
        let should_emit = match self.last_emit_at {
            Some(last_emit_at) => now.duration_since(last_emit_at) >= AUDIO_METER_EMIT_INTERVAL,
            None => true,
        };

        if !should_emit {
            return;
        }

        self.last_emit_at = Some(now);

        if let Err(error) = app_handle.emit(AUDIO_METER_EVENT, self.pending_track_meters.clone()) {
            eprintln!("[libretracks-audio] failed to emit audio meters: {error}");
        }

        if let Ok(remote_handle) = self.remote_handle.read() {
            if let Some(remote_handle) = remote_handle.as_ref() {
                remote_handle.publish_meters(&self.pending_track_meters);
            }
        }

        self.pending_track_meters.clear();
    }

    fn accumulate(&mut self, track_meters: &[AudioMeterLevel]) {
        if self.pending_track_meters.len() != track_meters.len()
            || self
                .pending_track_meters
                .iter()
                .zip(track_meters)
                .any(|(pending, next)| pending.track_id != next.track_id)
        {
            self.pending_track_meters = track_meters.to_vec();
            return;
        }

        for (pending_meter, next_meter) in self.pending_track_meters.iter_mut().zip(track_meters) {
            pending_meter.left_peak = pending_meter.left_peak.max(next_meter.left_peak);
            pending_meter.right_peak = pending_meter.right_peak.max(next_meter.right_peak);
        }
    }
}

impl MixClipState {
    fn mix_into(
        &mut self,
        buffer: &mut [f32],
        offset_frames: usize,
        frame_count: usize,
        output_channels: usize,
        overlap_start_frame: u64,
        target_gain: f32,
        target_pan: f32,
        output_routing: &[usize],
    ) -> (f32, f32) {
        let start_gain = self.current_gain;
        let start_pan = self.current_pan;
        let mut left_peak = 0.0_f32;
        let mut right_peak = 0.0_f32;

        for frame_offset in 0..frame_count {
            let dynamic_gain =
                interpolated_gain(start_gain, target_gain, frame_offset, frame_count);
            let dynamic_pan = interpolated_gain(start_pan, target_pan, frame_offset, frame_count);
            let clip_frame_position =
                (overlap_start_frame - self.plan.timeline_start_frame) + frame_offset as u64;
            let edge_gain = self.plan.edge_gain(clip_frame_position);

            let Some((left_sample, right_sample)) = self
                .reader
                .next_stereo_frame(dynamic_gain * edge_gain, dynamic_pan)
            else {
                break;
            };
            write_frame_to_output(
                buffer,
                offset_frames + frame_offset,
                output_channels,
                output_routing,
                left_sample,
                right_sample,
            );
            left_peak = left_peak.max(left_sample.abs());
            right_peak = right_peak.max(right_sample.abs());
        }

        self.current_gain = target_gain;
        self.current_pan = target_pan;

        (left_peak, right_peak)
    }
}

impl Default for MetronomeVoice {
    fn default() -> Self {
        Self {
            phase: 0.0,
            frequency_hz: METRONOME_BEAT_FREQUENCY_HZ,
            frames_remaining: 0,
        }
    }
}

impl MetronomeVoice {
    fn trigger(&mut self, is_downbeat: bool, output_sample_rate: u32) {
        self.phase = 0.0;
        self.frequency_hz = if is_downbeat {
            METRONOME_ACCENT_FREQUENCY_HZ
        } else {
            METRONOME_BEAT_FREQUENCY_HZ
        };
        self.frames_remaining = metronome_beep_duration_frames(output_sample_rate);
    }

    fn next_sample(&mut self, output_sample_rate: u32) -> f32 {
        if self.frames_remaining == 0 {
            return 0.0;
        }

        let total_frames = metronome_beep_duration_frames(output_sample_rate);
        let elapsed_frames = total_frames.saturating_sub(self.frames_remaining) as f32;
        let progress = elapsed_frames / total_frames.max(1) as f32;
        let attack_frames = ((0.001 * output_sample_rate.max(1) as f32).round() as u32).max(1);
        let attack_gain = if elapsed_frames < attack_frames as f32 {
            elapsed_frames / attack_frames as f32
        } else {
            1.0
        };
        let envelope = (1.0 - progress).powi(3) * attack_gain;
        let sample = (self.phase * std::f32::consts::TAU).sin() * envelope * METRONOME_PEAK_GAIN;

        self.phase = (self.phase + self.frequency_hz / output_sample_rate.max(1) as f32).fract();
        self.frames_remaining = self.frames_remaining.saturating_sub(1);

        sample
    }
}

pub(crate) fn interpolated_gain(
    start_gain: f32,
    target_gain: f32,
    frame_offset: usize,
    frame_count: usize,
) -> f32 {
    if (target_gain - start_gain).abs() <= GAIN_EPSILON {
        return target_gain;
    }

    if frame_count == 0 {
        return start_gain;
    }

    if frame_count == 1 {
        return target_gain;
    }

    let gain_ratio = frame_offset as f32 / frame_count.saturating_sub(1) as f32;
    start_gain + (target_gain - start_gain) * gain_ratio
}

pub(crate) fn build_playback_plans(
    song_dir: &Path,
    song: &Song,
    output_sample_rate: u32,
) -> Vec<PlaybackClipPlan> {
    let mut plans = Vec::new();

    for clip in &song.clips {
        if clip.duration_seconds <= 0.0 {
            continue;
        }

        plans.push(PlaybackClipPlan {
            clip_id: clip.id.clone(),
            track_id: clip.track_id.clone(),
            file_path: source::resolve_clip_audio_path(song_dir, &clip.file_path),
            clip_gain: clip.gain as f32,
            timeline_start_frame: seconds_to_frames(
                clip.timeline_start_seconds,
                output_sample_rate,
            ),
            duration_frames: seconds_to_frames(clip.duration_seconds, output_sample_rate),
            fade_in_frames: clip
                .fade_in_seconds
                .map(|seconds| seconds_to_frames(seconds, output_sample_rate))
                .unwrap_or(0),
            fade_out_frames: clip
                .fade_out_seconds
                .map(|seconds| seconds_to_frames(seconds, output_sample_rate))
                .unwrap_or(0),
            source_start_seconds: clip.source_start_seconds,
        });
    }

    plans.sort_by_key(|plan| plan.timeline_start_frame);
    plans
}

pub(crate) fn apply_runtime_pan(
    left_input: f32,
    right_input: f32,
    pan: f32,
    source_channels: usize,
) -> (f32, f32) {
    let pan = pan.clamp(-1.0, 1.0);

    if source_channels <= 1 {
        if pan < 0.0 {
            (left_input, right_input * (1.0 - pan.abs()))
        } else if pan > 0.0 {
            (left_input * (1.0 - pan), right_input)
        } else {
            (left_input, right_input)
        }
    } else if pan < 0.0 {
        let fold = pan.abs();
        (left_input + right_input * fold, right_input * (1.0 - fold))
    } else if pan > 0.0 {
        (left_input * (1.0 - pan), right_input + left_input * pan)
    } else {
        (left_input, right_input)
    }
}

pub(crate) fn build_live_mix_map(song: &Song) -> HashMap<String, LiveTrackMix> {
    song.tracks
        .iter()
        .map(|track| (track.id.clone(), LiveTrackMix::from_track(track)))
        .collect()
}

pub(crate) fn replace_shared_live_mix(
    shared_mix_state: &SharedTrackMixState,
    song: &Song,
) -> Result<(), String> {
    let mut live_mix_state = shared_mix_state
        .write()
        .map_err(|_| "live mix state lock poisoned".to_string())?;
    *live_mix_state = build_live_mix_map(song);
    Ok(())
}

pub(crate) fn update_shared_track_mix(
    shared_mix_state: &SharedTrackMixState,
    track_id: &str,
    volume: Option<f64>,
    pan: Option<f64>,
    muted: Option<bool>,
    solo: Option<bool>,
    audio_to: Option<&str>,
) -> Result<(), String> {
    let mut live_mix_state = shared_mix_state
        .write()
        .map_err(|_| "live mix state lock poisoned".to_string())?;
    let track_mix = live_mix_state
        .get_mut(track_id)
        .ok_or_else(|| format!("track not found: {track_id}"))?;

    if let Some(volume) = volume {
        track_mix.volume = volume.clamp(0.0, 1.0) as f32;
    }

    if let Some(pan) = pan {
        track_mix.pan = pan.clamp(-1.0, 1.0) as f32;
    }

    if let Some(muted) = muted {
        track_mix.muted = muted;
    }

    if let Some(solo) = solo {
        track_mix.solo = solo;
    }

    if let Some(audio_to) = audio_to {
        let trimmed = audio_to.trim();
        track_mix.audio_to = if trimmed.is_empty() {
            "master".to_string()
        } else {
            trimmed.to_ascii_lowercase()
        };
    }

    Ok(())
}

fn resolve_clip_runtime_gain(
    live_mix_state: &HashMap<String, LiveTrackMix>,
    track_id: &str,
    clip_gain: f32,
    is_any_track_soloed: bool,
) -> f32 {
    resolve_track_clip_gain(live_mix_state, track_id, clip_gain, is_any_track_soloed).unwrap_or(0.0)
}

pub(crate) fn resolve_track_runtime_pan(
    live_mix_state: &HashMap<String, LiveTrackMix>,
    track_id: &str,
) -> f32 {
    let Some(track) = live_mix_state.get(track_id) else {
        return 0.0;
    };

    let mut pan = track.pan;
    let mut cursor = track.parent_track_id.as_deref();
    let mut depth = 0;

    while let Some(parent_track_id) = cursor {
        if depth >= MAX_HIERARCHY_DEPTH {
            return 0.0;
        }

        let Some(parent_track) = live_mix_state.get(parent_track_id) else {
            return 0.0;
        };

        if parent_track.kind != TrackKind::Folder {
            return 0.0;
        }

        pan += parent_track.pan;
        cursor = parent_track.parent_track_id.as_deref();
        depth += 1;
    }

    pan.clamp(-1.0, 1.0)
}

fn resolve_track_audio_to<'a>(
    live_mix_state: &'a HashMap<String, LiveTrackMix>,
    track_id: &str,
) -> &'a str {
    let Some(track) = live_mix_state.get(track_id) else {
        return "master";
    };

    let mut audio_to = track.audio_to.as_str();
    let mut cursor = track.parent_track_id.as_deref();
    let mut depth = 0;

    while let Some(parent_track_id) = cursor {
        if depth >= MAX_HIERARCHY_DEPTH {
            return "master";
        }

        let Some(parent_track) = live_mix_state.get(parent_track_id) else {
            return "master";
        };

        if parent_track.kind != TrackKind::Folder {
            return "master";
        }

        audio_to = parent_track.audio_to.as_str();
        cursor = parent_track.parent_track_id.as_deref();
        depth += 1;
    }

    audio_to
}

fn is_master_route(audio_to: &str) -> bool {
    matches!(
        audio_to.trim().to_ascii_lowercase().as_str(),
        "" | "master" | "main"
    )
}

fn write_frame_to_output(
    buffer: &mut [f32],
    frame_index: usize,
    output_channels: usize,
    output_routing: &[usize],
    left_sample: f32,
    right_sample: f32,
) {
    let buffer_base = frame_index * output_channels.max(1);
    if output_channels <= 1 {
        buffer[buffer_base] += (left_sample + right_sample) * 0.5;
        return;
    }

    match output_routing {
        [] => {
            buffer[buffer_base] += left_sample;
            buffer[buffer_base + 1] += right_sample;
        }
        [single] => {
            let channel = (*single).min(output_channels.saturating_sub(1));
            buffer[buffer_base + channel] += (left_sample + right_sample) * 0.5;
        }
        [left_channel, right_channel, ..] => {
            let left_channel = (*left_channel).min(output_channels.saturating_sub(1));
            let right_channel = (*right_channel).min(output_channels.saturating_sub(1));
            buffer[buffer_base + left_channel] += left_sample;
            buffer[buffer_base + right_channel] += right_sample;
        }
    }
}

fn resolve_parent_track_runtime_gain(
    live_mix_state: &HashMap<String, LiveTrackMix>,
    track_id: &str,
) -> Option<f32> {
    let track = live_mix_state.get(track_id)?;
    let mut gain = 1.0_f32;
    let mut cursor = track.parent_track_id.as_deref();
    let mut depth = 0;

    while let Some(parent_track_id) = cursor {
        if depth >= MAX_HIERARCHY_DEPTH {
            return None;
        }

        let parent_track = live_mix_state.get(parent_track_id)?;
        if parent_track.kind != TrackKind::Folder {
            return None;
        }

        gain *= parent_track.volume;
        cursor = parent_track.parent_track_id.as_deref();
        depth += 1;
    }

    Some(gain)
}

fn metronome_beep_duration_frames(output_sample_rate: u32) -> u32 {
    (METRONOME_BEEP_DURATION_SECONDS * output_sample_rate.max(1) as f32)
        .round()
        .max(1.0) as u32
}

fn metronome_events_for_block(
    song: &Song,
    block_start_frame: u64,
    block_frames: usize,
    output_sample_rate: u32,
) -> Vec<MetronomeBeatEvent> {
    if block_frames == 0 || song.bpm <= 0.0 {
        return Vec::new();
    }

    let block_start_seconds = block_start_frame as f64 / f64::from(output_sample_rate.max(1));
    let block_end_seconds =
        (block_start_frame + block_frames as u64) as f64 / f64::from(output_sample_rate.max(1));
    let tempo_regions = resolve_tempo_beat_regions(song);
    let mut events = Vec::new();

    for region in tempo_regions {
        let overlap_start = block_start_seconds.max(region.start_seconds);
        let overlap_end = block_end_seconds.min(region.end_seconds);
        if overlap_end <= overlap_start {
            continue;
        }

        let mut next_beat_number = (region.cumulative_beats_start
            + (overlap_start - region.start_seconds) / region.beat_duration_seconds
            - f64::EPSILON)
            .ceil()
            .max(0.0) as u64;

        loop {
            let beat_time = region.start_seconds
                + (next_beat_number as f64 - region.cumulative_beats_start)
                    * region.beat_duration_seconds;

            if beat_time + f64::EPSILON < overlap_start {
                next_beat_number = next_beat_number.saturating_add(1);
                continue;
            }

            if beat_time + f64::EPSILON >= overlap_end {
                break;
            }

            let beat_frame = seconds_to_frames(beat_time, output_sample_rate);
            if beat_frame >= block_start_frame {
                let frame_offset = (beat_frame - block_start_frame) as usize;
                if frame_offset < block_frames
                    && events
                        .last()
                        .map(|event: &MetronomeBeatEvent| event.frame_offset != frame_offset)
                        .unwrap_or(true)
                {
                    events.push(MetronomeBeatEvent {
                        frame_offset,
                        is_downbeat: next_beat_number % u64::from(region.beats_per_bar.max(1)) == 0,
                    });
                }
            }

            next_beat_number = next_beat_number.saturating_add(1);
        }
    }

    events
}

fn resolve_tempo_beat_regions(song: &Song) -> Vec<ResolvedTempoBeatRegion> {
    let mut markers = song
        .tempo_markers
        .iter()
        .filter(|marker| marker.start_seconds > 0.0)
        .map(|marker| (marker.start_seconds, Some(marker.bpm), None))
        .chain(
            song.time_signature_markers
                .iter()
                .filter(|marker| marker.start_seconds > 0.0)
                .map(|marker| (marker.start_seconds, None, Some(marker.signature.as_str()))),
        )
        .collect::<Vec<_>>();
    markers.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut regions = Vec::with_capacity(markers.len() + 1);
    let mut cumulative_beats_start = 0.0_f64;
    let mut start_seconds = 0.0_f64;
    let mut bpm = song.bpm.max(1.0);
    let mut time_signature = song.time_signature.as_str();

    for (boundary_seconds, boundary_bpm, boundary_signature) in markers {
        if boundary_seconds <= start_seconds {
            if let Some(next_bpm) = boundary_bpm {
                bpm = next_bpm.max(1.0);
            }
            if let Some(next_signature) = boundary_signature {
                time_signature = next_signature;
            }
            continue;
        }

        let Ok((beats_per_bar, denominator)) = parse_song_time_signature(time_signature) else {
            continue;
        };
        let beat_duration_seconds = beat_duration_seconds_for_signature(bpm, denominator);
        let duration_seconds = (boundary_seconds - start_seconds).max(0.0);
        regions.push(ResolvedTempoBeatRegion {
            start_seconds,
            end_seconds: boundary_seconds,
            beat_duration_seconds,
            cumulative_beats_start,
            beats_per_bar,
        });
        cumulative_beats_start += duration_seconds / beat_duration_seconds;
        start_seconds = boundary_seconds;
        if let Some(next_bpm) = boundary_bpm {
            bpm = next_bpm.max(1.0);
        }
        if let Some(next_signature) = boundary_signature {
            time_signature = next_signature;
        }
    }

    let Ok((beats_per_bar, denominator)) = parse_song_time_signature(time_signature) else {
        return regions;
    };
    regions.push(ResolvedTempoBeatRegion {
        start_seconds,
        end_seconds: f64::MAX,
        beat_duration_seconds: beat_duration_seconds_for_signature(bpm, denominator),
        cumulative_beats_start,
        beats_per_bar,
    });

    regions
}

fn beat_duration_seconds_for_signature(bpm: f64, denominator: u32) -> f64 {
    (60.0 / bpm.max(1.0)) * (4.0 / f64::from(denominator.max(1)))
}

fn parse_song_time_signature(time_signature: &str) -> Result<(u32, u32), ()> {
    let (numerator, denominator) = time_signature.split_once('/').ok_or(())?;
    let numerator = numerator.parse::<u32>().map_err(|_| ())?;
    let denominator = denominator.parse::<u32>().map_err(|_| ())?;
    if numerator == 0 || denominator == 0 {
        return Err(());
    }
    Ok((numerator, denominator))
}

fn resolve_track_clip_gain(
    live_mix_state: &HashMap<String, LiveTrackMix>,
    track_id: &str,
    clip_gain: f32,
    is_any_track_soloed: bool,
) -> Option<f32> {
    let track = live_mix_state.get(track_id)?;

    if is_any_track_soloed && !is_track_soloed_in_hierarchy(live_mix_state, track) {
        return Some(0.0);
    }

    if track.muted {
        return Some(0.0);
    }

    let mut gain = track.volume;
    let mut cursor = track.parent_track_id.as_deref();
    let mut depth = 0;

    while let Some(parent_track_id) = cursor {
        if depth >= MAX_HIERARCHY_DEPTH {
            return None;
        }

        let parent_track = live_mix_state.get(parent_track_id)?;
        if parent_track.kind != TrackKind::Folder {
            return None;
        }

        if parent_track.muted {
            return Some(0.0);
        }

        gain *= parent_track.volume;
        cursor = parent_track.parent_track_id.as_deref();
        depth += 1;
    }

    Some(gain * clip_gain)
}

fn is_track_soloed_in_hierarchy(
    live_mix_state: &HashMap<String, LiveTrackMix>,
    track: &LiveTrackMix,
) -> bool {
    if track.solo {
        return true;
    }

    let mut cursor = track.parent_track_id.as_deref();
    let mut depth = 0;

    while let Some(parent_track_id) = cursor {
        if depth >= MAX_HIERARCHY_DEPTH {
            return false;
        }

        let Some(parent_track) = live_mix_state.get(parent_track_id) else {
            return false;
        };

        if parent_track.kind != TrackKind::Folder {
            return false;
        }

        if parent_track.solo {
            return true;
        }

        cursor = parent_track.parent_track_id.as_deref();
        depth += 1;
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::{Marker, SongRegion, TempoMarker};

    fn metronome_song() -> Song {
        Song {
            id: "song".into(),
            title: "Metronome".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 8.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![SongRegion {
                id: "region".into(),
                name: "Song".into(),
                start_seconds: 0.0,
                end_seconds: 8.0,
            }],
            tracks: vec![Track {
                id: "track".into(),
                name: "Track".into(),
                kind: TrackKind::Audio,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                audio_to: "master".to_string(),
            }],
            clips: vec![],
            section_markers: vec![Marker {
                id: "marker".into(),
                name: "Intro".into(),
                start_seconds: 0.0,
                digit: Some(1),
            }],
        }
    }

    #[test]
    fn metronome_events_follow_base_bpm_grid() {
        let song = metronome_song();

        let events = metronome_events_for_block(&song, 0, 48_000, 48_000);

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].frame_offset, 0);
        assert!(events[0].is_downbeat);
        assert_eq!(events[1].frame_offset, 24_000);
        assert!(!events[1].is_downbeat);
    }

    #[test]
    fn metronome_events_carry_fractional_beat_progress_across_tempo_markers() {
        let mut song = metronome_song();
        song.tempo_markers.push(TempoMarker {
            id: "tempo-1".into(),
            start_seconds: 0.75,
            bpm: 60.0,
        });

        let block_start_frame = seconds_to_frames(0.75, 48_000);
        let events = metronome_events_for_block(&song, block_start_frame, 48_000, 48_000);

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].frame_offset, 24_000);
        assert!(!events[0].is_downbeat);
    }

    #[test]
    fn external_output_routing_uses_zero_based_hardware_channels() {
        assert_eq!(parse_audio_output_route("master", 4), vec![0, 1]);
        assert_eq!(parse_audio_output_route("ext:0", 4), vec![0]);
        assert_eq!(parse_audio_output_route("ext:2-3", 4), vec![2, 3]);
    }

    #[test]
    fn metronome_voice_starts_at_zero_crossing_with_short_attack() {
        let mut voice = MetronomeVoice::default();
        voice.trigger(true, 48_000);

        assert_eq!(voice.next_sample(48_000), 0.0);

        let attack_sample = voice.next_sample(48_000).abs();
        for _ in 0..48 {
            let _ = voice.next_sample(48_000);
        }
        let post_attack_sample = voice.next_sample(48_000).abs();

        assert!(attack_sample < post_attack_sample);
    }

    #[test]
    fn resolve_track_audio_to_inherits_topmost_folder_route() {
        let mut song = metronome_song();
        song.tracks = vec![
            Track {
                id: "root_folder".into(),
                name: "Root".into(),
                kind: TrackKind::Folder,
                parent_track_id: None,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                audio_to: "ext:2-3".to_string(),
            },
            Track {
                id: "child_folder".into(),
                name: "Child".into(),
                kind: TrackKind::Folder,
                parent_track_id: Some("root_folder".into()),
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                audio_to: "ext:4-5".to_string(),
            },
            Track {
                id: "track".into(),
                name: "Track".into(),
                kind: TrackKind::Audio,
                parent_track_id: Some("child_folder".into()),
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                audio_to: "master".to_string(),
            },
        ];

        let live_mix_state = build_live_mix_map(&song);

        assert_eq!(resolve_track_audio_to(&live_mix_state, "track"), "ext:2-3");
    }
}
