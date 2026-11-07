//! Redundancy step 11: measure the offset between main and backup from a
//! stereo recording (main on the LEFT input, backup on the RIGHT).
//!
//!   cargo run --release -p libretracks-project --example redundancy_offset -- grabacion.wav [salida.csv]
//!
//! Prints p50/p95/max and the bias (median signed offset, positive = the
//! backup is late: put it in the backup's manual compensation, negated).

use libretracks_core::redundancy::offset_analysis::{analyse, summarise, to_csv, AnalysisOptions};

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(input) = args.next() else {
        eprintln!("uso: redundancy_offset <grabacion.wav> [salida.csv]");
        std::process::exit(2);
    };
    let output = args.next();
    let mut reader = hound::WavReader::open(&input).unwrap_or_else(|error| {
        eprintln!("no se pudo abrir {input}: {error}");
        std::process::exit(1);
    });
    let spec = reader.spec();
    if spec.channels < 2 {
        eprintln!("hace falta una grabacion estereo (principal izquierda, respaldo derecha)");
        std::process::exit(1);
    }
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
        hound::SampleFormat::Int => {
            let scale = (1u64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.unwrap_or(0) as f32 / scale)
                .collect()
        }
    };
    let channels = usize::from(spec.channels);
    let left: Vec<f32> = samples.iter().step_by(channels).copied().collect();
    let right: Vec<f32> = samples.iter().skip(1).step_by(channels).copied().collect();
    let (windows, skipped) = analyse(&left, &right, spec.sample_rate, &AnalysisOptions::default());
    let summary = summarise(&windows, skipped);
    let csv = to_csv(&windows);
    match output {
        Some(path) => std::fs::write(&path, csv).expect("write csv"),
        None => print!("{csv}"),
    }
    eprintln!(
        "ventanas={} ignoradas={} p50={:.3} ms p95={:.3} ms max={:.3} ms sesgo={:+.3} ms",
        summary.windows, summary.skipped, summary.p50_ms, summary.p95_ms, summary.max_ms, summary.bias_ms
    );
}
