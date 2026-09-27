//! Manual check of the real output backend (paso 06) on Windows:
//!
//!   LIBRETRACKS_LIBMPV=<libmpv> cargo run -p libretracks-video --example output_check -- <monitor name> <video> [image]
//!
//! Opens the output on that monitor through `VideoOutput` + `MpvOutputBackend`,
//! plays, goes black, swaps player slots, shows the idle image and closes,
//! printing the status and who has the keyboard focus at each step.

use std::time::{Duration, Instant};

use libretracks_video::monitors::MonitorInfo;
use libretracks_video::mpv_backend::MpvOutputBackend;
use libretracks_video::output::{OutputCommand, OutputState, PlayerCommand, Slot, VideoOutput};
use libretracks_video::settings::{DisplayId, IdleScreen, VideoOutputSettings};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let monitor_name = args.first().cloned().unwrap_or_else(|| "\\\\.\\DISPLAY2".into());
    let video = args.get(1).cloned().expect("video path");
    let image = args.get(2).cloned();

    let loaded = libretracks_video::load_libmpv(None).expect("libmpv");
    let monitors = os::monitors();
    println!("monitores: {monitors:?}");
    // A number picks by enumeration order (shells mangle "\.\DISPLAYn").
    let target = match monitor_name.parse::<usize>() {
        Ok(index) => monitors.get(index.saturating_sub(1)).cloned(),
        Err(_) => monitors.iter().find(|monitor| monitor.name == monitor_name).cloned(),
    }
    .unwrap_or_else(|| panic!("monitor {monitor_name:?} not found"));
    let app_monitor = monitors.iter().find(|m| m.is_primary).map(|m| m.name.clone());

    let focus_before = os::foreground();
    let output = VideoOutput::spawn(MpvOutputBackend::new(loaded.library));
    output.send(OutputCommand::Displays {
        monitors: monitors.clone(),
        app_monitor,
    });
    output.send(OutputCommand::ApplySettings(VideoOutputSettings {
        enabled: true,
        display: Some(DisplayId {
            name: target.name.clone(),
            width: target.width,
            height: target.height,
            x: target.x,
            y: target.y,
        }),
        idle: image
            .clone()
            .map(|path| IdleScreen::Image { path })
            .unwrap_or_default(),
        ..Default::default()
    }));
    wait(&output, "Ready", |status| status.state == OutputState::Ready);

    let started = Instant::now();
    output.send(OutputCommand::Player {
        slot: Slot::A,
        command: PlayerCommand::Load {
            path: video.clone(),
            start_seconds: 5.0,
            paused: false,
        },
    });
    wait(&output, "A playing", |status| status.player(Slot::A).restarts >= 1);
    println!("A arrancó en {:?}", started.elapsed());
    std::thread::sleep(Duration::from_secs(2));
    let status = output.status();
    println!(
        "A time-pos={:?} hwdec={:?} drops={}",
        status.player(Slot::A).time_pos,
        status.player(Slot::A).hwdec,
        status.player(Slot::A).frame_drops
    );

    output.send(OutputCommand::SetBrightness(-100.0));
    std::thread::sleep(Duration::from_millis(700));
    output.send(OutputCommand::SetBrightness(0.0));

    // Preload B paused at 30 s, then swap.
    output.send(OutputCommand::Player {
        slot: Slot::B,
        command: PlayerCommand::Load {
            path: video.clone(),
            start_seconds: 30.0,
            paused: true,
        },
    });
    wait(&output, "B preloaded", |status| status.player(Slot::B).restarts >= 1);
    let swap = Instant::now();
    output.send(OutputCommand::Player {
        slot: Slot::B,
        command: PlayerCommand::SetPause(false),
    });
    output.send(OutputCommand::ShowSlot(Slot::B));
    output.send(OutputCommand::Player {
        slot: Slot::A,
        command: PlayerCommand::SetPause(true),
    });
    println!("swap enviado en {:?}", swap.elapsed());
    std::thread::sleep(Duration::from_secs(2));
    println!("B time-pos={:?}", output.status().player(Slot::B).time_pos);

    output.send(OutputCommand::ShowIdle);
    std::thread::sleep(Duration::from_secs(1));
    println!("estado final: {:?}", output.status().state);
    let focus_after = os::foreground();
    println!("foco antes: {focus_before}\nfoco después: {focus_after}");
    println!("ROBA_FOCO={}", focus_before != focus_after);
}

fn wait(output: &VideoOutput, what: &str, done: impl Fn(&libretracks_video::output::OutputStatus) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status = output.status();
        if done(&status) {
            return;
        }
        if Instant::now() > deadline {
            panic!("timeout esperando {what}: {status:?}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(windows)]
mod os {
    use std::ffi::c_void;

    use libretracks_video::monitors::MonitorInfo;

    type Handle = *mut c_void;

    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct MonitorInfoExW {
        size: u32,
        monitor: Rect,
        work: Rect,
        flags: u32,
        device: [u16; 32],
    }

    #[link(name = "user32")]
    extern "system" {
        fn EnumDisplayMonitors(
            hdc: Handle,
            clip: *const Rect,
            proc_: unsafe extern "system" fn(Handle, Handle, *mut Rect, isize) -> i32,
            data: isize,
        ) -> i32;
        fn GetMonitorInfoW(monitor: Handle, info: *mut MonitorInfoExW) -> i32;
        fn GetForegroundWindow() -> Handle;
        fn GetWindowTextW(hwnd: Handle, text: *mut u16, max: i32) -> i32;
    }

    unsafe extern "system" fn collect(monitor: Handle, _: Handle, _: *mut Rect, data: isize) -> i32 {
        let out = &mut *(data as *mut Vec<MonitorInfo>);
        let mut info: MonitorInfoExW = std::mem::zeroed();
        info.size = std::mem::size_of::<MonitorInfoExW>() as u32;
        if GetMonitorInfoW(monitor, &mut info) != 0 {
            let end = info.device.iter().position(|c| *c == 0).unwrap_or(32);
            out.push(MonitorInfo {
                name: String::from_utf16_lossy(&info.device[..end]),
                width: (info.monitor.right - info.monitor.left) as u32,
                height: (info.monitor.bottom - info.monitor.top) as u32,
                x: info.monitor.left,
                y: info.monitor.top,
                is_primary: info.flags & 1 == 1,
            });
        }
        1
    }

    pub fn monitors() -> Vec<MonitorInfo> {
        let mut out: Vec<MonitorInfo> = Vec::new();
        unsafe {
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                collect,
                &mut out as *mut Vec<MonitorInfo> as isize,
            );
        }
        out
    }

    pub fn foreground() -> String {
        unsafe {
            let hwnd = GetForegroundWindow();
            let mut buffer = [0u16; 256];
            let len = GetWindowTextW(hwnd, buffer.as_mut_ptr(), 256).max(0) as usize;
            format!("{hwnd:p} \"{}\"", String::from_utf16_lossy(&buffer[..len]))
        }
    }
}

#[cfg(not(windows))]
mod os {
    use libretracks_video::monitors::MonitorInfo;
    pub fn monitors() -> Vec<MonitorInfo> {
        Vec::new()
    }
    pub fn foreground() -> String {
        "(n/d)".into()
    }
}

#[allow(dead_code)]
fn _unused(_: MonitorInfo) {}
