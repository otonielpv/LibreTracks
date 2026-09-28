//! The macOS output surface (paso 15, D2/D3): a panel of our own that never
//! takes the focus, one OpenGL view per player slot, and mpv drawing into each
//! view through its render API on a thread of its own.
//!
//! Why not what Windows and Linux do: AppKit only works on the main thread,
//! which belongs to the app (Tauri), so mpv can neither open its own window
//! nor draw into ours with `wid`. Instead:
//!
//! * **Main thread** (reached through the injected [`MainThread`]): create,
//!   move, show and hide the panel and its views, bind each `NSOpenGLContext`
//!   to its view. Never waits on mpv.
//! * **Render thread per slot**: creates the `mpv_render_context` with the
//!   slot's GL context current, sleeps until mpv's update callback wakes it,
//!   draws, swaps, reports the swap; frees the render context on the way out,
//!   GL context still current (render.h).
//!
//! Measured in the spike (bitácora `state/15.md`): creating and destroying the
//! GL contexts on every open lost ~13.5 MB each time in AppKit's software
//! surface path, so the surface is **persistent**: closing the output hides
//! the panel and stops the players; the panel and contexts live on. It also
//! restyles in place between fullscreen and a window the user can move and
//! resize (a double-click on it toggles, as in Ableton).
//!
//! The panel is non-activating and only becomes key if a view needs it (ours
//! never do), so clicking it — to move, resize or double-click — leaves the
//! keyboard with the app.

// OpenGL is deprecated on macOS but present and working up to the latest
// release, and it is the only API mpv's render API offers (plan D4).
#![allow(deprecated)]

use std::ffi::{c_char, c_void};
use std::ptr::NonNull;
use std::cell::OnceCell;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSBackingStoreType, NSColor, NSEvent, NSOpenGLContext,
    NSOpenGLContextParameter, NSOpenGLPFAAllowOfflineRenderers, NSOpenGLPFADoubleBuffer,
    NSOpenGLPFAOpenGLProfile, NSOpenGLPixelFormat, NSOpenGLPixelFormatAttribute,
    NSOpenGLProfileVersion3_2Core, NSPanel, NSResponder, NSScreen, NSView,
    NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_foundation::{
    NSActivityOptions, NSObject, NSObjectProtocol, NSPoint, NSProcessInfo, NSRect, NSSize,
    NSString,
};
use objc2_open_gl::{
    CGLContextObj, CGLFlushDrawable, CGLLockContext, CGLSetCurrentContext, CGLUnlockContext,
};

use crate::mac_geometry::{cocoa_frame_for, CocoaRect, CocoaScreen};
use crate::monitors::SurfacePlan;
use crate::mpv::Mpv;
use crate::render::{RenderApi, RenderContext, RenderTarget, UPDATE_FRAME};

/// Runs a job on the AppKit main thread. The desktop app builds it on
/// `AppHandle::run_on_main_thread`; this crate stays free of Tauri.
pub type MainThread = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

/// `NSMainMenuWindowLevel + 1`: above the menu bar of the chosen display.
const FULLSCREEN_LEVEL: isize = 25;
/// `NSNormalWindowLevel`.
const NORMAL_LEVEL: isize = 0;

/// Run `job` on the main thread and wait for its result.
fn on_main<T: Send + 'static>(
    main: &MainThread,
    job: impl FnOnce(MainThreadMarker) -> T + Send + 'static,
) -> Result<T, String> {
    if let Some(mtm) = MainThreadMarker::new() {
        return Ok(job(mtm));
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    main(Box::new(move || {
        let mtm = MainThreadMarker::new().expect("MainThread must run jobs on the main thread");
        let _ = sender.send(job(mtm));
    }));
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "el hilo principal no respondió a la salida de vídeo".to_string())
}

/// AppKit objects, only ever touched on the main thread (inside [`on_main`]).
struct Ui {
    panel: Retained<NSPanel>,
    views: [Retained<NSView>; 2],
    contexts: [Retained<NSOpenGLContext>; 2],
    /// Keeps App Nap away while the output is showing (D7).
    activity: Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    fullscreen: bool,
    /// Where the user left the window (monitor, frame): going back from
    /// fullscreen puts it there instead of re-centring it.
    last_window: Option<(String, NSRect)>,
}

/// Moves main-thread-only values across threads; they are only dereferenced
/// inside [`on_main`] jobs.
struct MainOnly<T>(T);
// SAFETY: see the type's doc; every use happens on the main thread.
unsafe impl<T> Send for MainOnly<T> {}

#[derive(Clone, Copy)]
struct Cgl(CGLContextObj);
// SAFETY: a CGL context may be used from any thread under CGLLockContext,
// which the render thread takes around every use.
unsafe impl Send for Cgl {}
unsafe impl Sync for Cgl {}

/// What the render thread of a slot shares with the surface.
struct GlSlot {
    cgl: Cgl,
    /// Drawable size in pixels, `width << 32 | height` (updated on resize).
    pixels: Arc<AtomicU64>,
}

fn pack(width: f64, height: f64) -> u64 {
    ((width.max(1.0) as u64) << 32) | (height.max(1.0) as u64 & 0xffff_ffff)
}

fn unpack(packed: u64) -> (i32, i32) {
    ((packed >> 32) as i32, (packed & 0xffff_ffff) as i32)
}

/// Wakes a render thread: mpv's update callback, or a stop request.
#[derive(Default)]
struct Wake {
    state: Mutex<(bool, bool)>, // (dirty, stop)
    signal: Condvar,
}

impl Wake {
    fn poke(&self, stop: bool) {
        if let Ok(mut state) = self.state.lock() {
            state.0 = true;
            state.1 |= stop;
        }
        self.signal.notify_one();
    }

    /// Wait for work. `false` when asked to stop.
    fn wait(&self) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        while !state.0 && !state.1 {
            match self.signal.wait_timeout(state, Duration::from_millis(500)) {
                Ok((next, _)) => state = next,
                Err(_) => return false,
            }
        }
        state.0 = false;
        !state.1
    }
}

/// The render threads' wakers, by slot, while attached.
type Wakes = Arc<Mutex<[Option<Arc<Wake>>; 2]>>;

/// What the content view needs to follow a resize by the user: the GL
/// contexts must be told on the main thread, the render threads get the new
/// size and redraw (a paused picture would otherwise stay stretched).
struct ResizeTarget {
    views: [Retained<NSView>; 2],
    contexts: [Retained<NSOpenGLContext>; 2],
    pixels: [Arc<AtomicU64>; 2],
    wakes: Wakes,
}

impl ResizeTarget {
    fn follow(&self, mtm: MainThreadMarker) {
        for index in 0..2 {
            self.contexts[index].update(mtm);
            self.pixels[index].store(backing_pixels(&self.views[index]), Ordering::Relaxed);
        }
        if let Ok(wakes) = self.wakes.lock() {
            for wake in wakes.iter().flatten() {
                wake.poke(false);
            }
        }
    }
}

struct ContentIvars {
    double_clicks: Arc<AtomicU32>,
    resize: OnceCell<ResizeTarget>,
}

define_class!(
    // SAFETY: NSView may be subclassed; the overrides keep AppKit's
    // signatures and `setFrameSize:` calls super first.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "LibreTracksVideoContentView"]
    #[ivars = ContentIvars]
    struct ContentView;

    impl ContentView {
        /// The panel is never key, so without this the first click (half of
        /// a double-click) would only be taken as focusing it.
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            if event.clickCount() == 2 {
                self.ivars().double_clicks.fetch_add(1, Ordering::Relaxed);
            }
        }

        #[unsafe(method(setFrameSize:))]
        fn set_frame_size(&self, size: NSSize) {
            // SAFETY: NSView's own implementation, same signature.
            let _: () = unsafe { msg_send![super(self), setFrameSize: size] };
            if let Some(target) = self.ivars().resize.get() {
                target.follow(self.mtm());
            }
        }
    }
);

unsafe extern "C" fn on_mpv_update(data: *mut c_void) {
    // SAFETY: `data` is the `Wake` the render thread keeps alive until the
    // render context (and so this callback) is gone.
    let wake = unsafe { &*(data as *const Wake) };
    wake.poke(false);
}

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

/// `RTLD_DEFAULT` on macOS.
const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

unsafe extern "C" fn gl_proc_address(_: *mut c_void, name: *const c_char) -> *mut c_void {
    // OpenGL.framework is loaded (we link its CGL calls), so every gl* entry
    // point is in the default namespace.
    unsafe { dlsym(RTLD_DEFAULT, name) }
}

struct SlotRender {
    wake: Arc<Wake>,
    thread: JoinHandle<()>,
}

/// The panel, its two views and their render threads.
pub struct MacSurface {
    main: MainThread,
    ui: Option<MainOnly<Ui>>,
    gl: [GlSlot; 2],
    renders: [Option<SlotRender>; 2],
    wakes: Wakes,
    /// Double-clicks on the panel (counted by the view) and how many the
    /// backend has seen.
    double_clicks: Arc<AtomicU32>,
    seen_double_clicks: AtomicU32,
}

fn screens(mtm: MainThreadMarker) -> Vec<CocoaScreen> {
    NSScreen::screens(mtm)
        .iter()
        .map(|screen| {
            let frame = screen.frame();
            CocoaScreen {
                frame: CocoaRect {
                    x: frame.origin.x,
                    y: frame.origin.y,
                    width: frame.size.width,
                    height: frame.size.height,
                },
                scale: screen.backingScaleFactor(),
            }
        })
        .collect()
}

fn frame_for(plan: &SurfacePlan, mtm: MainThreadMarker) -> NSRect {
    let rect = match cocoa_frame_for(&plan.rect, &screens(mtm)) {
        Some((rect, _)) => rect,
        None => CocoaRect {
            x: f64::from(plan.rect.x),
            y: f64::from(plan.rect.y),
            width: f64::from(plan.rect.width),
            height: f64::from(plan.rect.height),
        },
    };
    NSRect::new(
        NSPoint::new(rect.x, rect.y),
        NSSize::new(rect.width.max(1.0), rect.height.max(1.0)),
    )
}

/// Borderless and above the menu bar (if on top) for fullscreen; a small
/// titled window the user can move and resize otherwise. Never activates the
/// app, never becomes key.
fn configure(ui: &mut Ui, plan: &SurfacePlan, mtm: MainThreadMarker) {
    let panel = &ui.panel;
    if !ui.fullscreen {
        ui.last_window = Some((plan.monitor_name.clone(), panel.frame()));
    }
    let style = if plan.fullscreen {
        NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel
    } else {
        NSWindowStyleMask::Titled
            | NSWindowStyleMask::Resizable
            | NSWindowStyleMask::UtilityWindow
            | NSWindowStyleMask::NonactivatingPanel
    };
    if panel.styleMask() != style {
        panel.setStyleMask(style);
    }
    panel.setBecomesKeyOnlyIfNeeded(true);
    panel.setIgnoresMouseEvents(false);
    panel.setLevel(if plan.on_top { FULLSCREEN_LEVEL } else { NORMAL_LEVEL });
    panel.setCollectionBehavior(if plan.fullscreen {
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle
    } else {
        NSWindowCollectionBehavior::FullScreenAuxiliary
    });
    let frame = match &ui.last_window {
        Some((monitor, frame)) if !plan.fullscreen && *monitor == plan.monitor_name => *frame,
        _ if plan.fullscreen => frame_for(plan, mtm),
        _ => panel.frameRectForContentRect(frame_for(plan, mtm)),
    };
    panel.setFrame_display(frame, true);
    ui.fullscreen = plan.fullscreen;
}

fn backing_pixels(view: &NSView) -> u64 {
    let backing = view.convertRectToBacking(view.bounds());
    pack(backing.size.width, backing.size.height)
}

fn begin_activity() -> Retained<ProtocolObject<dyn NSObjectProtocol>> {
    NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiated
            | NSActivityOptions::LatencyCritical
            | NSActivityOptions::IdleDisplaySleepDisabled,
        &NSString::from_str("LibreTracks: salida de vídeo"),
    )
}

fn end_activity(ui: &mut Ui) {
    if let Some(activity) = ui.activity.take() {
        // SAFETY: the token came from beginActivityWithOptions_reason.
        unsafe { NSProcessInfo::processInfo().endActivity(&activity) };
    }
}

/// What the surface shares with the main-thread UI it builds.
struct Shared {
    pixels: [Arc<AtomicU64>; 2],
    wakes: Wakes,
    double_clicks: Arc<AtomicU32>,
}

fn build_ui(
    plan: &SurfacePlan,
    title: &str,
    shared_state: Shared,
    mtm: MainThreadMarker,
) -> Result<(Ui, [Cgl; 2]), String> {
    let frame = frame_for(plan, mtm);
    let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
        NSPanel::alloc(mtm),
        frame,
        NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
        NSBackingStoreType::Buffered,
        false,
    );
    // SAFETY: we keep our own reference; AppKit must not release it on close.
    unsafe { panel.setReleasedWhenClosed(false) };
    panel.setHidesOnDeactivate(false);
    panel.setBackgroundColor(Some(&NSColor::blackColor()));
    panel.setTitle(&NSString::from_str(title));

    let content = ContentView::alloc(mtm).set_ivars(ContentIvars {
        double_clicks: Arc::clone(&shared_state.double_clicks),
        resize: OnceCell::new(),
    });
    // SAFETY: NSView's designated initialiser.
    let content: Retained<ContentView> = unsafe {
        msg_send![super(content), initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), frame.size)]
    };
    panel.setContentView(Some(&content));

    let mut attributes: [NSOpenGLPixelFormatAttribute; 6] = [
        NSOpenGLPFADoubleBuffer,
        NSOpenGLPFAOpenGLProfile,
        NSOpenGLProfileVersion3_2Core,
        NSOpenGLPFAAllowOfflineRenderers,
        0,
        0,
    ];
    let mut views = Vec::with_capacity(2);
    let mut contexts = Vec::with_capacity(2);
    let mut shared = Vec::with_capacity(2);
    for index in 0..2 {
        let view = NSView::initWithFrame(NSView::alloc(mtm), content.bounds());
        view.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        #[allow(deprecated)]
        view.setWantsBestResolutionOpenGLSurface(true);
        view.setHidden(index == 1);
        content.addSubview(&view);

        // SAFETY: zero-terminated attribute list alive for the call.
        let format = unsafe {
            NSOpenGLPixelFormat::initWithAttributes(
                NSOpenGLPixelFormat::alloc(),
                NonNull::new(attributes.as_mut_ptr()).expect("non-null array"),
            )
        }
        .ok_or("macOS no ofrece un formato OpenGL 3.2 para la salida de vídeo")?;
        let context =
            NSOpenGLContext::initWithFormat_shareContext(NSOpenGLContext::alloc(), &format, None)
                .ok_or("no se pudo crear el contexto OpenGL de la salida de vídeo")?;
        let swap_interval: i32 = 1;
        // SAFETY: one GLint, alive for the call.
        unsafe {
            context.setValues_forParameter(
                NonNull::from(&swap_interval),
                NSOpenGLContextParameter::SwapInterval,
            )
        };
        context.setView(Some(&view), mtm);
        shared.push(Cgl(context.CGLContextObj()));
        views.push(view);
        contexts.push(context);
    }
    let mut ui = Ui {
        panel,
        views: [views.remove(0), views.remove(0)],
        contexts: [contexts.remove(0), contexts.remove(0)],
        activity: Some(begin_activity()),
        // Built borderless: `configure` restyles when the plan is a window.
        fullscreen: true,
        last_window: None,
    };
    let target = ResizeTarget {
        views: ui.views.clone(),
        contexts: ui.contexts.clone(),
        pixels: shared_state.pixels,
        wakes: shared_state.wakes,
    };
    configure(&mut ui, plan, mtm);
    target.follow(mtm);
    let _ = content.ivars().resize.set(target);
    ui.panel.orderFrontRegardless();
    Ok((ui, [shared[0], shared[1]]))
}

impl MacSurface {
    /// Create the panel on the plan's display and show it.
    pub fn create(plan: &SurfacePlan, main: MainThread, title: &str) -> Result<Self, String> {
        let plan_owned = plan.clone();
        let title = title.to_string();
        let pixels = [Arc::new(AtomicU64::new(pack(1.0, 1.0))), Arc::new(AtomicU64::new(pack(1.0, 1.0)))];
        let wakes: Wakes = Arc::new(Mutex::new([None, None]));
        let double_clicks = Arc::new(AtomicU32::new(0));
        let shared_state = Shared {
            pixels: pixels.clone(),
            wakes: Arc::clone(&wakes),
            double_clicks: Arc::clone(&double_clicks),
        };
        let (ui, cgls) = on_main(&main, move |mtm| {
            build_ui(&plan_owned, &title, shared_state, mtm).map(|(ui, cgls)| (MainOnly(ui), cgls))
        })??;
        let [first, second] = pixels;
        Ok(Self {
            main,
            ui: Some(ui),
            gl: [
                GlSlot { cgl: cgls[0], pixels: first },
                GlSlot { cgl: cgls[1], pixels: second },
            ],
            renders: [None, None],
            wakes,
            double_clicks,
            seen_double_clicks: AtomicU32::new(0),
        })
    }

    /// Whether the panel was double-clicked since the last call.
    pub fn take_double_click(&self) -> bool {
        let clicks = self.double_clicks.load(Ordering::Relaxed);
        self.seen_double_clicks.swap(clicks, Ordering::Relaxed) != clicks
    }

    fn with_ui<T: Send + 'static>(
        &mut self,
        job: impl FnOnce(&mut Ui, MainThreadMarker) -> T + Send + 'static,
    ) -> Option<T> {
        let ui = self.ui.take()?;
        let result = on_main(&self.main, move |mtm| {
            let mut ui = ui;
            let value = job(&mut ui.0, mtm);
            (ui, value)
        });
        match result {
            Ok((ui, value)) => {
                self.ui = Some(ui);
                Some(value)
            }
            // The main thread did not answer: the panel is lost to us.
            Err(_) => None,
        }
    }

    /// Move to the plan's display/rect and restyle to its mode; the content
    /// view follows the new size (see [`ResizeTarget`]).
    pub fn apply(&mut self, plan: &SurfacePlan) {
        let plan = plan.clone();
        self.with_ui(move |ui, mtm| configure(ui, &plan, mtm));
    }

    /// Bring the panel back after [`MacSurface::hide`].
    pub fn show(&mut self) {
        self.with_ui(|ui, _| {
            ui.panel.orderFrontRegardless();
            if ui.activity.is_none() {
                ui.activity = Some(begin_activity());
            }
        });
    }

    /// Hide the panel (closing the output keeps it: see the module doc).
    pub fn hide(&mut self) {
        self.with_ui(|ui, _| {
            ui.panel.orderOut(None);
            end_activity(ui);
        });
    }

    /// Show one slot's view, hide the other (A/B swap, paso 08).
    pub fn show_slot(&mut self, index: usize) {
        self.with_ui(move |ui, _| {
            ui.views[0].setHidden(index != 0);
            ui.views[1].setHidden(index != 1);
        });
    }

    /// Start drawing `mpv` (initialised with `vo=libmpv`) into slot `index`.
    /// Waits until its render context exists, or fails with mpv's reason.
    pub fn attach(&mut self, index: usize, mpv: &Mpv, api: Arc<RenderApi>) -> Result<(), String> {
        self.detach(index);
        let target = RenderTarget::of(mpv);
        let cgl = self.gl[index].cgl;
        let pixels = Arc::clone(&self.gl[index].pixels);
        let wake = Arc::new(Wake::default());
        let (ready, started) = mpsc::sync_channel(1);
        let thread_wake = Arc::clone(&wake);
        let thread = std::thread::Builder::new()
            .name(format!("video-render-{index}"))
            .spawn(move || render_loop(target, api, cgl, pixels, thread_wake, ready, index))
            .map_err(|error| error.to_string())?;
        match started.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => {
                if let Ok(mut wakes) = self.wakes.lock() {
                    wakes[index] = Some(Arc::clone(&wake));
                }
                self.renders[index] = Some(SlotRender { wake, thread });
                Ok(())
            }
            Ok(Err(reason)) => {
                let _ = thread.join();
                Err(reason)
            }
            Err(_) => {
                wake.poke(true);
                Err("el render de vídeo no arrancó".into())
            }
        }
    }

    /// Stop drawing slot `index`: its render context is freed before this
    /// returns, so the player can then be destroyed.
    pub fn detach(&mut self, index: usize) {
        if let Ok(mut wakes) = self.wakes.lock() {
            wakes[index] = None;
        }
        if let Some(render) = self.renders[index].take() {
            render.wake.poke(true);
            let _ = render.thread.join();
        }
    }
}

impl Drop for MacSurface {
    fn drop(&mut self) {
        self.detach(0);
        self.detach(1);
        if let Some(ui) = self.ui.take() {
            // AppKit objects are released on the main thread.
            let _ = on_main(&self.main, move |mtm| {
                let mut ui = ui;
                end_activity(&mut ui.0);
                for context in &ui.0.contexts {
                    context.setView(None, mtm);
                }
                ui.0.panel.close();
                drop(ui);
            });
        }
    }
}

fn render_loop(
    target: RenderTarget,
    api: Arc<RenderApi>,
    cgl: Cgl,
    pixels: Arc<AtomicU64>,
    wake: Arc<Wake>,
    ready: SyncSender<Result<(), String>>,
    index: usize,
) {
    let cgl = cgl.0;
    // SAFETY: the context outlives this thread (the surface joins it before
    // releasing the contexts), and it is locked around every use.
    unsafe {
        CGLLockContext(cgl);
        CGLSetCurrentContext(cgl);
    }
    // SAFETY: GL context current; `gl_proc_address` needs no context.
    let created = unsafe {
        RenderContext::create_opengl(&target, api, gl_proc_address, std::ptr::null_mut())
    };
    // SAFETY: as above.
    unsafe { CGLUnlockContext(cgl) };
    let context = match created {
        Ok(context) => {
            let _ = ready.send(Ok(()));
            context
        }
        Err(error) => {
            let _ = ready.send(Err(error.to_string()));
            // SAFETY: clearing the current context of this thread.
            unsafe { CGLSetCurrentContext(std::ptr::null_mut()) };
            return;
        }
    };
    context.set_update_callback(on_mpv_update, Arc::as_ptr(&wake) as *mut c_void);
    let mut capture = capture::Capture::from_env(index);
    let mut drawn_size = (0, 0);

    while wake.wait() {
        let size = unpack(pixels.load(Ordering::Relaxed));
        // A resize redraws the current frame even with no new one (paused).
        if context.update() & UPDATE_FRAME == 0 && size == drawn_size {
            continue;
        }
        drawn_size = size;
        let (width, height) = size;
        // SAFETY: see above.
        unsafe {
            CGLLockContext(cgl);
            CGLSetCurrentContext(cgl);
        }
        let _ = context.render(0, width, height, true);
        capture.after_frame(width, height);
        // SAFETY: see above.
        unsafe {
            CGLFlushDrawable(cgl);
            CGLUnlockContext(cgl);
        }
        context.report_swap();
    }

    // Free the render context with its GL context current (render_gl.h).
    // SAFETY: see above.
    unsafe {
        CGLLockContext(cgl);
        CGLSetCurrentContext(cgl);
    }
    drop(context);
    // SAFETY: see above.
    unsafe {
        CGLSetCurrentContext(std::ptr::null_mut());
        CGLUnlockContext(cgl);
    }
    drop(wake);
}

/// Diagnostic: with `LIBRETRACKS_VIDEO_CAPTURE_DIR` set, each slot writes the
/// 60th frame it draws as `slot<N>.ppm` there. How the surface was verified
/// in a macOS VM without screen-recording permission (bitácora 15).
mod capture {
    use std::ffi::c_void;
    use std::io::Write;
    use std::path::PathBuf;

    const FRAME: u32 = 60;
    const GL_RGBA: u32 = 0x1908;
    const GL_UNSIGNED_BYTE: u32 = 0x1401;

    pub struct Capture {
        path: Option<PathBuf>,
        frames: u32,
    }

    impl Capture {
        pub fn from_env(index: usize) -> Self {
            Self {
                path: std::env::var_os("LIBRETRACKS_VIDEO_CAPTURE_DIR")
                    .map(|dir| PathBuf::from(dir).join(format!("slot{index}.ppm"))),
                frames: 0,
            }
        }

        pub fn after_frame(&mut self, width: i32, height: i32) {
            let Some(path) = &self.path else {
                return;
            };
            self.frames += 1;
            if self.frames != FRAME || width <= 0 || height <= 0 {
                return;
            }
            type ReadPixels = unsafe extern "C" fn(i32, i32, i32, i32, u32, u32, *mut c_void);
            // SAFETY: looking up a GL entry point by its C name.
            let symbol = unsafe { super::dlsym(super::RTLD_DEFAULT, c"glReadPixels".as_ptr()) };
            if symbol.is_null() {
                return;
            }
            // SAFETY: glReadPixels has this signature.
            let read: ReadPixels = unsafe { std::mem::transmute(symbol) };
            let (w, h) = (width as usize, height as usize);
            let mut rgba = vec![0u8; w * h * 4];
            // SAFETY: the buffer holds w×h RGBA pixels; GL context current.
            unsafe {
                read(
                    0,
                    0,
                    width,
                    height,
                    GL_RGBA,
                    GL_UNSIGNED_BYTE,
                    rgba.as_mut_ptr() as *mut c_void,
                )
            };
            let mut out = format!("P6\n{w} {h}\n255\n").into_bytes();
            for row in (0..h).rev() {
                for pixel in rgba[row * w * 4..(row + 1) * w * 4].chunks(4) {
                    out.extend_from_slice(&pixel[..3]);
                }
            }
            if let Ok(mut file) = std::fs::File::create(path) {
                let _ = file.write_all(&out);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixel_sizes_survive_the_atomic_packing() {
        assert_eq!(unpack(pack(3840.0, 2160.0)), (3840, 2160));
        assert_eq!(unpack(pack(0.0, 0.0)), (1, 1));
    }

    #[test]
    fn a_stop_wakes_a_waiting_render_thread() {
        let wake = Arc::new(Wake::default());
        let waiter = Arc::clone(&wake);
        let thread = std::thread::spawn(move || waiter.wait());
        wake.poke(true);
        assert!(!thread.join().unwrap());
        let frame = Wake::default();
        frame.poke(false);
        assert!(frame.wait());
    }
}
