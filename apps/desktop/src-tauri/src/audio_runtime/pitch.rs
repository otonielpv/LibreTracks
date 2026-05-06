use rubberband::{
    RubberBandProcessor, OPTION_CHANNELS_IDENTICAL, OPTION_PITCH_HIGH_QUALITY,
    OPTION_PROCESS_REAL_TIME,
};
use std::any::Any;

// RubberBand's reported real-time latency accounts for the algorithmic delay, while impulse
// regression tests show a residual one-block output delay before aligned transients are available.
const RUBBERBAND_REALTIME_ALIGNMENT_FRAMES: usize = 640;
const RUBBERBAND_ALIGNMENT_SILENCE_FRAMES: usize = 512;
const RUBBERBAND_REALTIME_LOOKAHEAD_FLOOR_FRAMES: usize = 4_096;

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct PitchShiftDiagnostics {
    pub sample_rate: u32,
    pub block_frames: usize,
    pub transpose_semitones: i32,
    pub rubberband_latency_frames: usize,
    pub effective_realtime_offset_frames: usize,
    pub context_before_frames: usize,
    pub lookahead_frames: usize,
    pub discarded_preroll_output_frames: usize,
    pub queued_output_frames_before_first_emit: usize,
    pub prepare_discarded_latency_frames: usize,
    pub alignment_trim_configured_frames: usize,
    pub alignment_trim_consumed_frames: usize,
    pub silence_frames_injected_by_ensure_internal_output_samples: usize,
    pub zero_filled_frames: usize,
    pub total_input_real_frames_processed: usize,
    pub total_output_frames_emitted: usize,
    pub first_non_silent_input_frame: Option<usize>,
    pub first_non_silent_output_frame: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PitchShiftError {
    BufferLengthMismatch { input_len: usize, output_len: usize },
    ChannelAlignment { len: usize, channels: usize },
    BackendUnavailable(String),
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) trait PitchShiftEngine: Send {
    fn as_any(&self) -> &dyn Any;
    fn reset(&mut self);
    fn diagnostics(&self) -> Option<PitchShiftDiagnostics> {
        None
    }
    fn prepare_for_aligned_output(&mut self) -> Result<usize, PitchShiftError>;
    fn prepare_with_real_audio_preroll(
        &mut self,
        input_interleaved: &[f32],
        discard_output_frames: usize,
        min_queued_output_frames: usize,
    ) -> Result<usize, PitchShiftError> {
        let _ = (
            input_interleaved,
            discard_output_frames,
            min_queued_output_frames,
        );
        Ok(0)
    }
    fn latency_frames(&self) -> usize;
    fn queued_output_frames(&self) -> usize {
        0
    }
    fn realtime_lookahead_frames(&self, block_frames: usize) -> usize {
        let _ = block_frames;
        0
    }
    fn process_realtime_block(
        &mut self,
        input_interleaved: &[f32],
        output_interleaved: &mut [f32],
    ) -> Result<(), PitchShiftError>;
}

pub(crate) fn create_pitch_shift_engine(
    sample_rate: u32,
    channels: usize,
    transpose_semitones: i32,
) -> Box<dyn PitchShiftEngine> {
    let safe_mode_enabled = super::source::audio_safe_mode_enabled();
    if transpose_semitones == 0 || safe_mode_enabled {
        Box::new(BypassPitchShiftEngine)
    } else {
        match RubberBandPitchShiftEngine::new(sample_rate, channels.max(1), transpose_semitones) {
            Ok(engine) => Box::new(engine),
            Err(error) => {
                eprintln!(
                    "[libretracks-audio] FATAL ERROR: No se pudo cargar RubberBand. El audio transpuesto se silenciará. Detalles: {}",
                    error
                );
                Box::new(UnavailablePitchShiftEngine { error })
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn rubberband_backend_available_for_test() -> bool {
    RubberBandPitchShiftEngine::new(48_000, 1, 1).is_ok()
}

fn semitones_to_pitch_ratio(transpose_semitones: i32) -> f64 {
    2.0_f64.powf(transpose_semitones as f64 / 12.0)
}

pub(crate) struct BypassPitchShiftEngine;

impl PitchShiftEngine for BypassPitchShiftEngine {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn reset(&mut self) {}

    fn prepare_for_aligned_output(&mut self) -> Result<usize, PitchShiftError> {
        Ok(0)
    }

    fn latency_frames(&self) -> usize {
        0
    }

    fn process_realtime_block(
        &mut self,
        input_interleaved: &[f32],
        output_interleaved: &mut [f32],
    ) -> Result<(), PitchShiftError> {
        validate_block_lengths(input_interleaved, output_interleaved, 1)?;
        output_interleaved.copy_from_slice(input_interleaved);
        Ok(())
    }
}

struct UnavailablePitchShiftEngine {
    error: String,
}

impl PitchShiftEngine for UnavailablePitchShiftEngine {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn reset(&mut self) {}

    fn prepare_for_aligned_output(&mut self) -> Result<usize, PitchShiftError> {
        Ok(0)
    }

    fn latency_frames(&self) -> usize {
        0
    }

    fn process_realtime_block(
        &mut self,
        _input_interleaved: &[f32],
        output_interleaved: &mut [f32],
    ) -> Result<(), PitchShiftError> {
        output_interleaved.fill(0.0);
        Err(PitchShiftError::BackendUnavailable(self.error.clone()))
    }
}

pub(crate) struct RubberBandPitchShiftEngine {
    processor: RubberBandProcessor,
    sample_rate: u32,
    transpose_semitones: i32,
    channels: usize,
    internal_output_buffer: Vec<f32>,
    scratch_channels: Vec<Vec<f32>>,
    output_trim_remaining_frames: usize,
    diagnostics: PitchShiftDiagnostics,
    prepared_with_preroll: bool,
}

impl RubberBandPitchShiftEngine {
    fn new(sample_rate: u32, channels: usize, transpose_semitones: i32) -> Result<Self, String> {
        let options =
            OPTION_PROCESS_REAL_TIME | OPTION_PITCH_HIGH_QUALITY | OPTION_CHANNELS_IDENTICAL;
        let processor = RubberBandProcessor::new(
            sample_rate.max(1),
            channels.max(1),
            options,
            1.0,
            semitones_to_pitch_ratio(transpose_semitones),
        )
        .map_err(|error| format!("{error:?}"))?;
        Ok(Self {
            processor,
            sample_rate: sample_rate.max(1),
            transpose_semitones,
            channels: channels.max(1),
            internal_output_buffer: Vec::new(),
            scratch_channels: vec![Vec::new(); channels.max(1)],
            output_trim_remaining_frames: 0,
            diagnostics: PitchShiftDiagnostics {
                sample_rate: sample_rate.max(1),
                transpose_semitones,
                rubberband_latency_frames: 0,
                alignment_trim_configured_frames: RUBBERBAND_REALTIME_ALIGNMENT_FRAMES,
                ..PitchShiftDiagnostics::default()
            },
            prepared_with_preroll: false,
        })
    }

    fn copy_from_internal_buffer(&mut self, output_interleaved: &mut [f32]) -> usize {
        let trim_samples = (self.output_trim_remaining_frames * self.channels)
            .min(self.internal_output_buffer.len());
        if trim_samples > 0 {
            self.internal_output_buffer.drain(..trim_samples);
            self.diagnostics.alignment_trim_consumed_frames = self
                .diagnostics
                .alignment_trim_consumed_frames
                .saturating_add(trim_samples / self.channels.max(1));
            self.output_trim_remaining_frames = self
                .output_trim_remaining_frames
                .saturating_sub(trim_samples / self.channels.max(1));
        }

        let samples_to_copy = output_interleaved
            .len()
            .min(self.internal_output_buffer.len());
        output_interleaved[..samples_to_copy]
            .copy_from_slice(&self.internal_output_buffer[..samples_to_copy]);
        note_first_non_silent(
            &mut self.diagnostics.first_non_silent_output_frame,
            output_interleaved,
            self.channels,
            self.diagnostics.total_output_frames_emitted,
        );
        self.internal_output_buffer.drain(..samples_to_copy);
        if samples_to_copy < output_interleaved.len() {
            output_interleaved[samples_to_copy..].fill(0.0);
            self.diagnostics.zero_filled_frames =
                self.diagnostics.zero_filled_frames.saturating_add(
                    (output_interleaved.len() - samples_to_copy) / self.channels.max(1),
                );
        }
        self.diagnostics.total_output_frames_emitted = self
            .diagnostics
            .total_output_frames_emitted
            .saturating_add(output_interleaved.len() / self.channels.max(1));
        samples_to_copy / self.channels.max(1)
    }

    fn discard_latency_output(&mut self) -> Result<usize, PitchShiftError> {
        let latency = self.latency_frames();
        if latency > 0 {
            let silence = vec![0.0_f32; latency * self.channels];
            let mut primed = vec![0.0_f32; silence.len()];
            self.process_realtime_block(&silence, &mut primed)?;
        }
        self.diagnostics.prepare_discarded_latency_frames = latency;
        Ok(latency)
    }

    fn retrieve_available_output(&mut self) -> Result<usize, PitchShiftError> {
        let available_frames = self.processor.available().max(0) as usize;
        let mut retrieved_frames = 0;
        if available_frames > 0 {
            let mut retrieved_channels = vec![Vec::new(); self.channels];
            retrieved_frames = self
                .processor
                .retrieve(&mut retrieved_channels, available_frames)
                .map_err(|error| PitchShiftError::BackendUnavailable(format!("{error:?}")))?;
            for frame_index in 0..retrieved_frames {
                for channel in retrieved_channels.iter().take(self.channels) {
                    self.internal_output_buffer.push(channel[frame_index]);
                }
            }
        }
        Ok(retrieved_frames)
    }

    fn ensure_internal_output_samples(&mut self, samples: usize) -> Result<(), PitchShiftError> {
        while self.internal_output_buffer.len() < samples {
            let silence_frames = RUBBERBAND_ALIGNMENT_SILENCE_FRAMES;
            self.diagnostics
                .silence_frames_injected_by_ensure_internal_output_samples = self
                .diagnostics
                .silence_frames_injected_by_ensure_internal_output_samples
                .saturating_add(silence_frames);
            for channel in &mut self.scratch_channels {
                channel.clear();
                channel.resize(silence_frames, 0.0);
            }
            self.processor
                .process(&self.scratch_channels, false)
                .map_err(|error| PitchShiftError::BackendUnavailable(format!("{error:?}")))?;
            let _ = self.retrieve_available_output()?;
            if self.processor.available() <= 0 && self.internal_output_buffer.len() < samples {
                break;
            }
        }
        Ok(())
    }

    fn process_input_to_internal(
        &mut self,
        input_interleaved: &[f32],
    ) -> Result<(usize, usize), PitchShiftError> {
        if input_interleaved.is_empty() {
            return Ok((0, 0));
        }
        if input_interleaved.len() % self.channels != 0 {
            return Err(PitchShiftError::ChannelAlignment {
                len: input_interleaved.len(),
                channels: self.channels,
            });
        }

        let frame_count = input_interleaved.len() / self.channels;
        self.diagnostics.block_frames = frame_count;
        note_first_non_silent(
            &mut self.diagnostics.first_non_silent_input_frame,
            input_interleaved,
            self.channels,
            self.diagnostics.total_input_real_frames_processed,
        );
        self.diagnostics.total_input_real_frames_processed = self
            .diagnostics
            .total_input_real_frames_processed
            .saturating_add(frame_count);
        for channel in &mut self.scratch_channels {
            channel.clear();
            channel.resize(frame_count, 0.0);
        }
        for (frame_index, frame) in input_interleaved.chunks_exact(self.channels).enumerate() {
            for (channel_index, &sample) in frame.iter().enumerate() {
                self.scratch_channels[channel_index][frame_index] = sample;
            }
        }

        self.processor
            .process(&self.scratch_channels, false)
            .map_err(|error| PitchShiftError::BackendUnavailable(format!("{error:?}")))?;

        let available_before_retrieve = self.processor.available().max(0) as usize;
        let retrieved_frames = self.retrieve_available_output()?;
        Ok((available_before_retrieve, retrieved_frames))
    }

    fn discard_internal_output_frames(&mut self, frames: usize) -> usize {
        let samples = (frames * self.channels).min(self.internal_output_buffer.len());
        if samples > 0 {
            self.internal_output_buffer.drain(..samples);
        }
        samples / self.channels.max(1)
    }

    #[cfg(test)]
    pub(crate) fn buffered_samples_for_test(&self) -> usize {
        self.internal_output_buffer.len()
    }

    #[cfg(test)]
    pub(crate) fn zero_filled_frames_for_test(&self) -> usize {
        self.diagnostics.zero_filled_frames
    }
}

impl PitchShiftEngine for RubberBandPitchShiftEngine {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn reset(&mut self) {
        self.processor.reset();
        self.internal_output_buffer.clear();
        self.output_trim_remaining_frames = 0;
        self.diagnostics = PitchShiftDiagnostics {
            sample_rate: self.sample_rate,
            transpose_semitones: self.transpose_semitones,
            rubberband_latency_frames: self.latency_frames(),
            alignment_trim_configured_frames: RUBBERBAND_REALTIME_ALIGNMENT_FRAMES,
            ..PitchShiftDiagnostics::default()
        };
        self.prepared_with_preroll = false;
    }

    fn diagnostics(&self) -> Option<PitchShiftDiagnostics> {
        Some(self.diagnostics)
    }

    fn prepare_for_aligned_output(&mut self) -> Result<usize, PitchShiftError> {
        self.diagnostics.rubberband_latency_frames = self.latency_frames();
        let latency = self.discard_latency_output()?;
        self.prepared_with_preroll = false;
        self.output_trim_remaining_frames = RUBBERBAND_REALTIME_ALIGNMENT_FRAMES;
        self.diagnostics.alignment_trim_configured_frames = RUBBERBAND_REALTIME_ALIGNMENT_FRAMES;
        self.diagnostics.alignment_trim_consumed_frames = 0;
        self.diagnostics.zero_filled_frames = 0;
        self.diagnostics
            .silence_frames_injected_by_ensure_internal_output_samples = 0;
        self.diagnostics.total_input_real_frames_processed = 0;
        self.diagnostics.total_output_frames_emitted = 0;
        self.diagnostics.first_non_silent_input_frame = None;
        self.diagnostics.first_non_silent_output_frame = None;
        Ok(latency)
    }

    fn latency_frames(&self) -> usize {
        self.processor.latency()
    }

    fn queued_output_frames(&self) -> usize {
        self.internal_output_buffer.len() / self.channels.max(1)
    }

    fn realtime_lookahead_frames(&self, block_frames: usize) -> usize {
        let block_frames = block_frames.max(1);
        let latency = self.latency_frames();
        let derived = latency
            .saturating_add(block_frames.saturating_mul(4))
            .div_ceil(block_frames)
            .saturating_mul(block_frames);
        derived.max(RUBBERBAND_REALTIME_LOOKAHEAD_FLOOR_FRAMES)
    }

    fn prepare_with_real_audio_preroll(
        &mut self,
        input_interleaved: &[f32],
        discard_output_frames: usize,
        min_queued_output_frames: usize,
    ) -> Result<usize, PitchShiftError> {
        self.diagnostics.rubberband_latency_frames = self.latency_frames();
        self.diagnostics.context_before_frames = discard_output_frames;
        self.diagnostics.lookahead_frames = min_queued_output_frames;
        self.diagnostics.effective_realtime_offset_frames = min_queued_output_frames;
        self.output_trim_remaining_frames = 0;
        let input_max_abs = max_abs(input_interleaved);
        let _ = self.process_input_to_internal(input_interleaved)?;
        let required_samples = discard_output_frames
            .saturating_add(min_queued_output_frames)
            .saturating_mul(self.channels);
        self.ensure_internal_output_samples(required_samples)?;
        let discarded = self.discard_internal_output_frames(discard_output_frames);
        self.diagnostics.discarded_preroll_output_frames = discarded;
        self.diagnostics.queued_output_frames_before_first_emit =
            self.internal_output_buffer.len() / self.channels.max(1);
        let internal_max_abs = max_abs(&self.internal_output_buffer);
        self.prepared_with_preroll = true;
        if input_max_abs > 0.000_001 && internal_max_abs <= 0.000_001 {
            return Err(PitchShiftError::BackendUnavailable(
                "rubberband preroll produced silent queued output from non-silent input"
                    .to_string(),
            ));
        }
        Ok(discarded)
    }

    fn process_realtime_block(
        &mut self,
        input_interleaved: &[f32],
        output_interleaved: &mut [f32],
    ) -> Result<(), PitchShiftError> {
        if input_interleaved.is_empty() {
            if !output_interleaved.is_empty() {
                self.copy_from_internal_buffer(output_interleaved);
            }
            return Ok(());
        }
        validate_block_lengths(input_interleaved, output_interleaved, self.channels)?;

        let _ = self.process_input_to_internal(input_interleaved)?;

        let trim_samples = self.output_trim_remaining_frames * self.channels;
        self.ensure_internal_output_samples(output_interleaved.len() + trim_samples)?;
        self.copy_from_internal_buffer(output_interleaved);
        Ok(())
    }
}

fn note_first_non_silent(
    target: &mut Option<usize>,
    samples: &[f32],
    channels: usize,
    absolute_start_frame: usize,
) {
    if target.is_some() {
        return;
    }
    let channels = channels.max(1);
    if let Some((frame_index, _)) = samples
        .chunks_exact(channels)
        .enumerate()
        .find(|(_, frame)| frame.iter().any(|sample| sample.abs() > 0.000_001))
    {
        *target = Some(absolute_start_frame.saturating_add(frame_index));
    }
}

pub(crate) fn max_abs(samples: &[f32]) -> f32 {
    samples
        .iter()
        .map(|sample| sample.abs())
        .fold(0.0, f32::max)
}

fn validate_block_lengths(
    input_interleaved: &[f32],
    output_interleaved: &mut [f32],
    channels: usize,
) -> Result<(), PitchShiftError> {
    if input_interleaved.len() != output_interleaved.len() {
        return Err(PitchShiftError::BufferLengthMismatch {
            input_len: input_interleaved.len(),
            output_len: output_interleaved.len(),
        });
    }

    if channels == 0 {
        return Ok(());
    }

    if input_interleaved.len() % channels != 0 {
        return Err(PitchShiftError::ChannelAlignment {
            len: input_interleaved.len(),
            channels,
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const IMPULSE_TEST_SAMPLE_RATE: u32 = 48_000;
    const IMPULSE_TEST_CHANNELS: usize = 1;
    const IMPULSE_TEST_BLOCK_FRAMES: usize = 512;
    const IMPULSE_TEST_BEAT_FRAMES: usize = 24_000;

    #[test]
    fn semitone_ratio_matches_equal_temperament() {
        let octave_up = semitones_to_pitch_ratio(12);
        let octave_down = semitones_to_pitch_ratio(-12);

        assert!((octave_up - 2.0).abs() < f64::EPSILON);
        assert!((octave_down - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn bypass_engine_returns_input_unchanged() {
        let mut engine = create_pitch_shift_engine(48_000, 2, 0);
        let input = vec![0.25, -0.25, 0.5, -0.5];
        let mut output = vec![0.0_f32; input.len()];

        engine
            .process_realtime_block(&input, &mut output)
            .expect("bypass should process");

        assert_eq!(output, input);
        engine.reset();
        engine
            .process_realtime_block(&[], &mut [])
            .expect("empty bypass block should process");
    }

    #[test]
    fn pitch_engine_rejects_mismatched_buffer_lengths() {
        let mut engine = create_pitch_shift_engine(48_000, 2, 0);
        let error = engine
            .process_realtime_block(&[0.0, 1.0], &mut [0.0])
            .expect_err("mismatched buffers should fail");

        assert_eq!(
            error,
            PitchShiftError::BufferLengthMismatch {
                input_len: 2,
                output_len: 1,
            }
        );
    }

    #[test]
    fn safe_mode_forces_bypass_even_with_non_zero_semitones() {
        crate::audio_runtime::source::with_env_var_for_test(
            "LIBRETRACKS_AUDIO_SAFE_MODE",
            Some("1"),
            || {
                let mut engine = create_pitch_shift_engine(48_000, 2, 7);
                let input = vec![0.25, -0.25, 0.5, -0.5];
                let mut output = vec![0.0_f32; input.len()];

                engine
                    .process_realtime_block(&input, &mut output)
                    .expect("safe mode bypass should process");

                assert_eq!(engine.latency_frames(), 0);
                assert_eq!(output, input);
            },
        );
    }

    #[test]
    fn rubberband_engine_absorbs_variable_output() {
        let mut engine = create_test_engine_with_buffer(vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
        let mut output = vec![0.0; 4];

        engine.copy_from_internal_buffer(&mut output);

        assert_eq!(output, vec![1.0, 2.0, 3.0, 4.0]);
        assert_eq!(engine.internal_output_buffer, vec![5.0, 6.0]);

        let mut starved = vec![0.0; 4];
        engine.copy_from_internal_buffer(&mut starved);

        assert_eq!(starved, vec![5.0, 6.0, 0.0, 0.0]);
        assert!(engine.internal_output_buffer.is_empty());
    }

    #[test]
    fn rubberband_engine_reset_clears_internal_buffer() {
        let Some(mut engine) = RubberBandPitchShiftEngine::new(48_000, 1, 2).ok() else {
            return;
        };
        engine
            .internal_output_buffer
            .extend_from_slice(&[0.1, 0.2, 0.3]);

        engine.reset();

        assert_eq!(engine.buffered_samples_for_test(), 0);
    }

    #[test]
    fn rubberband_impulse_train_stays_sample_aligned_after_transpose() {
        if !rubberband_backend_available_for_test() {
            return;
        }

        let duration_frames = IMPULSE_TEST_SAMPLE_RATE as usize * 10;
        let reference = impulse_train(duration_frames, IMPULSE_TEST_BEAT_FRAMES);
        let (reference_render, _) = render_with_engine(&reference, 0).expect("bypass render");

        for semitones in [2, 12, -12] {
            let (shifted, zero_filled_frames) =
                render_with_engine(&reference, semitones).expect("rubberband render");
            let observed_offset =
                detect_impulse_offset(&reference_render, &shifted, IMPULSE_TEST_CHANNELS);
            let latency = RubberBandPitchShiftEngine::new(
                IMPULSE_TEST_SAMPLE_RATE,
                IMPULSE_TEST_CHANNELS,
                semitones,
            )
            .expect("rubberband engine")
            .latency_frames();

            eprintln!(
                "transpose={semitones}, rubberband_latency_frames={latency}, observed_offset_frames={observed_offset}"
            );

            assert_eq!(shifted.len(), reference_render.len());
            eprintln!("zero_filled_frames={zero_filled_frames}");

            let impulse_count = duration_frames.div_ceil(IMPULSE_TEST_BEAT_FRAMES);
            for impulse_index in [0, impulse_count / 2, impulse_count.saturating_sub(1)] {
                let expected_frame = impulse_index * IMPULSE_TEST_BEAT_FRAMES;
                let reference_peak = peak_frame_near(
                    &reference_render,
                    IMPULSE_TEST_CHANNELS,
                    expected_frame,
                    512,
                );
                let shifted_peak =
                    peak_frame_near(&shifted, IMPULSE_TEST_CHANNELS, expected_frame, 512);
                let delta = shifted_peak as i64 - reference_peak as i64;
                assert!(
                    delta.abs() <= RUBBERBAND_REALTIME_ALIGNMENT_FRAMES as i64,
                    "transpose={semitones}, impulse={impulse_index}, reference_peak={reference_peak}, shifted_peak={shifted_peak}, delta={delta}, latency={latency}, observed_offset={observed_offset}"
                );
            }
        }
    }

    pub(crate) fn detect_impulse_offset(
        reference: &[f32],
        shifted: &[f32],
        channels: usize,
    ) -> i64 {
        let channels = channels.max(1);
        strongest_frame(shifted, channels) as i64 - strongest_frame(reference, channels) as i64
    }

    fn impulse_train(frames: usize, interval_frames: usize) -> Vec<f32> {
        let mut samples = vec![0.0_f32; frames * IMPULSE_TEST_CHANNELS];
        let click_frames = ((IMPULSE_TEST_SAMPLE_RATE as f32) * 0.01).round() as usize;
        for beat_frame in (0..frames).step_by(interval_frames.max(1)) {
            for click_frame in 0..click_frames.min(frames.saturating_sub(beat_frame)) {
                let envelope = 1.0 - (click_frame as f32 / click_frames.max(1) as f32);
                let radians = 2.0 * std::f32::consts::PI * 1_000.0 * click_frame as f32
                    / IMPULSE_TEST_SAMPLE_RATE as f32;
                samples[(beat_frame + click_frame) * IMPULSE_TEST_CHANNELS] =
                    radians.cos() * envelope;
            }
        }
        samples
    }

    fn render_with_engine(
        input: &[f32],
        semitones: i32,
    ) -> Result<(Vec<f32>, usize), PitchShiftError> {
        let mut engine =
            create_pitch_shift_engine(IMPULSE_TEST_SAMPLE_RATE, IMPULSE_TEST_CHANNELS, semitones);
        engine.reset();
        engine.prepare_for_aligned_output()?;

        let mut rendered = Vec::with_capacity(input.len());
        for chunk in input.chunks(IMPULSE_TEST_BLOCK_FRAMES * IMPULSE_TEST_CHANNELS) {
            let mut output = vec![0.0_f32; chunk.len()];
            engine.process_realtime_block(chunk, &mut output)?;
            rendered.extend_from_slice(&output);
        }
        let zero_filled_frames = engine
            .as_any()
            .downcast_ref::<RubberBandPitchShiftEngine>()
            .map(RubberBandPitchShiftEngine::zero_filled_frames_for_test)
            .unwrap_or_default();
        Ok((rendered, zero_filled_frames))
    }

    fn strongest_frame(samples: &[f32], channels: usize) -> usize {
        samples
            .chunks_exact(channels.max(1))
            .enumerate()
            .max_by(|(_, left), (_, right)| frame_peak(left).total_cmp(&frame_peak(right)))
            .map(|(frame, _)| frame)
            .unwrap_or_default()
    }

    fn peak_frame_near(
        samples: &[f32],
        channels: usize,
        expected_frame: usize,
        radius: usize,
    ) -> usize {
        let channels = channels.max(1);
        let total_frames = samples.len() / channels;
        let start = expected_frame.saturating_sub(radius);
        let end = (expected_frame + radius + 1).min(total_frames);
        if expected_frame == 0 {
            let max_peak = (start..end)
                .map(|frame| frame_peak(&samples[frame * channels..(frame + 1) * channels]))
                .fold(0.0, f32::max);
            let onset_threshold = max_peak * 0.05;
            if let Some(onset) = (start..end).find(|frame| {
                frame_peak(&samples[frame * channels..(frame + 1) * channels]) >= onset_threshold
            }) {
                return onset;
            }
        }

        (start..end)
            .max_by(|left, right| {
                frame_peak(&samples[left * channels..(left + 1) * channels]).total_cmp(&frame_peak(
                    &samples[right * channels..(right + 1) * channels],
                ))
            })
            .unwrap_or(expected_frame)
    }

    fn frame_peak(frame: &[f32]) -> f32 {
        frame.iter().map(|sample| sample.abs()).fold(0.0, f32::max)
    }

    fn create_test_engine_with_buffer(buffer: Vec<f32>) -> TestElasticBuffer {
        TestElasticBuffer {
            internal_output_buffer: buffer,
        }
    }

    struct TestElasticBuffer {
        internal_output_buffer: Vec<f32>,
    }

    impl TestElasticBuffer {
        fn copy_from_internal_buffer(&mut self, output_interleaved: &mut [f32]) {
            let samples_to_copy = output_interleaved
                .len()
                .min(self.internal_output_buffer.len());
            output_interleaved[..samples_to_copy]
                .copy_from_slice(&self.internal_output_buffer[..samples_to_copy]);
            self.internal_output_buffer.drain(..samples_to_copy);
            if samples_to_copy < output_interleaved.len() {
                output_interleaved[samples_to_copy..].fill(0.0);
            }
        }
    }
}
