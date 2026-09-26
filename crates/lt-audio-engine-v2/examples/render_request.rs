//! Run one offline render from a request JSON, against the real engine
//! library. Used to check "Render audio" end to end on real sessions:
//!
//! ```text
//! cargo run -p lt-audio-engine-v2 --example render_request -- request.json [...]
//! ```
//!
//! The requests come from `dump_real_session_render_requests` in the desktop
//! crate, which builds them exactly as the app does.

use std::time::Instant;

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("usage: render_request <request.json>...");
        std::process::exit(2);
    }
    let mut failed = false;
    for path in paths {
        let text = std::fs::read_to_string(&path).expect("read request");
        let request: lt_audio_engine_v2::RenderRequest =
            serde_json::from_str(&text).expect("parse request");
        let started = Instant::now();
        let mut last_tenth = -1;
        let result = lt_audio_engine_v2::render_offline(&request, &mut |fraction| {
            let tenth = (fraction * 10.0) as i32;
            if tenth != last_tenth {
                last_tenth = tenth;
                eprint!("{}% ", tenth * 10);
            }
            true
        });
        eprintln!();
        let seconds = request.end_seconds - request.start_seconds;
        match result {
            Ok(report) => {
                println!(
                    "{path}: {} file(s) for {:.1}s of song in {:.2}s; missing {:?}",
                    report.files.len(),
                    seconds,
                    started.elapsed().as_secs_f64(),
                    report.missing_files
                );
                for file in report.files {
                    println!("  {} frames={} peak={:.3}", file.path, file.frames, file.peak);
                }
            }
            Err(error) => {
                failed = true;
                println!("{path}: FAILED {error}");
            }
        }
    }
    if failed {
        std::process::exit(1);
    }
}
