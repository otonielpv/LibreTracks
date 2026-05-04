use signalsmith_stretch::Stretch;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PitchShiftError {
    BufferLengthMismatch { input_len: usize, output_len: usize },
    ChannelAlignment { len: usize, channels: usize },
}

pub(crate) trait PitchShiftEngine: Send {
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
    if transpose_semitones == 0 {
        Box::new(BypassPitchShiftEngine)
    } else {
        Box::new(SignalsmithPitchShiftEngine::new(
            sample_rate,
            channels.max(1),
            transpose_semitones,
        ))
    }
}

fn semitones_to_pitch_ratio(transpose_semitones: i32) -> f32 {
    2.0_f32.powf(transpose_semitones as f32 / 12.0)
}

struct BypassPitchShiftEngine;

impl PitchShiftEngine for BypassPitchShiftEngine {
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

struct SignalsmithPitchShiftEngine {
    stretch: Stretch,
    channels: usize,
    pitch_ratio: f32,
    compensated_latency_frames: usize,
}

impl SignalsmithPitchShiftEngine {
    fn new(sample_rate: u32, channels: usize, transpose_semitones: i32) -> Self {
        let pitch_ratio = semitones_to_pitch_ratio(transpose_semitones);
        let mut stretch = Stretch::preset_default(channels as u32, sample_rate);
        stretch.set_transpose_factor(pitch_ratio, None);
        let reported_latency_frames = stretch.output_latency();

        Self {
            stretch,
            channels,
            pitch_ratio,
            compensated_latency_frames: compensated_latency_frames(
                sample_rate,
                transpose_semitones,
                reported_latency_frames,
            ),
        }
    }
}

impl PitchShiftEngine for SignalsmithPitchShiftEngine {
    fn reset(&mut self) {
        self.stretch.reset();
        self.stretch.set_transpose_factor(self.pitch_ratio, None);
    }

    fn latency_frames(&self) -> usize {
        self.compensated_latency_frames
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

        output_interleaved.fill(0.0);
        self.stretch.process(input_interleaved, output_interleaved);
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

fn compensated_latency_frames(
    _sample_rate: u32,
    _transpose_semitones: i32,
    reported_latency_frames: usize,
) -> usize {
    reported_latency_frames.saturating_mul(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn measure_first_impulse_frame(sample_rate: u32, semitones: i32) -> usize {
        let channels = 1;
        let mut engine = create_pitch_shift_engine(sample_rate, channels, semitones);
        let mut measured_output = Vec::new();
        let block_frames = 256;
        let total_frames = sample_rate as usize / 2;
        let mut first_block = true;

        for _ in (0..total_frames).step_by(block_frames) {
            let mut input = vec![0.0_f32; block_frames * channels];
            if first_block {
                input[0] = 1.0;
                first_block = false;
            }

            let mut output = vec![0.0_f32; input.len()];
            engine
                .process_realtime_block(&input, &mut output)
                .expect("pitch block should process");
            measured_output.extend_from_slice(&output);
        }

        measured_output
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| left.abs().total_cmp(&right.abs()))
            .map(|(index, _)| index)
            .expect("impulse response should contain a peak")
    }

    #[test]
    fn semitone_ratio_matches_equal_temperament() {
        let octave_up = semitones_to_pitch_ratio(12);
        let octave_down = semitones_to_pitch_ratio(-12);

        assert!((octave_up - 2.0).abs() < f32::EPSILON);
        assert!((octave_down - 0.5).abs() < f32::EPSILON);
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
        let mut engine = create_pitch_shift_engine(48_000, 2, 2);
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
    fn signalsmith_latency_matches_measured_impulse_peak() {
        for sample_rate in [44_100, 48_000] {
            for semitones in [-12, -7, -2, -1, 1, 2, 7, 12] {
                let measured_latency = measure_first_impulse_frame(sample_rate, semitones);
                let engine = create_pitch_shift_engine(sample_rate, 1, semitones);
                let reported_latency = engine.latency_frames();

                assert!(
                    measured_latency.abs_diff(reported_latency) <= 1,
                    "sample_rate={sample_rate} semitones={semitones} measured={measured_latency} reported={reported_latency}"
                );
            }
        }
    }
}
