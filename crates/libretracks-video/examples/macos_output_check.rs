//! Manual check of the macOS output surface (paso 15), the Mac twin of
//! `output_check.rs`:
//!
//!   LIBRETRACKS_LIBMPV=<libmpv.2.dylib> LIBRETRACKS_VIDEO_CAPTURE_DIR=/tmp/cap \
//!     cargo run -p libretracks-video --example macos_output_check -- <video> [cycles]
//!
//! AppKit runs on the main thread, as in the app; another thread drives the
//! real `VideoOutput` + `MpvOutputBackend`: opens the output in window mode on
//! the first display, plays slot A, goes black and back, preloads B, swaps,
//! then closes and reopens `cycles` times printing the resident memory. With
//! the capture directory set, each slot writes a frame as `slot<N>.ppm`.

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("macos_output_check solo funciona en macOS");
}

#[cfg(target_os = "macos")]
fn main() {
    mac::run();
}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use libretracks_video::monitors::MonitorInfo;
    use libretracks_video::mpv_backend::MpvOutputBackend;
    use libretracks_video::output::{
        OutputCommand, OutputState, OutputStatus, PlayerCommand, Slot, VideoOutput,
    };
    use libretracks_video::settings::{DisplayId, VideoOutputMode, VideoOutputSettings};
    use libretracks_video::surface_macos::MainThread;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSScreen};

    /// The displays as tao would report them: physical pixels, top-left origin.
    fn monitors(mtm: MainThreadMarker) -> Vec<MonitorInfo> {
        let screens = NSScreen::screens(mtm);
        let main_height = screens
            .iter()
            .next()
            .map(|screen| screen.frame().size.height)
            .unwrap_or(0.0);
        screens
            .iter()
            .enumerate()
            .map(|(index, screen)| {
                let frame = screen.frame();
                let scale = screen.backingScaleFactor();
                MonitorInfo {
                    name: format!("Pantalla {}", index + 1),
                    width: (frame.size.width * scale) as u32,
                    height: (frame.size.height * scale) as u32,
                    x: (frame.origin.x * scale) as i32,
                    y: ((main_height - frame.origin.y - frame.size.height) * scale) as i32,
                    is_primary: index == 0,
                }
            })
            .collect()
    }

    fn resident_mb() -> f64 {
        let output = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output();
        output
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .and_then(|text| text.trim().parse::<f64>().ok())
            .map(|kb| kb / 1024.0)
            .unwrap_or(0.0)
    }

    fn wait(output: &VideoOutput, what: &str, done: impl Fn(&OutputStatus) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let status = output.status();
            if done(&status) {
                return;
            }
            if Instant::now() > deadline {
                eprintln!("TIMEOUT esperando {what}: {status:?}");
                std::process::exit(2);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn run() {
        let mtm = MainThreadMarker::new().expect("main thread");
        let args: Vec<String> = std::env::args().skip(1).collect();
        let video = args.first().cloned().expect("video path");
        let cycles: u32 = args
            .get(1)
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let monitors = monitors(mtm);
        println!("monitores: {monitors:?}");

        let main_thread: MainThread = Arc::new(|job| {
            dispatch2::DispatchQueue::main().exec_async(job);
        });

        std::thread::spawn(move || drive(video, cycles, monitors, main_thread));
        NSApplication::sharedApplication(mtm).run();
    }

    fn drive(video: String, cycles: u32, monitors: Vec<MonitorInfo>, main_thread: MainThread) {
        let loaded = libretracks_video::load_libmpv(None).expect("libmpv");
        println!("libmpv: {}", loaded.path.display());
        let target = monitors.first().cloned().expect("a display");
        let output = VideoOutput::spawn(MpvOutputBackend::new_macos(loaded.library, main_thread));
        output.send(OutputCommand::Displays {
            monitors: monitors.clone(),
            app_monitor: None,
        });
        let settings = VideoOutputSettings {
            enabled: true,
            display: Some(DisplayId {
                name: target.name.clone(),
                width: target.width,
                height: target.height,
                x: target.x,
                y: target.y,
            }),
            mode: VideoOutputMode::Window,
            ..Default::default()
        };
        output.send(OutputCommand::ApplySettings(settings.clone()));
        wait(&output, "Ready", |status| {
            status.state == OutputState::Ready
        });
        println!("salida lista, dual={}", output.status().dual_players);

        let started = Instant::now();
        output.send(OutputCommand::Player {
            slot: Slot::A,
            command: PlayerCommand::Load {
                path: video.clone(),
                start_seconds: 1.0,
                paused: false,
            },
        });
        wait(&output, "A reproduciendo", |status| {
            status.player(Slot::A).restarts >= 1
        });
        println!("A arrancó en {:?}", started.elapsed());
        std::thread::sleep(Duration::from_secs(3));
        let status = output.status();
        println!(
            "A time-pos={:?} hwdec={:?} drops={}",
            status.player(Slot::A).time_pos,
            status.player(Slot::A).hwdec,
            status.player(Slot::A).frame_drops
        );

        output.send(OutputCommand::SetBrightness(-100.0));
        std::thread::sleep(Duration::from_millis(500));
        output.send(OutputCommand::SetBrightness(0.0));

        output.send(OutputCommand::Player {
            slot: Slot::B,
            command: PlayerCommand::Load {
                path: video.clone(),
                start_seconds: 8.0,
                paused: true,
            },
        });
        wait(&output, "B precargado", |status| {
            status.player(Slot::B).restarts >= 1
        });
        output.send(OutputCommand::Player {
            slot: Slot::B,
            command: PlayerCommand::SetPause(false),
        });
        output.send(OutputCommand::ShowSlot(Slot::B));
        output.send(OutputCommand::Player {
            slot: Slot::A,
            command: PlayerCommand::SetPause(true),
        });
        std::thread::sleep(Duration::from_secs(3));
        println!("B time-pos={:?}", output.status().player(Slot::B).time_pos);
        println!("mem tras abrir y reproducir: {:.1} MB", resident_mb());

        let mut first = 0.0;
        for cycle in 1..=cycles {
            output.send(OutputCommand::ApplySettings(VideoOutputSettings {
                enabled: false,
                ..settings.clone()
            }));
            wait(&output, "cerrada", |status| {
                status.state == OutputState::Disabled
            });
            output.send(OutputCommand::ApplySettings(settings.clone()));
            wait(&output, "reabierta", |status| {
                status.state == OutputState::Ready
            });
            output.send(OutputCommand::Player {
                slot: Slot::A,
                command: PlayerCommand::Load {
                    path: video.clone(),
                    start_seconds: 1.0,
                    paused: false,
                },
            });
            std::thread::sleep(Duration::from_millis(400));
            let mem = resident_mb();
            if cycle == 1 {
                first = mem;
            }
            if cycle == 1 || cycle % 5 == 0 {
                println!(
                    "ciclo {cycle}: {mem:.1} MB, estado {:?}",
                    output.status().state
                );
            }
        }
        if cycles > 0 {
            println!(
                "ciclos: primero {first:.1} MB, último {:.1} MB",
                resident_mb()
            );
        }
        println!("FIN estado={:?}", output.status().state);
        std::process::exit(0);
    }
}
