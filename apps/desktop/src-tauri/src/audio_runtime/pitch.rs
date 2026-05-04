use signalsmith_stretch::Stretch;

pub(crate) trait PitchShiftEngine: Send {
    fn process_interleaved(&mut self, input_interleaved: &[f32], finish: bool) -> Vec<f32>;
    fn latency_frames(&self) -> usize;
    fn reset(&mut self);
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
    fn process_interleaved(&mut self, input_interleaved: &[f32], _finish: bool) -> Vec<f32> {
        input_interleaved.to_vec()
    }

    fn latency_frames(&self) -> usize {
        0
    }

    fn reset(&mut self) {}
}

struct SignalsmithPitchShiftEngine {
    stretch: Stretch,
    channels: usize,
    pitch_ratio: f32,
}

impl SignalsmithPitchShiftEngine {
    fn new(sample_rate: u32, channels: usize, transpose_semitones: i32) -> Self {
        let pitch_ratio = semitones_to_pitch_ratio(transpose_semitones);
        let mut stretch = Stretch::preset_default(channels as u32, sample_rate);
        stretch.set_transpose_factor(pitch_ratio, None);

        Self {
            stretch,
            channels,
            pitch_ratio,
        }
    }

    fn deinterleave(&self, input_interleaved: &[f32]) -> Vec<Vec<f32>> {
        let frame_count = input_interleaved.len() / self.channels;
        let mut planar = (0..self.channels)
            .map(|_| Vec::with_capacity(frame_count))
            .collect::<Vec<_>>();

        for frame in input_interleaved.chunks_exact(self.channels) {
            for (channel, sample) in frame.iter().enumerate() {
                planar[channel].push(*sample);
            }
        }

        planar
    }

    fn interleave(&self, planar: &[Vec<f32>]) -> Vec<f32> {
        let frame_count = planar.first().map_or(0, Vec::len);
        let mut interleaved = Vec::with_capacity(frame_count * self.channels);

        for frame in 0..frame_count {
            for channel in 0..self.channels {
                interleaved.push(planar[channel][frame]);
            }
        }

        interleaved
    }

    fn flush_tail(&mut self) -> Vec<f32> {
        let flush_frames = self.stretch.output_latency().max(1);
        let flush_samples = flush_frames * self.channels;
        let mut flushed = Vec::new();

        loop {
            let mut output = vec![0.0_f32; flush_samples];
            self.stretch.flush(&mut output);

            if output.iter().all(|sample| *sample == 0.0) {
                break;
            }

            flushed.extend_from_slice(&output);
        }

        flushed
    }

    fn process_and_flush(&mut self, input_interleaved: &[f32], finish: bool) -> Vec<f32> {
        debug_assert_eq!(0, input_interleaved.len() % self.channels);

        let planar_input = self.deinterleave(input_interleaved);
        let interleaved_input = self.interleave(&planar_input);
        let mut output = vec![0.0_f32; interleaved_input.len()];

        if !interleaved_input.is_empty() {
            self.stretch.process(&interleaved_input, &mut output);
        }

        if finish {
            output.extend_from_slice(&self.flush_tail());
        }

        output
    }

}

impl PitchShiftEngine for SignalsmithPitchShiftEngine {
    fn process_interleaved(&mut self, input_interleaved: &[f32], finish: bool) -> Vec<f32> {
        if input_interleaved.is_empty() && !finish {
            return Vec::new();
        }

        self.process_and_flush(input_interleaved, finish)
    }

    fn latency_frames(&self) -> usize {
        self.stretch.output_latency().max(0)
    }

    fn reset(&mut self) {
        self.stretch.reset();
        self.stretch.set_transpose_factor(self.pitch_ratio, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

        let output = engine.process_interleaved(&input, false);

        assert_eq!(output, input);
        engine.reset();
        assert!(engine.process_interleaved(&[], true).is_empty());
    }
}