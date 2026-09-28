//! The Windows output surface: a window of our own that is never activated,
//! placed on the chosen monitor, with one child window per player slot that
//! mpv renders into (`wid`).
//!
//! Why not mpv's own window: measured in paso 01, it takes the keyboard focus
//! from the app even with `focus-on=never`, and `fs-screen-name` does not pick
//! the monitor on Windows. This window is `WS_EX_NOACTIVATE` (and answers
//! `WM_MOUSEACTIVATE` with `MA_NOACTIVATE`), so the app keeps the keyboard and
//! its shortcuts work during the show.
//!
//! A double-click toggles fullscreen <-> window. mpv's own window (a child
//! of ours) gets the clicks, and mpv would rather start dragging with them,
//! so they are caught from `WM_PARENTNOTIFY`, which Windows sends up to every
//! ancestor on a button press over a child. Closing the window (its X) only
//! reports it: the output then switches itself off and destroys it.
//!
//! The window lives on its own thread with its message loop. Other threads
//! only post to it or call the cross-thread-safe `SetWindowPos`/`ShowWindow`
//! and `SetWindowLongPtrW` (restyling between fullscreen and window).

use std::cell::Cell;
use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use crate::monitors::{SurfacePlan, SurfaceRect};

type Handle = *mut c_void;

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

#[repr(C)]
#[derive(Default)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
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
    fn PostMessageW(hwnd: Handle, msg: u32, wparam: usize, lparam: isize) -> i32;
    fn PostQuitMessage(code: i32);
    fn DestroyWindow(hwnd: Handle) -> i32;
    fn SetWindowPos(hwnd: Handle, after: Handle, x: i32, y: i32, w: i32, h: i32, flags: u32) -> i32;
    fn GetClientRect(hwnd: Handle, rect: *mut Rect) -> i32;
    fn GetWindowRect(hwnd: Handle, rect: *mut Rect) -> i32;
    fn SetWindowLongPtrW(hwnd: Handle, index: i32, value: isize) -> isize;
    fn GetWindow(hwnd: Handle, cmd: u32) -> Handle;
    fn LoadCursorW(instance: Handle, name: *const u16) -> Handle;
    fn GetCursorPos(point: *mut [i32; 2]) -> i32;
    fn GetDoubleClickTime() -> u32;
    fn GetSystemMetrics(index: i32) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> Handle;
    fn GetTickCount() -> u32;
}
#[link(name = "gdi32")]
extern "system" {
    fn GetStockObject(kind: i32) -> Handle;
}

const WM_DESTROY: u32 = 0x0002;
const WM_SIZE: u32 = 0x0005;
const WM_CLOSE: u32 = 0x0010;
const WM_MOUSEACTIVATE: u32 = 0x0021;
const WM_PARENTNOTIFY: u32 = 0x0210;
const WM_LBUTTONDOWN: u32 = 0x0201;
/// Posted by `Drop`: really destroy the window (WM_CLOSE only reports).
const WM_APP_DESTROY: u32 = 0x8000 + 1;
const SM_CXDOUBLECLK: i32 = 36;
const SM_CYDOUBLECLK: i32 = 37;
const MA_NOACTIVATE: isize = 3;
const WS_EX_TOPMOST: u32 = 0x0000_0008;
const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
const WS_POPUP: u32 = 0x8000_0000;
const WS_CHILD: u32 = 0x4000_0000;
const WS_VISIBLE: u32 = 0x1000_0000;
const WS_CLIPCHILDREN: u32 = 0x0200_0000;
const WS_CLIPSIBLINGS: u32 = 0x0400_0000;
const WS_OVERLAPPEDWINDOW: u32 = 0x00CF_0000;
const SW_HIDE: i32 = 0;
const SW_SHOWNOACTIVATE: i32 = 4;
const SW_SHOWNA: i32 = 8;
const GW_CHILD: u32 = 5;
const GW_HWNDNEXT: u32 = 2;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOSIZE: u32 = 0x0001;
const SWP_ASYNCWINDOWPOS: u32 = 0x4000;
const SWP_FRAMECHANGED: u32 = 0x0020;
const GWL_STYLE: i32 = -16;
const HWND_TOP: Handle = std::ptr::null_mut();
const HWND_TOPMOST: Handle = -1isize as Handle;
const HWND_NOTOPMOST: Handle = -2isize as Handle;
const BLACK_BRUSH: i32 = 4;
const IDC_ARROW: usize = 32512;

/// Fullscreen is a bare popup; the window has a frame to move and resize.
/// The extended style is the same for both (never activated, no taskbar
/// button); being on top is the z-order, set with `SetWindowPos`.
const EX_STYLE: u32 = WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;

fn style_for(fullscreen: bool) -> u32 {
    if fullscreen {
        WS_POPUP | WS_CLIPCHILDREN | WS_VISIBLE
    } else {
        WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN | WS_VISIBLE
    }
}

fn z_order(plan: &SurfacePlan) -> Handle {
    if plan.on_top {
        HWND_TOPMOST
    } else {
        HWND_NOTOPMOST
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Double-clicks and close requests, counted by the window thread and read by
/// the backend. There is one output surface per process.
static DOUBLE_CLICKS: AtomicU32 = AtomicU32::new(0);
static CLOSE_REQUESTS: AtomicU32 = AtomicU32::new(0);

thread_local! {
    /// The last button press on the surface: (tick count, screen point).
    /// `WM_PARENTNOTIFY` is sent, not posted, so `GetMessageTime` would be
    /// stale.
    static LAST_PRESS: Cell<Option<(u32, [i32; 2])>> = const { Cell::new(None) };
}

/// Count a double-click when this press follows the previous one within the
/// system's double-click time and distance.
unsafe fn on_press() {
    let time = GetTickCount();
    let mut point = [0i32; 2];
    GetCursorPos(&mut point);
    let previous = LAST_PRESS.with(|last| last.replace(Some((time, point))));
    if let Some((then, at)) = previous {
        let quick = time.wrapping_sub(then) <= GetDoubleClickTime();
        let near = (point[0] - at[0]).abs() <= GetSystemMetrics(SM_CXDOUBLECLK) / 2
            && (point[1] - at[1]).abs() <= GetSystemMetrics(SM_CYDOUBLECLK) / 2;
        if quick && near {
            DOUBLE_CLICKS.fetch_add(1, Ordering::Relaxed);
            // A third press starts over instead of making another pair.
            LAST_PRESS.with(|last| last.set(None));
        }
    }
}

/// Keep every child the size of the parent's client area.
unsafe fn fit_children(parent: Handle) {
    let mut rect = Rect::default();
    GetClientRect(parent, &mut rect);
    let mut child = GetWindow(parent, GW_CHILD);
    while !child.is_null() {
        SetWindowPos(
            child,
            std::ptr::null_mut(),
            0,
            0,
            rect.right - rect.left,
            rect.bottom - rect.top,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOMOVE,
        );
        child = GetWindow(child, GW_HWNDNEXT);
    }
}

unsafe extern "system" fn surface_proc(hwnd: Handle, msg: u32, wparam: usize, lparam: isize) -> isize {
    match msg {
        WM_MOUSEACTIVATE => MA_NOACTIVATE,
        WM_SIZE => {
            fit_children(hwnd);
            0
        }
        WM_PARENTNOTIFY => {
            if (wparam & 0xffff) as u32 == WM_LBUTTONDOWN {
                on_press();
            }
            0
        }
        WM_CLOSE => {
            CLOSE_REQUESTS.fetch_add(1, Ordering::Relaxed);
            0
        }
        WM_APP_DESTROY => {
            DestroyWindow(hwnd);
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

unsafe extern "system" fn child_proc(hwnd: Handle, msg: u32, wparam: usize, lparam: isize) -> isize {
    if msg == WM_MOUSEACTIVATE {
        return MA_NOACTIVATE;
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn register_classes(instance: Handle) {
    // Registering twice fails harmlessly with ERROR_CLASS_ALREADY_EXISTS.
    unsafe {
        let cursor = LoadCursorW(std::ptr::null_mut(), IDC_ARROW as *const u16);
        for (name, proc_) in [
            ("LibreTracksVideoSurface", surface_proc as unsafe extern "system" fn(_, _, _, _) -> _),
            ("LibreTracksVideoSlot", child_proc),
        ] {
            let class_name = wide(name);
            let class = WndClassExW {
                size: std::mem::size_of::<WndClassExW>() as u32,
                style: 0,
                wnd_proc: proc_,
                cls_extra: 0,
                wnd_extra: 0,
                instance,
                icon: std::ptr::null_mut(),
                cursor,
                background: GetStockObject(BLACK_BRUSH),
                menu_name: std::ptr::null(),
                class_name: class_name.as_ptr(),
                icon_small: std::ptr::null_mut(),
            };
            RegisterClassExW(&class);
        }
    }
}

/// The surface window and its two slot children.
pub struct Win32Surface {
    window: usize,
    slots: [usize; 2],
    thread: Option<std::thread::JoinHandle<()>>,
    fullscreen: bool,
    /// Where the user left the window (monitor, outer rect): going back from
    /// fullscreen puts it there instead of re-centring it.
    last_window: Option<(String, SurfaceRect)>,
    seen_double_clicks: u32,
    seen_close_requests: u32,
}

impl Win32Surface {
    /// Create the window on its own thread. Fullscreen: a borderless popup
    /// covering the plan's rect (topmost if `plan.on_top`); otherwise a
    /// normal window the user can move and resize.
    pub fn create(plan: &SurfacePlan, title: &str) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel::<Result<(usize, [usize; 2]), String>>();
        let title = title.to_string();
        let rect = plan.rect;
        let fullscreen = plan.fullscreen;
        let on_top = plan.on_top;
        let thread = std::thread::Builder::new()
            .name("lt-video-surface".into())
            .spawn(move || unsafe {
                let instance = GetModuleHandleW(std::ptr::null());
                register_classes(instance);
                let ex_style = if on_top { EX_STYLE | WS_EX_TOPMOST } else { EX_STYLE };
                let style = style_for(fullscreen) & !WS_VISIBLE;
                let class = wide("LibreTracksVideoSurface");
                let title = wide(&title);
                let window = CreateWindowExW(
                    ex_style,
                    class.as_ptr(),
                    title.as_ptr(),
                    style,
                    rect.x,
                    rect.y,
                    rect.width as i32,
                    rect.height as i32,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null_mut(),
                );
                if window.is_null() {
                    let _ = sender.send(Err("CreateWindowExW falló".into()));
                    return;
                }
                let mut client = Rect::default();
                GetClientRect(window, &mut client);
                let slot_class = wide("LibreTracksVideoSlot");
                let mut slots = [0usize; 2];
                for (index, slot) in slots.iter_mut().enumerate() {
                    let child = CreateWindowExW(
                        0,
                        slot_class.as_ptr(),
                        std::ptr::null(),
                        WS_CHILD | WS_CLIPSIBLINGS | if index == 0 { WS_VISIBLE } else { 0 },
                        0,
                        0,
                        client.right - client.left,
                        client.bottom - client.top,
                        window,
                        std::ptr::null_mut(),
                        instance,
                        std::ptr::null_mut(),
                    );
                    *slot = child as usize;
                }
                ShowWindow(window, SW_SHOWNOACTIVATE);
                let _ = sender.send(Ok((window as usize, slots)));
                let mut msg: Msg = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            })
            .map_err(|error| error.to_string())?;
        let (window, slots) = receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "la ventana de vídeo no respondió".to_string())??;
        if slots.contains(&0) {
            return Err("no se pudieron crear las ventanas de los reproductores".into());
        }
        Ok(Self {
            window,
            slots,
            thread: Some(thread),
            fullscreen: plan.fullscreen,
            last_window: None,
            seen_double_clicks: DOUBLE_CLICKS.load(Ordering::Relaxed),
            seen_close_requests: CLOSE_REQUESTS.load(Ordering::Relaxed),
        })
    }

    /// Whether the window was double-clicked since the last call.
    pub fn take_double_click(&mut self) -> bool {
        let clicks = DOUBLE_CLICKS.load(Ordering::Relaxed);
        std::mem::replace(&mut self.seen_double_clicks, clicks) != clicks
    }

    /// Whether the user asked to close the window since the last call.
    pub fn take_close_request(&mut self) -> bool {
        let requests = CLOSE_REQUESTS.load(Ordering::Relaxed);
        std::mem::replace(&mut self.seen_close_requests, requests) != requests
    }

    /// The HWND a slot's mpv renders into, as mpv's `wid` wants it.
    pub fn slot_wid(&self, slot: usize) -> i64 {
        self.slots[slot] as i64
    }

    /// Show `slot`'s child on top, then hide the other: the new picture is on
    /// screen before the old one goes, so nothing flashes in between.
    pub fn show_slot(&self, slot: usize) {
        unsafe {
            let shown = self.slots[slot] as Handle;
            let hidden = self.slots[1 - slot] as Handle;
            SetWindowPos(
                shown,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
            );
            ShowWindow(shown, SW_SHOWNA);
            ShowWindow(hidden, SW_HIDE);
        }
    }

    /// Move to the plan and restyle if its mode changed (fullscreen <->
    /// window), keeping the slot children and so the players.
    pub fn apply(&mut self, plan: &SurfacePlan) {
        let window = self.window as Handle;
        let mut flags = SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
        unsafe {
            if !self.fullscreen {
                let mut outer = Rect::default();
                if GetWindowRect(window, &mut outer) != 0 {
                    self.last_window = Some((
                        plan.monitor_name.clone(),
                        SurfaceRect {
                            x: outer.left,
                            y: outer.top,
                            width: (outer.right - outer.left).max(1) as u32,
                            height: (outer.bottom - outer.top).max(1) as u32,
                        },
                    ));
                }
            }
            if self.fullscreen != plan.fullscreen {
                SetWindowLongPtrW(window, GWL_STYLE, style_for(plan.fullscreen) as isize);
                flags |= SWP_FRAMECHANGED;
                self.fullscreen = plan.fullscreen;
            }
            let rect = match &self.last_window {
                Some((monitor, rect)) if !plan.fullscreen && *monitor == plan.monitor_name => *rect,
                _ => plan.rect,
            };
            SetWindowPos(
                window,
                z_order(plan),
                rect.x,
                rect.y,
                rect.width as i32,
                rect.height as i32,
                flags,
            );
        }
    }
}

impl Drop for Win32Surface {
    fn drop(&mut self) {
        unsafe {
            PostMessageW(self.window as Handle, WM_APP_DESTROY, 0, 0);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
