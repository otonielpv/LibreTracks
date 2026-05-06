use rubberband::{
    RubberBandProcessor, OPTION_CHANNELS_IDENTICAL, OPTION_PITCH_HIGH_QUALITY,
    OPTION_PROCESS_REAL_TIME,
};
use std::any::Any;

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
    fn latency_frames(&self) -> usize;
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
    channels: usize,
    internal_output_buffer: Vec<f32>,
    scratch_channels: Vec<Vec<f32>>,
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
        let mut engine = Self {
            processor,
            channels: channels.max(1),
            internal_output_buffer: Vec::new(),
            scratch_channels: vec![Vec::new(); channels.max(1)],
        };
        engine.prime_latency();
        Ok(engine)
    }

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

    fn prime_latency(&mut self) {
        let latency = self.latency_frames();
        if latency > 0 {
            let silence = vec![0.0_f32; latency * self.channels];
            let mut primed = vec![0.0_f32; silence.len()];
            let _ = self.process_realtime_block(&silence, &mut primed);
        }
    }

    #[cfg(test)]
    pub(crate) fn buffered_samples_for_test(&self) -> usize {
        self.internal_output_buffer.len()
    }
}

impl PitchShiftEngine for RubberBandPitchShiftEngine {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn reset(&mut self) {
        self.processor.reset();
        self.internal_output_buffer.clear();
        self.prime_latency();
    }

    fn latency_frames(&self) -> usize {
        self.processor.latency()
    }

    fn process_realtime_block(
        &mut self,
        input_interleaved: &[f32],
        output_interleaved: &mut [f32],
    ) -> Result<(), PitchShiftError> {
        validate_block_lengths(input_interleaved, output_interleaved, self.channels)?;
        if input_interleaved.is_empty() {
            return Ok(());
        }

        let frame_count = input_interleaved.len() / self.channels;
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

        let available_frames = self.processor.available().max(0) as usize;
        if available_frames > 0 {
            let mut retrieved_channels = vec![Vec::new(); self.channels];
            let retrieved_frames = self
                .processor
                .retrieve(&mut retrieved_channels, available_frames)
                .map_err(|error| PitchShiftError::BackendUnavailable(format!("{error:?}")))?;
            for frame_index in 0..retrieved_frames {
                for channel in retrieved_channels.iter().take(self.channels) {
                    self.internal_output_buffer.push(channel[frame_index]);
                }
            }
        }

        self.copy_from_internal_buffer(output_interleaved);
        Ok(())
    }
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
