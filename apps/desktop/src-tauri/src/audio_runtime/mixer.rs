use super::*;
use libretracks_core::{Track, TrackKind};
use tauri::Emitter;

#[derive(Debug, Clone)]
pub(crate) struct LiveTrackMix {
    parent_track_id: Option<String>,
    kind: TrackKind,
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
    song: Song,
    live_mix_state: SharedTrackMixState,
    cached_live_mix: LiveMixSnapshot,
    audio_buffers: source::AudioBufferCache,
    pub(crate) output_sample_rate: u32,
    pub(crate) output_channels: usize,
    pub(crate) timeline_cursor_frame: u64,
    pub(crate) song_duration_frames: u64,
    next_plan_index: usize,
    plans: Vec<PlaybackClipPlan>,
    active_clips: Vec<MixClipState>,
    debug_config: telemetry::AudioDebugConfig,
    opened_files: usize,
    track_meter_indices: HashMap<String, usize>,
    track_child_indices: Vec<Vec<usize>>,
    meter_emitter: MeterEmitterState,
}

pub(crate) struct MixClipState {
    plan: PlaybackClipPlan,
    reader: source::MemoryClipReader,
    current_gain: f32,
    current_pan: f32,
}

#[derive(Clone, Default)]
pub(crate) struct LiveMixSnapshot {
    pub(crate) tracks: HashMap<String, LiveTrackMix>,
    pub(crate) is_any_track_soloed: bool,
}

struct MeterEmitterState {
    app_handle: SharedAppHandle,
    resolved_app_handle: Option<AppHandle>,
    pending_track_meters: Vec<AudioMeterLevel>,
    last_emit_at: Option<Instant>,
}

impl PlaybackClipPlan {
    pub(crate) fn timeline_end_frame(&self) -> u64 {
        self.timeline_start_frame
            .saturating_add(self.duration_frames)
    }

    fn edge_gain(&self, clip_frame_position: u64) -> f32 {
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
        live_mix_state: SharedTrackMixState,
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
            song,
            live_mix_state,
            cached_live_mix: LiveMixSnapshot::default(),
            audio_buffers,
            output_sample_rate,
            output_channels,
            timeline_cursor_frame: 0,
            song_duration_frames: 0,
            next_plan_index: 0,
            plans,
            active_clips: Vec::new(),
            debug_config,
            opened_files: 0,
            track_meter_indices,
            track_child_indices,
            meter_emitter: MeterEmitterState::new(app_handle),
        };
        mixer.cached_live_mix = LiveMixSnapshot::from_song(&mixer.song);
        mixer.seek(mixer.song.clone(), position_seconds);
        mixer
    }

    pub(crate) fn apply_song_update(&mut self, song: Song) {
        let _ = replace_shared_live_mix(&self.live_mix_state, &song);
        self.song = song;
        self.cached_live_mix = LiveMixSnapshot::from_song(&self.song);
        self.rebuild_track_meter_indices();
    }

    pub(crate) fn seek(&mut self, song: Song, position_seconds: f64) {
        let _ = replace_shared_live_mix(&self.live_mix_state, &song);
        self.song = song;
        self.cached_live_mix = LiveMixSnapshot::from_song(&self.song);
        self.rebuild_track_meter_indices();
        self.song_duration_frames =
            seconds_to_frames(self.song.duration_seconds, self.output_sample_rate);
        self.timeline_cursor_frame = seconds_to_frames(position_seconds, self.output_sample_rate);
        self.next_plan_index = self
            .plans
            .partition_point(|plan| plan.timeline_end_frame() <= self.timeline_cursor_frame);
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
        let mut mixed = vec![0.0_f32; block_frames * self.output_channels.max(1)];
        let should_capture_track_meters = self.meter_emitter.capture_enabled();
        let mut track_meters = should_capture_track_meters.then(|| self.empty_track_meters());

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

                let (left_peak, right_peak) = clip_state.mix_into(
                    &mut mixed,
                    offset_frames,
                    overlap_frames,
                    self.output_channels,
                    overlap_start,
                    target_gain,
                    target_pan,
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
        while self.next_plan_index < self.plans.len()
            && self.plans[self.next_plan_index].timeline_start_frame < window_end_frame
        {
            let plan = self.plans[self.next_plan_index].clone();
            self.next_plan_index += 1;

            if plan.timeline_end_frame() <= activation_start_frame {
                continue;
            }

            match source::MemoryClipReader::open(
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

    fn roll_up_folder_track_meters(&self, track_meters: &mut [AudioMeterLevel]) {
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
}

impl MeterEmitterState {
    fn new(app_handle: SharedAppHandle) -> Self {
        Self {
            app_handle,
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

            let (frame_left_peak, frame_right_peak) = self.reader.mix_into_with_channel_gains(
                buffer,
                offset_frames + frame_offset,
                1,
                output_channels,
                dynamic_gain * edge_gain,
                dynamic_pan,
            );
            left_peak = left_peak.max(frame_left_peak);
            right_peak = right_peak.max(frame_right_peak);
        }

        self.current_gain = target_gain;
        self.current_pan = target_pan;

        (left_peak, right_peak)
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

fn build_playback_plans(
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
            file_path: song_dir.join(&clip.file_path),
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
