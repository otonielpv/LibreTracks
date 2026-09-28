//! Hand-written FFI over mpv's client API (`client.h`), loaded at run time.
//!
//! The binding crates on crates.io link libmpv at build time, which is exactly
//! what this crate must not do: if libmpv is missing or refuses to load (an
//! unusual distro, an antivirus) the app still has to start and play audio,
//! with video disabled and the reason shown. So every entry point is a
//! function pointer resolved from a [`libloading::Library`].
//!
//! Only the calls LibreTracks uses are bound. They have been stable since the
//! 0.3x series of the client API.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::Path;
use std::sync::Arc;

use crate::VideoError;

type MpvHandle = c_void;

#[repr(C)]
struct RawEvent {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
struct RawEventProperty {
    name: *const c_char,
    format: c_int,
    data: *mut c_void,
}

#[repr(C)]
struct RawEventClientMessage {
    num_args: c_int,
    args: *const *const c_char,
}

#[repr(C)]
struct RawEventEndFile {
    reason: c_int,
    error: c_int,
}

/// client.h: `MPV_ERROR_OPTION_NOT_FOUND`.
const ERROR_OPTION_NOT_FOUND: c_int = -5;

/// Options that switch off mpv's scripting. They only exist when mpv was
/// built with Lua/JavaScript; set with [`Mpv::set_option_if_known`].
pub const SCRIPT_OPTIONS: [(&str, &str); 3] = [("load-scripts", "no"), ("ytdl", "no"), ("osc", "no")];

const FORMAT_NONE: c_int = 0;
const FORMAT_STRING: c_int = 1;
const FORMAT_FLAG: c_int = 3;
const FORMAT_INT64: c_int = 4;
const FORMAT_DOUBLE: c_int = 5;

const EVENT_NONE: c_int = 0;
const EVENT_SHUTDOWN: c_int = 1;
const EVENT_COMMAND_REPLY: c_int = 5;
const EVENT_START_FILE: c_int = 6;
const EVENT_END_FILE: c_int = 7;
const EVENT_FILE_LOADED: c_int = 8;
const EVENT_CLIENT_MESSAGE: c_int = 16;
const EVENT_VIDEO_RECONFIG: c_int = 17;
const EVENT_SEEK: c_int = 20;
const EVENT_PLAYBACK_RESTART: c_int = 21;
const EVENT_PROPERTY_CHANGE: c_int = 22;

/// The function table resolved from one loaded libmpv. Shared by every
/// [`Mpv`] instance, and kept alive by them: the library is never unloaded
/// while a handle exists.
pub struct MpvLibrary {
    // Kept only so the function pointers below stay valid.
    _library: libloading::Library,
    client_api_version: unsafe extern "C" fn() -> std::ffi::c_ulong,
    create: unsafe extern "C" fn() -> *mut MpvHandle,
    initialize: unsafe extern "C" fn(*mut MpvHandle) -> c_int,
    terminate_destroy: unsafe extern "C" fn(*mut MpvHandle),
    set_option_string: unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int,
    command: unsafe extern "C" fn(*mut MpvHandle, *mut *const c_char) -> c_int,
    command_async: unsafe extern "C" fn(*mut MpvHandle, u64, *mut *const c_char) -> c_int,
    set_property: unsafe extern "C" fn(*mut MpvHandle, *const c_char, c_int, *mut c_void) -> c_int,
    set_property_string:
        unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int,
    get_property: unsafe extern "C" fn(*mut MpvHandle, *const c_char, c_int, *mut c_void) -> c_int,
    get_property_string: unsafe extern "C" fn(*mut MpvHandle, *const c_char) -> *mut c_char,
    observe_property: unsafe extern "C" fn(*mut MpvHandle, u64, *const c_char, c_int) -> c_int,
    wait_event: unsafe extern "C" fn(*mut MpvHandle, f64) -> *mut RawEvent,
    wakeup: unsafe extern "C" fn(*mut MpvHandle),
    free: unsafe extern "C" fn(*mut c_void),
    error_string: unsafe extern "C" fn(c_int) -> *const c_char,
}

// SAFETY: the table only holds function pointers into a library that stays
// loaded for the table's lifetime; mpv's client API is documented as callable
// from any thread.
unsafe impl Send for MpvLibrary {}
unsafe impl Sync for MpvLibrary {}

macro_rules! symbol {
    ($library:expr, $name:literal) => {{
        // SAFETY: the signature on the left of the `let` is the one
        // `client.h` declares for this name.
        let symbol = unsafe { $library.get($name) }.map_err(|error| {
            VideoError::LibraryUnavailable(format!(
                "libmpv no exporta {}: {error}",
                String::from_utf8_lossy(&$name[..$name.len() - 1])
            ))
        })?;
        *symbol
    }};
}

impl MpvLibrary {
    /// Load libmpv from `path` and resolve the client API. Fails without
    /// side effects if the file is missing, is not libmpv, or is too old.
    pub fn load(path: &Path) -> Result<Arc<Self>, VideoError> {
        // SAFETY: loading runs the library's initialisers. libmpv's are
        // benign (no global state beyond its own), which is the premise of
        // loading it at run time at all.
        let library = unsafe { libloading::Library::new(path) }.map_err(|error| {
            VideoError::LibraryUnavailable(format!("{}: {error}", path.display()))
        })?;
        let table = MpvLibrary {
            client_api_version: symbol!(library, b"mpv_client_api_version\0"),
            create: symbol!(library, b"mpv_create\0"),
            initialize: symbol!(library, b"mpv_initialize\0"),
            terminate_destroy: symbol!(library, b"mpv_terminate_destroy\0"),
            set_option_string: symbol!(library, b"mpv_set_option_string\0"),
            command: symbol!(library, b"mpv_command\0"),
            command_async: symbol!(library, b"mpv_command_async\0"),
            set_property: symbol!(library, b"mpv_set_property\0"),
            set_property_string: symbol!(library, b"mpv_set_property_string\0"),
            get_property: symbol!(library, b"mpv_get_property\0"),
            get_property_string: symbol!(library, b"mpv_get_property_string\0"),
            observe_property: symbol!(library, b"mpv_observe_property\0"),
            wait_event: symbol!(library, b"mpv_wait_event\0"),
            wakeup: symbol!(library, b"mpv_wakeup\0"),
            free: symbol!(library, b"mpv_free\0"),
            error_string: symbol!(library, b"mpv_error_string\0"),
            _library: library,
        };
        let version = table.client_api_version();
        if version.0 < MIN_CLIENT_API_MAJOR {
            return Err(VideoError::LibraryUnavailable(format!(
                "libmpv demasiado antigua: API cliente {version}, se necesita {MIN_CLIENT_API_MAJOR}.x"
            )));
        }
        Ok(Arc::new(table))
    }

    pub fn client_api_version(&self) -> ClientApiVersion {
        // SAFETY: no arguments, returns a plain integer.
        let raw = unsafe { (self.client_api_version)() } as u64;
        ClientApiVersion((raw >> 16) as u32, (raw & 0xffff) as u32)
    }

    /// The loaded library, to resolve optional symbols (the render API).
    pub(crate) fn raw_library(&self) -> &libloading::Library {
        &self._library
    }

    /// mpv's text for an error code.
    pub fn describe_error(&self, code: c_int) -> String {
        self.error_message(code)
    }

    fn error_message(&self, code: c_int) -> String {
        // SAFETY: mpv returns a static string for every code.
        let text = unsafe { CStr::from_ptr((self.error_string)(code)) };
        text.to_string_lossy().into_owned()
    }
}

/// Oldest client API major the bindings accept. Every call bound here exists
/// since 1.x; 2.0 (mpv 0.35, libmpv.so.2 / libmpv-2.dll) only removed APIs this
/// crate does not use. 1.x is still what Ubuntu 22.04 ships as libmpv.so.1.
pub const MIN_CLIENT_API_MAJOR: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientApiVersion(pub u32, pub u32);

impl std::fmt::Display for ClientApiVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}", self.0, self.1)
    }
}

/// What a property change carried, for the formats LibreTracks observes.
#[derive(Debug, Clone, PartialEq)]
pub enum PropertyValue {
    /// The property is currently unavailable (e.g. `time-pos` with nothing
    /// loaded).
    None,
    Flag(bool),
    Int(i64),
    Double(f64),
    String(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum EndFileReason {
    Eof,
    Stop,
    Quit,
    Error(String),
    Other,
}

/// An owned copy of an `mpv_event`, safe to keep after the next
/// `mpv_wait_event` invalidates the raw one.
#[derive(Debug, Clone, PartialEq)]
pub enum MpvEvent {
    Shutdown,
    StartFile,
    FileLoaded,
    EndFile(EndFileReason),
    VideoReconfig,
    Seek,
    /// The first frame after a load or seek has been shown.
    PlaybackRestart,
    PropertyChange {
        id: u64,
        name: String,
        value: PropertyValue,
    },
    CommandReply {
        id: u64,
        error: Option<String>,
    },
    /// `script-message` arguments, e.g. from a `keybind`.
    ClientMessage(Vec<String>),
    Other(i32),
}

/// One mpv instance ("core" plus its client handle).
pub struct Mpv {
    api: Arc<MpvLibrary>,
    handle: *mut MpvHandle,
}

// SAFETY: mpv's client API is thread-safe for everything except
// `mpv_wait_event`, which must not be called concurrently on the same handle.
// `wait_event` takes `&self` but callers in this crate only ever call it from
// the one thread that owns the event loop.
unsafe impl Send for Mpv {}
unsafe impl Sync for Mpv {}

fn c_string(value: &str) -> Result<CString, VideoError> {
    CString::new(value).map_err(|_| VideoError::Command(format!("cadena con NUL: {value:?}")))
}

impl Mpv {
    /// Create an uninitialised instance. Set options, then call
    /// [`Mpv::initialize`].
    pub fn create(api: &Arc<MpvLibrary>) -> Result<Self, VideoError> {
        // SAFETY: no arguments; returns null on out-of-memory.
        let handle = unsafe { (api.create)() };
        if handle.is_null() {
            return Err(VideoError::Command("mpv_create devolvió NULL".into()));
        }
        Ok(Self {
            api: Arc::clone(api),
            handle,
        })
    }

    pub fn library(&self) -> &Arc<MpvLibrary> {
        &self.api
    }

    /// The `mpv_handle*`, for the render API (`render.rs`).
    pub(crate) fn raw_handle(&self) -> *mut c_void {
        self.handle
    }

    fn check(&self, code: c_int, what: &str) -> Result<(), VideoError> {
        if code >= 0 {
            Ok(())
        } else {
            Err(VideoError::Command(format!(
                "{what}: {}",
                self.api.error_message(code)
            )))
        }
    }

    pub fn set_option(&self, name: &str, value: &str) -> Result<(), VideoError> {
        let (name_c, value_c) = (c_string(name)?, c_string(value)?);
        // SAFETY: valid handle and NUL-terminated strings that outlive the call.
        let code =
            unsafe { (self.api.set_option_string)(self.handle, name_c.as_ptr(), value_c.as_ptr()) };
        self.check(code, &format!("opción {name}={value}"))
    }

    /// Like [`Mpv::set_option`], but an option this libmpv does not have is
    /// fine (`MPV_ERROR_OPTION_NOT_FOUND`). For options that depend on how
    /// mpv was built or its version: the script switches do not exist in a
    /// build without Lua/JavaScript (ours on macOS), where scripts are off
    /// anyway. Any other error still fails.
    pub fn set_option_if_known(&self, name: &str, value: &str) -> Result<(), VideoError> {
        let (name_c, value_c) = (c_string(name)?, c_string(value)?);
        // SAFETY: valid handle and NUL-terminated strings that outlive the call.
        let code =
            unsafe { (self.api.set_option_string)(self.handle, name_c.as_ptr(), value_c.as_ptr()) };
        if code == ERROR_OPTION_NOT_FOUND {
            return Ok(());
        }
        self.check(code, &format!("opción {name}={value}"))
    }

    pub fn initialize(&self) -> Result<(), VideoError> {
        // SAFETY: valid, not yet initialised handle.
        let code = unsafe { (self.api.initialize)(self.handle) };
        self.check(code, "mpv_initialize")
    }

    fn with_args<T>(
        &self,
        args: &[&str],
        call: impl FnOnce(*mut *const c_char) -> T,
    ) -> Result<T, VideoError> {
        let owned = args
            .iter()
            .map(|arg| c_string(arg))
            .collect::<Result<Vec<_>, _>>()?;
        let mut pointers: Vec<*const c_char> = owned.iter().map(|arg| arg.as_ptr()).collect();
        pointers.push(std::ptr::null());
        Ok(call(pointers.as_mut_ptr()))
    }

    /// Run a command synchronously (e.g. `["loadfile", path]`).
    pub fn command(&self, args: &[&str]) -> Result<(), VideoError> {
        // SAFETY: NULL-terminated array of valid strings, alive for the call.
        let code = self.with_args(args, |argv| unsafe {
            (self.api.command)(self.handle, argv)
        })?;
        self.check(code, &args.join(" "))
    }

    /// Queue a command; the result arrives as [`MpvEvent::CommandReply`]
    /// with `id`. Never blocks on decoding.
    pub fn command_async(&self, id: u64, args: &[&str]) -> Result<(), VideoError> {
        // SAFETY: as in `command`; mpv copies the arguments before returning.
        let code = self.with_args(args, |argv| unsafe {
            (self.api.command_async)(self.handle, id, argv)
        })?;
        self.check(code, &args.join(" "))
    }

    pub fn set_property_string(&self, name: &str, value: &str) -> Result<(), VideoError> {
        let (name_c, value_c) = (c_string(name)?, c_string(value)?);
        // SAFETY: valid handle and strings.
        let code = unsafe {
            (self.api.set_property_string)(self.handle, name_c.as_ptr(), value_c.as_ptr())
        };
        self.check(code, &format!("propiedad {name}={value}"))
    }

    pub fn set_property_f64(&self, name: &str, value: f64) -> Result<(), VideoError> {
        let name_c = c_string(name)?;
        let mut value = value;
        // SAFETY: FORMAT_DOUBLE reads one f64 from the pointer.
        let code = unsafe {
            (self.api.set_property)(
                self.handle,
                name_c.as_ptr(),
                FORMAT_DOUBLE,
                (&mut value as *mut f64).cast(),
            )
        };
        self.check(code, &format!("propiedad {name}={value}"))
    }

    pub fn set_property_flag(&self, name: &str, value: bool) -> Result<(), VideoError> {
        let name_c = c_string(name)?;
        let mut flag: c_int = value.into();
        // SAFETY: FORMAT_FLAG reads one int from the pointer.
        let code = unsafe {
            (self.api.set_property)(
                self.handle,
                name_c.as_ptr(),
                FORMAT_FLAG,
                (&mut flag as *mut c_int).cast(),
            )
        };
        self.check(code, &format!("propiedad {name}={value}"))
    }

    pub fn get_property_f64(&self, name: &str) -> Result<f64, VideoError> {
        let name_c = c_string(name)?;
        let mut value = 0.0_f64;
        // SAFETY: FORMAT_DOUBLE writes one f64.
        let code = unsafe {
            (self.api.get_property)(
                self.handle,
                name_c.as_ptr(),
                FORMAT_DOUBLE,
                (&mut value as *mut f64).cast(),
            )
        };
        self.check(code, name)?;
        Ok(value)
    }

    pub fn get_property_i64(&self, name: &str) -> Result<i64, VideoError> {
        let name_c = c_string(name)?;
        let mut value = 0_i64;
        // SAFETY: FORMAT_INT64 writes one i64.
        let code = unsafe {
            (self.api.get_property)(
                self.handle,
                name_c.as_ptr(),
                FORMAT_INT64,
                (&mut value as *mut i64).cast(),
            )
        };
        self.check(code, name)?;
        Ok(value)
    }

    pub fn get_property_flag(&self, name: &str) -> Result<bool, VideoError> {
        let name_c = c_string(name)?;
        let mut value: c_int = 0;
        // SAFETY: FORMAT_FLAG writes one int.
        let code = unsafe {
            (self.api.get_property)(
                self.handle,
                name_c.as_ptr(),
                FORMAT_FLAG,
                (&mut value as *mut c_int).cast(),
            )
        };
        self.check(code, name)?;
        Ok(value != 0)
    }

    pub fn get_property_string(&self, name: &str) -> Result<String, VideoError> {
        let name_c = c_string(name)?;
        // SAFETY: returns a malloc'd string owned by the caller, or NULL.
        let raw = unsafe { (self.api.get_property_string)(self.handle, name_c.as_ptr()) };
        if raw.is_null() {
            return Err(VideoError::Command(format!("{name}: no disponible")));
        }
        // SAFETY: non-null, NUL-terminated; freed with mpv_free right after.
        let value = unsafe { CStr::from_ptr(raw) }
            .to_string_lossy()
            .into_owned();
        unsafe { (self.api.free)(raw.cast()) };
        Ok(value)
    }

    /// Ask for [`MpvEvent::PropertyChange`] events for `name` tagged `id`.
    pub fn observe_property(&self, id: u64, name: &str, kind: ObserveAs) -> Result<(), VideoError> {
        let name_c = c_string(name)?;
        let format = match kind {
            ObserveAs::Flag => FORMAT_FLAG,
            ObserveAs::Int => FORMAT_INT64,
            ObserveAs::Double => FORMAT_DOUBLE,
            ObserveAs::String => FORMAT_STRING,
            ObserveAs::Notify => FORMAT_NONE,
        };
        // SAFETY: valid handle and string.
        let code = unsafe { (self.api.observe_property)(self.handle, id, name_c.as_ptr(), format) };
        self.check(code, &format!("observar {name}"))
    }

    /// Wait up to `timeout_seconds` for the next event. `None` on timeout.
    /// Must only be called from one thread per instance.
    pub fn wait_event(&self, timeout_seconds: f64) -> Option<MpvEvent> {
        // SAFETY: valid handle; the returned event is owned by mpv and valid
        // until the next call, so everything is copied out before returning.
        let raw = unsafe { (self.api.wait_event)(self.handle, timeout_seconds) };
        if raw.is_null() {
            return None;
        }
        let raw = unsafe { &*raw };
        match raw.event_id {
            EVENT_NONE => None,
            EVENT_SHUTDOWN => Some(MpvEvent::Shutdown),
            EVENT_START_FILE => Some(MpvEvent::StartFile),
            EVENT_FILE_LOADED => Some(MpvEvent::FileLoaded),
            EVENT_VIDEO_RECONFIG => Some(MpvEvent::VideoReconfig),
            EVENT_SEEK => Some(MpvEvent::Seek),
            EVENT_PLAYBACK_RESTART => Some(MpvEvent::PlaybackRestart),
            EVENT_COMMAND_REPLY => Some(MpvEvent::CommandReply {
                id: raw.reply_userdata,
                error: (raw.error < 0).then(|| self.api.error_message(raw.error)),
            }),
            EVENT_CLIENT_MESSAGE => {
                let data = raw.data as *const RawEventClientMessage;
                if data.is_null() {
                    return Some(MpvEvent::ClientMessage(Vec::new()));
                }
                // SAFETY: CLIENT_MESSAGE carries an mpv_event_client_message
                // with `num_args` zero-terminated strings.
                let message = unsafe { &*data };
                let args = (0..message.num_args.max(0) as usize)
                    .map(|index| unsafe { CStr::from_ptr(*message.args.add(index)) })
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .collect();
                Some(MpvEvent::ClientMessage(args))
            }
            EVENT_END_FILE => {
                let data = raw.data as *const RawEventEndFile;
                let reason = if data.is_null() {
                    EndFileReason::Other
                } else {
                    // SAFETY: END_FILE carries an mpv_event_end_file.
                    let data = unsafe { &*data };
                    match data.reason {
                        0 => EndFileReason::Eof,
                        2 => EndFileReason::Stop,
                        3 => EndFileReason::Quit,
                        4 => EndFileReason::Error(self.api.error_message(data.error)),
                        _ => EndFileReason::Other,
                    }
                };
                Some(MpvEvent::EndFile(reason))
            }
            EVENT_PROPERTY_CHANGE => {
                let data = raw.data as *const RawEventProperty;
                if data.is_null() {
                    return Some(MpvEvent::Other(EVENT_PROPERTY_CHANGE));
                }
                // SAFETY: PROPERTY_CHANGE carries an mpv_event_property whose
                // `data` matches `format`.
                let property = unsafe { &*data };
                let name = unsafe { CStr::from_ptr(property.name) }
                    .to_string_lossy()
                    .into_owned();
                let value = unsafe { read_property_value(property.format, property.data) };
                Some(MpvEvent::PropertyChange {
                    id: raw.reply_userdata,
                    name,
                    value,
                })
            }
            other => Some(MpvEvent::Other(other)),
        }
    }

    /// Interrupt a `wait_event` blocked on another thread.
    pub fn wakeup(&self) {
        // SAFETY: valid handle; documented as callable from any thread.
        unsafe { (self.api.wakeup)(self.handle) }
    }
}

/// # Safety
/// `data` must point to a value of `format`, as mpv guarantees for property
/// events.
unsafe fn read_property_value(format: c_int, data: *mut c_void) -> PropertyValue {
    if data.is_null() {
        return PropertyValue::None;
    }
    match format {
        FORMAT_FLAG => PropertyValue::Flag(*(data as *const c_int) != 0),
        FORMAT_INT64 => PropertyValue::Int(*(data as *const i64)),
        FORMAT_DOUBLE => PropertyValue::Double(*(data as *const f64)),
        FORMAT_STRING => {
            let text = *(data as *const *const c_char);
            if text.is_null() {
                PropertyValue::None
            } else {
                PropertyValue::String(CStr::from_ptr(text).to_string_lossy().into_owned())
            }
        }
        _ => PropertyValue::None,
    }
}

/// How a property should be delivered in [`MpvEvent::PropertyChange`].
#[derive(Debug, Clone, Copy)]
pub enum ObserveAs {
    Flag,
    Int,
    Double,
    String,
    /// Only notify that it changed.
    Notify,
}

impl Drop for Mpv {
    fn drop(&mut self) {
        // SAFETY: valid handle, destroyed exactly once.
        unsafe { (self.api.terminate_destroy)(self.handle) }
    }
}
