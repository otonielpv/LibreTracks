//! Paso 01 del plan de vídeo: prueba de concepto de libmpv. Código DESECHABLE:
//! se revisa por la evidencia que produce, no por su calidad.
//!
//!   LIBRETRACKS_LIBMPV=<ruta a libmpv> cargo run -p libretracks-video --example spike -- <modo>
//!
//! Modos:
//!   info                          versión, monitores del SO y `display-names` de mpv
//!   screen <nombre> <fichero>     pantalla completa en `fs-screen-name=<nombre>`,
//!                                 dos cambios de fichero, y quién tiene el foco
//!   seek <fichero> <auto|no> [n]  n seeks exactos aleatorios en pausa → p50/p95/máx
//!   follow <fichero> <seg> <rate> <csv> [k]  seguir un reloj simulado con la ley 4.6
//!   coexist <dir FFmpeg motor> <fichero>     FFmpeg del motor + mpv en el mismo proceso

use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

use libretracks_video::{load_libmpv, Mpv, MpvEvent, ObserveAs, PropertyValue};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(String::as_str).unwrap_or("info");
    let result = match mode {
        "info" => info(),
        "screen" => screen(&args[1], &args[2]),
        "seek" => seek(
            &args[1],
            &args[2],
            args.get(3).and_then(|n| n.parse().ok()).unwrap_or(50),
        ),
        "follow" => follow(
            &args[1],
            args[2].parse().expect("segundos"),
            args[3].parse().expect("rate"),
            &args[4],
            args.get(5).and_then(|k| k.parse().ok()).unwrap_or(0.5),
        ),
        "coexist" => coexist(&args[1], &args[2]),
        "embed" => embed(
            args[1].parse().expect("x"),
            args[2].parse().expect("y"),
            args[3].parse().expect("w"),
            args[4].parse().expect("h"),
            &args[5],
        ),
        other => Err(format!("modo desconocido {other}")),
    };
    if let Err(error) = result {
        eprintln!("ERROR: {error}");
        std::process::exit(1);
    }
}

fn new_player(extra: &[(&str, &str)]) -> Result<Mpv, String> {
    let loaded = load_libmpv(None).map_err(|e| e.to_string())?;
    println!(
        "libmpv: {} (API cliente {})",
        loaded.path.display(),
        loaded.library.client_api_version()
    );
    let mpv = Mpv::create(&loaded.library).map_err(|e| e.to_string())?;
    let base = [
        ("config", "no"),
        ("load-scripts", "no"),
        ("ytdl", "no"),
        ("terminal", "no"),
        ("osc", "no"),
        ("osd-level", "0"),
        ("input-default-bindings", "no"),
        ("input-vo-keyboard", "no"),
        ("ao", "null"),
        ("idle", "yes"),
        ("keep-open", "yes"),
        ("force-window", "yes"),
        ("focus-on", "never"),
        ("background", "color"),
        ("background-color", "#000000"),
    ];
    let env_opts = std::env::var("SPIKE_OPTS").unwrap_or_default();
    let env_pairs: Vec<(String, String)> = env_opts
        .split(';')
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let env_refs: Vec<(&str, &str)> = env_pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    for (name, value) in base.iter().chain(extra.iter()).chain(env_refs.iter()) {
        mpv.set_option(name, value)
            .map_err(|e| format!("{name}={value}: {e}"))?;
    }
    mpv.initialize().map_err(|e| e.to_string())?;
    Ok(mpv)
}

/// Wait for an event matching `want`, up to `timeout`.
fn wait_for(mpv: &Mpv, timeout: Duration, want: impl Fn(&MpvEvent) -> bool) -> Option<MpvEvent> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let left = deadline.saturating_duration_since(Instant::now()).as_secs_f64();
        if let Some(event) = mpv.wait_event(left.min(0.1)) {
            if let MpvEvent::EndFile(libretracks_video::mpv::EndFileReason::Error(reason)) = &event {
                eprintln!("  fin por error: {reason}");
            }
            if want(&event) {
                return Some(event);
            }
        }
    }
    None
}

fn load_and_wait(mpv: &Mpv, file: &str) -> Result<(), String> {
    mpv.command(&["loadfile", file, "replace"])
        .map_err(|e| e.to_string())?;
    wait_for(mpv, Duration::from_secs(15), |e| {
        matches!(e, MpvEvent::PlaybackRestart)
    })
    .map(|_| ())
    .ok_or_else(|| format!("{file}: no llegó playback-restart"))
}

fn info() -> Result<(), String> {
    let mpv = new_player(&[("geometry", "320x180+40+40")])?;
    for property in ["mpv-version", "ffmpeg-version", "libass-version", "mpv-configuration"] {
        println!(
            "{property}: {}",
            mpv.get_property_string(property).unwrap_or_default()
        );
    }
    println!("Monitores del SO (lo que Tauri devuelve como `name` en Windows):");
    for monitor in os::monitors() {
        println!("  {monitor}");
    }
    let fixture = std::env::var("SPIKE_FIXTURE").unwrap_or_default();
    if !fixture.is_empty() {
        load_and_wait(&mpv, &fixture)?;
    }
    std::thread::sleep(Duration::from_millis(500));
    println!(
        "mpv display-names: {}",
        mpv.get_property_string("display-names")
            .unwrap_or_else(|e| e.to_string())
    );
    Ok(())
}

fn screen(name: &str, file: &str) -> Result<(), String> {
    let before = os::foreground();
    println!("foco antes: {before}");
    let mpv = new_player(&[
        ("fs", "yes"),
        ("fs-screen-name", name),
        ("border", "no"),
        ("ontop", "yes"),
    ])?;
    load_and_wait(&mpv, file)?;
    std::thread::sleep(Duration::from_millis(800));
    let after_open = os::foreground();
    println!("foco tras abrir a pantalla completa: {after_open}");
    println!(
        "display-names: {}",
        mpv.get_property_string("display-names").unwrap_or_default()
    );
    for round in 1..=2 {
        load_and_wait(&mpv, file)?;
        std::thread::sleep(Duration::from_millis(800));
        println!("foco tras cambio de fichero {round}: {}", os::foreground());
    }
    println!(
        "fullscreen={} window-scale={} osd-dimensions={}",
        mpv.get_property_string("fullscreen").unwrap_or_default(),
        mpv.get_property_string("current-window-scale")
            .unwrap_or_default(),
        mpv.get_property_string("osd-dimensions").unwrap_or_default()
    );
    std::thread::sleep(Duration::from_secs(2));
    let robbed = before != after_open || before != os::foreground();
    println!("ROBA_FOCO={robbed}");
    Ok(())
}

/// Ventana propia no activable en el rectángulo del monitor, con mpv
/// incrustado (`wid`). La alternativa del paso 01 cuando la ventana de mpv
/// roba el foco.
#[cfg(windows)]
fn embed(x: i32, y: i32, width: i32, height: i32, file: &str) -> Result<(), String> {
    let before = os::foreground();
    println!("foco antes: {before}");
    let hwnd = os::spawn_surface(x, y, width, height)?;
    std::thread::sleep(Duration::from_millis(300));
    println!("foco tras crear la superficie: {}", os::foreground());
    let wid = (hwnd as isize).to_string();
    let mpv = new_player(&[("wid", &wid), ("force-window", "yes")])?;
    load_and_wait(&mpv, file)?;
    std::thread::sleep(Duration::from_millis(800));
    let after_open = os::foreground();
    println!("foco tras abrir: {after_open}");
    println!(
        "display-names: {}",
        mpv.get_property_string("display-names").unwrap_or_default()
    );
    for round in 1..=2 {
        load_and_wait(&mpv, file)?;
        std::thread::sleep(Duration::from_millis(800));
        println!("foco tras cambio de fichero {round}: {}", os::foreground());
    }
    mpv.set_property_f64("brightness", -100.0).ok();
    std::thread::sleep(Duration::from_millis(600));
    println!("negro por brightness=-100: foco {}", os::foreground());
    mpv.set_property_f64("brightness", 0.0).ok();
    println!(
        "osd-dimensions={}",
        mpv.get_property_string("osd-dimensions").unwrap_or_default()
    );
    std::thread::sleep(Duration::from_secs(2));
    let robbed = before != after_open || before != os::foreground();
    println!("ROBA_FOCO={robbed}");
    Ok(())
}

#[cfg(not(windows))]
fn embed(_: i32, _: i32, _: i32, _: i32, _: &str) -> Result<(), String> {
    Err("embed solo implementado en Windows en el spike".into())
}

/// Tiny LCG: deterministic seek positions without a rand dependency.
struct Lcg(u64);
impl Lcg {
    fn next_f64(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let index = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[index]
}

fn seek(file: &str, hwdec: &str, count: usize) -> Result<(), String> {
    let mpv = new_player(&[
        ("geometry", "480x270+40+40"),
        ("hwdec", hwdec),
        ("pause", "yes"),
    ])?;
    load_and_wait(&mpv, file)?;
    let duration = mpv.get_property_f64("duration").map_err(|e| e.to_string())?;
    let fps = mpv.get_property_f64("container-fps").unwrap_or(30.0);
    std::thread::sleep(Duration::from_millis(300));
    let hw = mpv.get_property_string("hwdec-current").unwrap_or_default();
    let codec = mpv.get_property_string("video-codec").unwrap_or_default();

    let mut rng = Lcg(0x5eed);
    let mut samples = Vec::with_capacity(count);
    let mut misplaced = 0;
    for _ in 0..count {
        let target = rng.next_f64() * (duration - 1.0);
        let target_text = format!("{target:.3}");
        let started = Instant::now();
        mpv.command(&["seek", &target_text, "absolute+exact"])
            .map_err(|e| e.to_string())?;
        if wait_for(&mpv, Duration::from_secs(10), |e| {
            matches!(e, MpvEvent::PlaybackRestart)
        })
        .is_none()
        {
            return Err(format!("seek a {target_text}: sin playback-restart"));
        }
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
        let landed = mpv.get_property_f64("time-pos").unwrap_or(f64::NAN);
        if (landed - target).abs() > 1.0 / fps + 1e-3 {
            misplaced += 1;
        }
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "SEEK file={} codec={codec} hwdec_pedido={hwdec} hwdec_activo={hw} n={count} p50={:.1}ms p95={:.1}ms max={:.1}ms fuera_de_fotograma={misplaced}",
        Path::new(file).file_name().unwrap().to_string_lossy(),
        percentile(&samples, 0.5),
        percentile(&samples, 0.95),
        samples.last().copied().unwrap_or(f64::NAN),
    );
    Ok(())
}

/// Seguir un reloj maestro simulado (`rate` × tiempo real) con la ley de la
/// sección 4.6 del diseño, y registrar el error cada tick.
fn follow(file: &str, seconds: f64, rate: f64, csv: &str, gain_k: f64) -> Result<(), String> {
    let mpv = new_player(&[("geometry", "480x270+40+40"), ("hwdec", "auto-safe")])?;
    mpv.observe_property(1, "time-pos", ObserveAs::Double)
        .map_err(|e| e.to_string())?;
    mpv.set_property_flag("pause", true)
        .map_err(|e| e.to_string())?;
    load_and_wait(&mpv, file)?;
    let fps = mpv.get_property_f64("container-fps").unwrap_or(30.0);
    let frame = 1.0 / fps;
    let mut out = std::fs::File::create(csv).map_err(|e| e.to_string())?;
    writeln!(out, "t,target,time_pos,error,filtered,speed,action").unwrap();

    mpv.set_property_f64("speed", rate).ok();
    mpv.set_property_flag("pause", false).ok();
    let start = Instant::now();
    let mut time_pos = 0.0_f64;
    let mut time_pos_at = Instant::now();
    let mut filtered: Option<f64> = None;
    let mut speed = rate;
    let mut seeks = 0;
    let mut errors = Vec::new();
    let tick = Duration::from_millis(10);
    let mut next_tick = Instant::now();
    loop {
        // Drain events, remembering when time-pos last changed: between
        // updates it is extrapolated at the current speed, which is how the
        // runtime will read it.
        while let Some(event) = mpv.wait_event(0.0) {
            if let MpvEvent::PropertyChange {
                value: PropertyValue::Double(value),
                ..
            } = event
            {
                time_pos = value;
                time_pos_at = Instant::now();
            }
        }
        let now = Instant::now();
        let t = now.duration_since(start).as_secs_f64();
        if t > seconds {
            break;
        }
        let target = t * rate;
        let player = time_pos + now.duration_since(time_pos_at).as_secs_f64() * speed;
        let error = player - target;
        let smoothed = match filtered {
            None => error,
            Some(previous) => previous + 0.1 * (error - previous),
        };
        filtered = Some(smoothed);
        let action;
        if smoothed.abs() > 0.25 {
            mpv.command(&["seek", &format!("{:.4}", target + 0.05), "absolute+exact"])
                .ok();
            filtered = None;
            seeks += 1;
            action = "seek";
        } else if smoothed.abs() > frame {
            speed = rate * (1.0 - gain_k * smoothed).clamp(0.95, 1.05);
            mpv.set_property_f64("speed", speed).ok();
            action = "speed";
        } else if smoothed.abs() <= frame / 2.0 && (speed - rate).abs() > 1e-9 {
            speed = rate;
            mpv.set_property_f64("speed", speed).ok();
            action = "base";
        } else {
            action = "";
        }
        if t > 1.0 {
            errors.push(smoothed.abs());
        }
        writeln!(
            out,
            "{t:.4},{target:.4},{time_pos:.4},{error:.5},{smoothed:.5},{speed:.5},{action}"
        )
        .unwrap();
        next_tick += tick;
        if let Some(wait) = next_tick.checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
    }
    errors.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "FOLLOW file={} rate={rate} k={gain_k} dur={seconds}s ticks={} |e|p50={:.1}ms p95={:.1}ms max={:.1}ms seeks={seeks} drops={}",
        Path::new(file).file_name().unwrap().to_string_lossy(),
        errors.len(),
        percentile(&errors, 0.5) * 1000.0,
        percentile(&errors, 0.95) * 1000.0,
        errors.last().copied().unwrap_or(f64::NAN) * 1000.0,
        mpv.get_property_i64("frame-drop-count").unwrap_or(-1),
    );
    Ok(())
}

fn coexist(engine_ffmpeg_dir: &str, file: &str) -> Result<(), String> {
    let dir = Path::new(engine_ffmpeg_dir);
    let avcodec = os::load_with_dependencies(&dir.join("avcodec-62.dll"))?;
    let avformat = os::load_with_dependencies(&dir.join("avformat-62.dll"))?;
    unsafe {
        let version: libloading::Symbol<unsafe extern "C" fn() -> u32> =
            avcodec.get(b"avcodec_version\0").map_err(|e| e.to_string())?;
        let find: libloading::Symbol<
            unsafe extern "C" fn(*const std::ffi::c_char) -> *const std::ffi::c_void,
        > = avcodec
            .get(b"avcodec_find_decoder_by_name\0")
            .map_err(|e| e.to_string())?;
        let v = version();
        println!(
            "FFmpeg del motor: avcodec {}.{}.{}",
            v >> 16,
            (v >> 8) & 0xff,
            v & 0xff
        );
        for decoder in ["mp3float", "flac", "aac"] {
            let name = std::ffi::CString::new(decoder).unwrap();
            println!("  decodificador {decoder}: {}", !find(name.as_ptr()).is_null());
        }
        let _ = &avformat;
    }

    let mpv = new_player(&[("geometry", "480x270+40+40"), ("hwdec", "auto-safe")])?;
    load_and_wait(&mpv, file)?;
    std::thread::sleep(Duration::from_secs(3));
    println!(
        "mpv reproduce {} con hwdec={} time-pos={:.2}",
        mpv.get_property_string("video-codec").unwrap_or_default(),
        mpv.get_property_string("hwdec-current").unwrap_or_default(),
        mpv.get_property_f64("time-pos").unwrap_or(f64::NAN)
    );
    // The engine's decoders are still there after mpv started decoding.
    unsafe {
        let find: libloading::Symbol<
            unsafe extern "C" fn(*const std::ffi::c_char) -> *const std::ffi::c_void,
        > = avcodec
            .get(b"avcodec_find_decoder_by_name\0")
            .map_err(|e| e.to_string())?;
        let name = std::ffi::CString::new("flac").unwrap();
        println!(
            "  flac del motor sigue disponible: {}",
            !find(name.as_ptr()).is_null()
        );
    }
    println!("Módulos FFmpeg/mpv cargados en el proceso:");
    for module in os::modules() {
        let lower = module.to_lowercase();
        let file_name = lower.rsplit(['\\', '/']).next().unwrap_or(&lower).to_string();
        if ["avcodec", "avformat", "avutil", "swresample", "swscale", "avfilter", "mpv"]
            .iter()
            .any(|prefix| file_name.starts_with(prefix) || file_name.starts_with(&format!("lib{prefix}")))
        {
            println!("  {module}");
        }
    }
    Ok(())
}

#[cfg(windows)]
mod os {
    use std::ffi::c_void;
    use std::path::Path;

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

    type MonitorEnumProc = unsafe extern "system" fn(Handle, Handle, *mut Rect, isize) -> i32;

    #[link(name = "user32")]
    extern "system" {
        fn EnumDisplayMonitors(hdc: Handle, clip: *const Rect, proc_: MonitorEnumProc, data: isize) -> i32;
        fn GetMonitorInfoW(monitor: Handle, info: *mut MonitorInfoExW) -> i32;
        fn GetForegroundWindow() -> Handle;
        fn GetWindowTextW(hwnd: Handle, text: *mut u16, max: i32) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> Handle;
        fn K32EnumProcessModules(process: Handle, modules: *mut Handle, cb: u32, needed: *mut u32) -> i32;
        fn K32GetModuleFileNameExW(process: Handle, module: Handle, name: *mut u16, size: u32) -> u32;
    }

    unsafe extern "system" fn collect(monitor: Handle, _: Handle, _: *mut Rect, data: isize) -> i32 {
        let out = &mut *(data as *mut Vec<String>);
        let mut info: MonitorInfoExW = std::mem::zeroed();
        info.size = std::mem::size_of::<MonitorInfoExW>() as u32;
        if GetMonitorInfoW(monitor, &mut info) != 0 {
            let end = info.device.iter().position(|c| *c == 0).unwrap_or(32);
            let name = String::from_utf16_lossy(&info.device[..end]);
            out.push(format!(
                "{name} {}x{} en ({},{}) principal={}",
                info.monitor.right - info.monitor.left,
                info.monitor.bottom - info.monitor.top,
                info.monitor.left,
                info.monitor.top,
                info.flags & 1 == 1
            ));
        }
        1
    }

    pub fn monitors() -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        unsafe {
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                collect,
                &mut out as *mut Vec<String> as isize,
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

    pub fn modules() -> Vec<String> {
        unsafe {
            let process = GetCurrentProcess();
            let mut handles = vec![std::ptr::null_mut(); 1024];
            let mut needed = 0u32;
            K32EnumProcessModules(
                process,
                handles.as_mut_ptr(),
                (handles.len() * std::mem::size_of::<Handle>()) as u32,
                &mut needed,
            );
            let count = needed as usize / std::mem::size_of::<Handle>();
            handles[..count.min(handles.len())]
                .iter()
                .map(|module| {
                    let mut name = [0u16; 520];
                    let len = K32GetModuleFileNameExW(process, *module, name.as_mut_ptr(), 520) as usize;
                    String::from_utf16_lossy(&name[..len])
                })
                .collect()
        }
    }

    #[repr(C)]
    struct WndClassExW {
        size: u32,
        style: u32,
        wnd_proc: unsafe extern "system" fn(Handle, u32, usize, isize) -> isize,
        cls_extra: i32,
        wnd_extra: i32,
        instance: Handle,
        icon: Handle,
        cursor: Handle,
        background: Handle,
        menu_name: *const u16,
        class_name: *const u16,
        icon_small: Handle,
    }

    #[repr(C)]
    struct Msg {
        hwnd: Handle,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        pt: [i32; 2],
        private: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn RegisterClassExW(class: *const WndClassExW) -> u16;
        fn CreateWindowExW(
            ex_style: u32,
            class: *const u16,
            name: *const u16,
            style: u32,
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            parent: Handle,
            menu: Handle,
            instance: Handle,
            param: *mut c_void,
        ) -> Handle;
        fn DefWindowProcW(hwnd: Handle, msg: u32, wparam: usize, lparam: isize) -> isize;
        fn ShowWindow(hwnd: Handle, cmd: i32) -> i32;
        fn GetMessageW(msg: *mut Msg, hwnd: Handle, min: u32, max: u32) -> i32;
        fn TranslateMessage(msg: *const Msg) -> i32;
        fn DispatchMessageW(msg: *const Msg) -> isize;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> Handle;
    }
    #[link(name = "gdi32")]
    extern "system" {
        fn GetStockObject(kind: i32) -> Handle;
    }

    const WM_MOUSEACTIVATE: u32 = 0x0021;
    const MA_NOACTIVATE: isize = 3;

    unsafe extern "system" fn surface_proc(hwnd: Handle, msg: u32, wparam: usize, lparam: isize) -> isize {
        if msg == WM_MOUSEACTIVATE {
            return MA_NOACTIVATE;
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Create a borderless, topmost, never-activated window on its own
    /// thread (with its message loop) and return its HWND.
    pub fn spawn_surface(x: i32, y: i32, w: i32, h: i32) -> Result<Handle, String> {
        let (tx, rx) = std::sync::mpsc::channel::<usize>();
        std::thread::spawn(move || unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let class_name = wide("LibreTracksVideoSurface");
            let class = WndClassExW {
                size: std::mem::size_of::<WndClassExW>() as u32,
                style: 0,
                wnd_proc: surface_proc,
                cls_extra: 0,
                wnd_extra: 0,
                instance,
                icon: std::ptr::null_mut(),
                cursor: std::ptr::null_mut(),
                background: GetStockObject(4), // BLACK_BRUSH
                menu_name: std::ptr::null(),
                class_name: class_name.as_ptr(),
                icon_small: std::ptr::null_mut(),
            };
            RegisterClassExW(&class);
            const WS_EX_TOPMOST: u32 = 0x0000_0008;
            const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
            const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
            const WS_POPUP: u32 = 0x8000_0000;
            const WS_CLIPCHILDREN: u32 = 0x0200_0000;
            let title = wide("LibreTracks – salida de vídeo");
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                class_name.as_ptr(),
                title.as_ptr(),
                WS_POPUP | WS_CLIPCHILDREN,
                x,
                y,
                w,
                h,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null_mut(),
            );
            ShowWindow(hwnd, 4); // SW_SHOWNOACTIVATE
            tx.send(hwnd as usize).ok();
            let mut msg: Msg = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
        let hwnd = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        if hwnd == 0 {
            return Err("CreateWindowExW falló".into());
        }
        Ok(hwnd as Handle)
    }

    pub fn load_with_dependencies(path: &Path) -> Result<libloading::Library, String> {
        // LOAD_WITH_ALTERED_SEARCH_PATH: resolve the DLL's own dependencies
        // (avutil, swresample…) from its directory, as the engine does.
        unsafe { libloading::os::windows::Library::load_with_flags(path, 0x0000_0008) }
            .map(Into::into)
            .map_err(|e| format!("{}: {e}", path.display()))
    }
}

#[cfg(not(windows))]
mod os {
    use std::path::Path;
    pub fn monitors() -> Vec<String> {
        vec!["(enumeración de monitores del spike solo implementada en Windows)".into()]
    }
    pub fn foreground() -> String {
        "(n/d)".into()
    }
    pub fn modules() -> Vec<String> {
        std::fs::read_to_string("/proc/self/maps")
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.split_whitespace().nth(5).map(str::to_string))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }
    pub fn load_with_dependencies(path: &Path) -> Result<libloading::Library, String> {
        unsafe { libloading::Library::new(path) }.map_err(|e| e.to_string())
    }
}
