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
//! The window lives on its own thread with its message loop. Other threads
//! only post to it or call the cross-thread-safe `SetWindowPos`/`ShowWindow`.

use std::ffi::c_void;
use std::sync::mpsc;
use std::time::Duration;

use crate::monitors::SurfaceRect;

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
    fn GetWindow(hwnd: Handle, cmd: u32) -> Handle;
    fn LoadCursorW(instance: Handle, name: *const u16) -> Handle;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> Handle;
}
#[link(name = "gdi32")]
extern "system" {
    fn GetStockObject(kind: i32) -> Handle;
}

const WM_DESTROY: u32 = 0x0002;
const WM_SIZE: u32 = 0x0005;
const WM_CLOSE: u32 = 0x0010;
const WM_MOUSEACTIVATE: u32 = 0x0021;
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
const HWND_TOP: Handle = std::ptr::null_mut();
const BLACK_BRUSH: i32 = 4;
const IDC_ARROW: usize = 32512;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
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
        WM_CLOSE => {
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
}

impl Win32Surface {
    /// Create the window on its own thread. `fullscreen`: a borderless,
    /// topmost popup covering `rect`; otherwise a normal (movable) window.
    pub fn create(rect: crate::monitors::SurfaceRect, fullscreen: bool, title: &str) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel::<Result<(usize, [usize; 2]), String>>();
        let title = title.to_string();
        let thread = std::thread::Builder::new()
            .name("lt-video-surface".into())
            .spawn(move || unsafe {
                let instance = GetModuleHandleW(std::ptr::null());
                register_classes(instance);
                let (ex_style, style) = if fullscreen {
                    (
                        WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                        WS_POPUP | WS_CLIPCHILDREN,
                    )
                } else {
                    (WS_EX_NOACTIVATE, WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN)
                };
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
        })
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

    pub fn reposition(&self, rect: SurfaceRect) {
        unsafe {
            SetWindowPos(
                self.window as Handle,
                std::ptr::null_mut(),
                rect.x,
                rect.y,
                rect.width as i32,
                rect.height as i32,
                SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
            );
        }
    }
}

impl Drop for Win32Surface {
    fn drop(&mut self) {
        unsafe {
            PostMessageW(self.window as Handle, WM_CLOSE, 0, 0);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
