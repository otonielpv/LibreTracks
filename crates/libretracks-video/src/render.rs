//! mpv's render API (`render.h` + `render_gl.h`) over OpenGL.
//!
//! Used where libmpv cannot open a window of its own: on macOS the main thread
//! belongs to the app (Tauri), so mpv decodes and we hand it an OpenGL
//! framebuffer to draw into, on a thread of our choosing (paso 15, D2/D3).
//!
//! The symbols are resolved **optionally** from the libmpv already loaded by
//! [`crate::mpv::MpvLibrary`]: a libmpv without them (an old one on Linux)
//! still loads for everything else, and [`RenderApi::load`] just returns
//! `None`.
//!
//! OpenGL rules the caller must keep (from `render_gl.h`):
//! * create, render, and **free** a context with the same GL context current;
//! * free the render context before `mpv_terminate_destroy` of its player.

use std::ffi::{c_char, c_int, c_void};
use std::sync::Arc;

use crate::mpv::{Mpv, MpvLibrary};
use crate::VideoError;

// render.h: enum mpv_render_param_type
pub(crate) const PARAM_INVALID: c_int = 0;
pub(crate) const PARAM_API_TYPE: c_int = 1;
pub(crate) const PARAM_OPENGL_INIT_PARAMS: c_int = 2;
pub(crate) const PARAM_OPENGL_FBO: c_int = 3;
pub(crate) const PARAM_FLIP_Y: c_int = 4;

/// render.h: `MPV_RENDER_UPDATE_FRAME`, a new frame must be drawn.
pub const UPDATE_FRAME: u64 = 1;

/// render.h: `MPV_RENDER_API_TYPE_OPENGL`.
const API_TYPE_OPENGL: &[u8] = b"opengl\0";

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub(crate) struct RawRenderParam {
    pub kind: c_int,
    pub data: *mut c_void,
}

/// render_gl.h: `mpv_opengl_init_params`.
#[repr(C)]
pub(crate) struct RawOpenGlInitParams {
    pub get_proc_address: GetProcAddress,
    pub get_proc_address_ctx: *mut c_void,
}

/// render_gl.h: `mpv_opengl_fbo`.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RawOpenGlFbo {
    pub fbo: c_int,
    pub w: c_int,
    pub h: c_int,
    pub internal_format: c_int,
}

/// How mpv finds OpenGL entry points: `(ctx, name) -> address`.
pub type GetProcAddress = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void;

/// Called by mpv (from one of its threads) when a new frame is ready. Must
/// only wake the render thread.
pub type UpdateCallback = unsafe extern "C" fn(*mut c_void);

type RenderContextHandle = c_void;

/// The render entry points of one libmpv.
pub struct RenderApi {
    create: unsafe extern "C" fn(
        *mut *mut RenderContextHandle,
        *mut c_void,
        *mut RawRenderParam,
    ) -> c_int,
    free: unsafe extern "C" fn(*mut RenderContextHandle),
    set_update_callback:
        unsafe extern "C" fn(*mut RenderContextHandle, Option<UpdateCallback>, *mut c_void),
    update: unsafe extern "C" fn(*mut RenderContextHandle) -> u64,
    render: unsafe extern "C" fn(*mut RenderContextHandle, *mut RawRenderParam) -> c_int,
    report_swap: unsafe extern "C" fn(*mut RenderContextHandle),
}

impl RenderApi {
    /// The render API of `library`, or `None` if it does not export it.
    pub fn load(library: &MpvLibrary) -> Option<Self> {
        let raw = library.raw_library();
        // SAFETY: each signature is the one render.h declares for the name.
        unsafe {
            Some(Self {
                create: *raw.get(b"mpv_render_context_create\0").ok()?,
                free: *raw.get(b"mpv_render_context_free\0").ok()?,
                set_update_callback: *raw.get(b"mpv_render_context_set_update_callback\0").ok()?,
                update: *raw.get(b"mpv_render_context_update\0").ok()?,
                render: *raw.get(b"mpv_render_context_render\0").ok()?,
                report_swap: *raw.get(b"mpv_render_context_report_swap\0").ok()?,
            })
        }
    }
}

/// The parameters of `mpv_render_context_create` for OpenGL, terminated like
/// mpv expects. The pointers borrow `init`.
pub(crate) fn opengl_create_params(init: &mut RawOpenGlInitParams) -> [RawRenderParam; 3] {
    [
        RawRenderParam {
            kind: PARAM_API_TYPE,
            data: API_TYPE_OPENGL.as_ptr() as *mut c_void,
        },
        RawRenderParam {
            kind: PARAM_OPENGL_INIT_PARAMS,
            data: init as *mut RawOpenGlInitParams as *mut c_void,
        },
        RawRenderParam {
            kind: PARAM_INVALID,
            data: std::ptr::null_mut(),
        },
    ]
}

/// The parameters of `mpv_render_context_render`: draw into `fbo`, flipped
/// when the target is a window's default framebuffer (origin bottom-left).
pub(crate) fn opengl_render_params(
    fbo: &mut RawOpenGlFbo,
    flip_y: &mut c_int,
) -> [RawRenderParam; 3] {
    [
        RawRenderParam {
            kind: PARAM_OPENGL_FBO,
            data: fbo as *mut RawOpenGlFbo as *mut c_void,
        },
        RawRenderParam {
            kind: PARAM_FLIP_Y,
            data: flip_y as *mut c_int as *mut c_void,
        },
        RawRenderParam {
            kind: PARAM_INVALID,
            data: std::ptr::null_mut(),
        },
    ]
}

/// A player as the render thread sees it: the library and the `mpv_handle*`.
///
/// Created from an [`Mpv`] with [`RenderTarget::of`]; the `Mpv` must outlive
/// every [`RenderContext`] made from it (render.h: free the render context
/// before `mpv_terminate_destroy`). The surface guarantees it by detaching
/// the render thread before the backend drops its players.
pub struct RenderTarget {
    library: Arc<MpvLibrary>,
    handle: *mut c_void,
}

// SAFETY: mpv handles may be used from any thread; the render API is created
// and used on the one render thread this value is moved to.
unsafe impl Send for RenderTarget {}

impl RenderTarget {
    pub fn of(mpv: &Mpv) -> Self {
        Self {
            library: Arc::clone(mpv.library()),
            handle: mpv.raw_handle(),
        }
    }
}

/// One `mpv_render_context` drawing through OpenGL.
///
/// Not `Send` on purpose: it lives on the thread whose GL context it was
/// created with, and is freed there (by [`Drop`], with that context current).
pub struct RenderContext {
    // Keeps libmpv (and so the function pointers) loaded.
    _library: Arc<MpvLibrary>,
    api: Arc<RenderApi>,
    handle: *mut RenderContextHandle,
}

impl RenderContext {
    /// Create a render context for `mpv`, which must have been initialised
    /// with `vo=libmpv`.
    ///
    /// # Safety
    /// An OpenGL context must be current on this thread, and stay the one
    /// current whenever this value is used or dropped. `get_proc_address_ctx`
    /// must stay valid for the context's life.
    pub unsafe fn create_opengl(
        target: &RenderTarget,
        api: Arc<RenderApi>,
        get_proc_address: GetProcAddress,
        get_proc_address_ctx: *mut c_void,
    ) -> Result<Self, VideoError> {
        let mut init = RawOpenGlInitParams {
            get_proc_address,
            get_proc_address_ctx,
        };
        let mut params = opengl_create_params(&mut init);
        let mut handle: *mut RenderContextHandle = std::ptr::null_mut();
        let code = (api.create)(&mut handle, target.handle, params.as_mut_ptr());
        if code < 0 || handle.is_null() {
            return Err(VideoError::Command(format!(
                "mpv_render_context_create: {}",
                target.library.describe_error(code)
            )));
        }
        Ok(Self {
            _library: Arc::clone(&target.library),
            api,
            handle,
        })
    }

    /// Have mpv call `callback(data)` when a frame is ready. `data` must stay
    /// valid until the context is dropped.
    pub fn set_update_callback(&self, callback: UpdateCallback, data: *mut c_void) {
        // SAFETY: valid handle; mpv stores the pointer and calls back later.
        unsafe { (self.api.set_update_callback)(self.handle, Some(callback), data) }
    }

    /// What needs doing; test with [`UPDATE_FRAME`].
    pub fn update(&self) -> u64 {
        // SAFETY: valid handle.
        unsafe { (self.api.update)(self.handle) }
    }

    /// Draw the current frame into `fbo` (`0` = the window's framebuffer),
    /// `width`×`height` pixels.
    pub fn render(
        &self,
        fbo: i32,
        width: i32,
        height: i32,
        flip_y: bool,
    ) -> Result<(), VideoError> {
        let mut target = RawOpenGlFbo {
            fbo,
            w: width,
            h: height,
            internal_format: 0,
        };
        let mut flip: c_int = flip_y.into();
        let mut params = opengl_render_params(&mut target, &mut flip);
        // SAFETY: valid handle; the params point at locals alive for the call.
        let code = unsafe { (self.api.render)(self.handle, params.as_mut_ptr()) };
        if code < 0 {
            return Err(VideoError::Command(format!(
                "mpv_render_context_render: {}",
                self._library.describe_error(code)
            )));
        }
        Ok(())
    }

    /// Tell mpv the frame was presented (after the buffer swap).
    pub fn report_swap(&self) {
        // SAFETY: valid handle.
        unsafe { (self.api.report_swap)(self.handle) }
    }
}

impl Drop for RenderContext {
    fn drop(&mut self) {
        // SAFETY: valid handle, freed exactly once; the caller keeps the GL
        // context current (see `create_opengl`).
        unsafe {
            (self.api.set_update_callback)(self.handle, None, std::ptr::null_mut());
            (self.api.free)(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CStr;

    unsafe extern "C" fn no_proc(_: *mut c_void, _: *const c_char) -> *mut c_void {
        std::ptr::null_mut()
    }

    #[test]
    fn create_params_ask_for_opengl_and_end_with_invalid() {
        let mut init = RawOpenGlInitParams {
            get_proc_address: no_proc,
            get_proc_address_ctx: std::ptr::null_mut(),
        };
        let init_ptr = &mut init as *mut RawOpenGlInitParams as *mut c_void;
        let params = opengl_create_params(&mut init);
        assert_eq!(params[0].kind, PARAM_API_TYPE);
        // SAFETY: points at the static, NUL-terminated API type string.
        let api = unsafe { CStr::from_ptr(params[0].data as *const c_char) };
        assert_eq!(api.to_str(), Ok("opengl"));
        assert_eq!(params[1].kind, PARAM_OPENGL_INIT_PARAMS);
        assert_eq!(params[1].data, init_ptr);
        assert_eq!(params[2].kind, PARAM_INVALID);
        assert!(params[2].data.is_null());
    }

    #[test]
    fn render_params_carry_the_framebuffer_and_the_flip() {
        let mut fbo = RawOpenGlFbo {
            fbo: 0,
            w: 1920,
            h: 1080,
            internal_format: 0,
        };
        let mut flip: c_int = 1;
        let params = opengl_render_params(&mut fbo, &mut flip);
        assert_eq!(params[0].kind, PARAM_OPENGL_FBO);
        // SAFETY: points at `fbo`, alive here.
        let seen = unsafe { *(params[0].data as *const RawOpenGlFbo) };
        assert_eq!(seen, fbo);
        assert_eq!(params[1].kind, PARAM_FLIP_Y);
        // SAFETY: points at `flip`.
        assert_eq!(unsafe { *(params[1].data as *const c_int) }, 1);
        assert_eq!(params[2].kind, PARAM_INVALID);
    }

    #[test]
    fn the_real_libmpv_exports_the_render_api() {
        let Some(library) = crate::test_support::libmpv_for_tests() else {
            return;
        };
        assert!(RenderApi::load(&library).is_some());
    }
}
