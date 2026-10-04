//! Android transport: `android.media.midi` through the Kotlin bridge
//! `MidiBridge.kt` (gen/android/.../desktop/MidiBridge.kt).
//!
//! - Listing: `MidiBridge.listPorts` gives `deviceId/portIndex/names` lines;
//!   `android_ports::name_ports` turns them into unique names. The numeric id
//!   changes on every reconnection, so it is never persisted: only the name.
//! - Input: Kotlin's `MidiReceiver` calls `nativeOnMidiBytes(handle, …)`,
//!   which copies the bytes and hands them to the listener's callback. No
//!   session locks or emits happen on the Java thread.
//! - Output: the per-port writer thread calls `MidiBridge.send`.
//!
//! Every JNI failure becomes an `Err` or an empty list, never a panic.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicI64, Ordering},
        Mutex, OnceLock,
    },
};

use jni::{
    objects::{GlobalRef, JByteArray, JClass, JObject, JObjectArray, JString, JValue},
    sys::{jint, jlong},
    JNIEnv, JavaVM,
};

use super::{
    android_ports::{name_ports, PortAddress},
    InputConnection, MidiCapabilities, MidiTransport, OnBytes, OutputConnection,
};

const CLASS: &str = "com.libretracks.desktop.MidiBridge";

/// Callbacks of open inputs, by handle. `nativeOnMidiBytes` looks them up.
static INPUT_SINKS: OnceLock<Mutex<HashMap<i64, OnBytes>>> = OnceLock::new();

fn input_sinks() -> &'static Mutex<HashMap<i64, OnBytes>> {
    INPUT_SINKS.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_HANDLE: AtomicI64 = AtomicI64::new(1);

/// The bridge class, loaded once through the app class loader. A thread
/// attached from native code only sees the system class loader, so
/// `FindClass` would not find it (same trap as `android_token_store.rs`).
static BRIDGE_CLASS: OnceLock<GlobalRef> = OnceLock::new();

fn vm() -> Result<JavaVM, String> {
    let ctx = ndk_context::android_context();
    unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("JavaVM::from_raw: {e}"))
}

/// Run `body` with an env, the app Context and the bridge class.
///
/// Threads are attached permanently: the writer thread sends every few
/// milliseconds and attaching per call would cost far more than the send.
/// Because a permanently attached thread never frees its local references,
/// every call runs inside its own local frame.
fn with_bridge<T>(
    body: impl FnOnce(&mut JNIEnv, &JObject, &JClass) -> jni::errors::Result<T>,
) -> Result<T, String> {
    let vm = vm()?;
    let mut env = vm
        .attach_current_thread_permanently()
        .map_err(|e| format!("attach_current_thread_permanently: {e}"))?;
    let context = unsafe { JObject::from_raw(ndk_context::android_context().context().cast()) };

    let result = env.with_local_frame(32, |env| -> jni::errors::Result<T> {
        let class = match BRIDGE_CLASS.get() {
            Some(class) => class,
            None => {
                let loader = env
                    .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
                    .l()?;
                let class_name = env.new_string(CLASS)?;
                let class = env
                    .call_method(
                        &loader,
                        "loadClass",
                        "(Ljava/lang/String;)Ljava/lang/Class;",
                        &[JValue::Object(&class_name)],
                    )?
                    .l()?;
                let global = env.new_global_ref(class)?;
                BRIDGE_CLASS.get_or_init(|| global)
            }
        };
        let class: &JClass = class.as_obj().into();
        body(env, &context, class)
    });

    // A pending Java exception poisons every later JNI call on this thread.
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    result.map_err(|e| format!("MidiBridge: {e}"))
}

#[derive(Default)]
pub(crate) struct AndroidTransport {
    /// Last listing per direction (`true` = our outputs), name → address.
    addresses: Mutex<HashMap<(bool, String), PortAddress>>,
}

impl AndroidTransport {
    fn list(&self, our_output: bool) -> Result<Vec<String>, String> {
        let lines = with_bridge(|env, context, class| {
            let array = env
                .call_static_method(
                    class,
                    "listPorts",
                    "(Landroid/content/Context;Z)[Ljava/lang/String;",
                    &[JValue::Object(context), JValue::Bool(our_output.into())],
                )?
                .l()?;
            if array.is_null() {
                return Ok(Vec::new());
            }
            let array = JObjectArray::from(array);
            let len = env.get_array_length(&array)?;
            let mut lines = Vec::with_capacity(len as usize);
            for i in 0..len {
                let item = env.get_object_array_element(&array, i)?;
                let text: String = env.get_string(&JString::from(item))?.into();
                lines.push(text);
            }
            Ok(lines)
        })?;

        let named = name_ports(&lines);
        if let Ok(mut addresses) = self.addresses.lock() {
            addresses.retain(|(direction, _), _| *direction != our_output);
            for (name, address) in &named {
                addresses.insert((our_output, name.clone()), *address);
            }
        }
        Ok(named.into_iter().map(|(name, _)| name).collect())
    }

    fn address(&self, our_output: bool, name: &str) -> Result<PortAddress, String> {
        // Refresh first: ids change on every reconnection.
        self.list(our_output)?;
        self.addresses
            .lock()
            .map_err(|_| "midi address lock poisoned".to_string())?
            .get(&(our_output, name.to_string()))
            .copied()
            .ok_or_else(|| format!("MIDI device not found: {name}"))
    }

    fn open(&self, method: &str, address: PortAddress, handle: i64) -> Result<bool, String> {
        with_bridge(|env, context, class| {
            env.call_static_method(
                class,
                method,
                "(Landroid/content/Context;IIJ)Z",
                &[
                    JValue::Object(context),
                    JValue::Int(address.device_id),
                    JValue::Int(address.port_index),
                    JValue::Long(handle),
                ],
            )?
            .z()
        })
    }
}

fn close_handle(handle: i64) {
    let _ = with_bridge(|env, _context, class| {
        env.call_static_method(class, "close", "(J)V", &[JValue::Long(handle)])?;
        Ok(())
    });
}

struct AndroidInput {
    handle: i64,
}

impl InputConnection for AndroidInput {}

impl Drop for AndroidInput {
    fn drop(&mut self) {
        close_handle(self.handle);
        if let Ok(mut sinks) = input_sinks().lock() {
            sinks.remove(&self.handle);
        }
    }
}

struct AndroidOutput {
    handle: i64,
}

impl OutputConnection for AndroidOutput {
    fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        let handle = self.handle;
        let sent = with_bridge(|env, _context, class| {
            let array = env.byte_array_from_slice(bytes)?;
            env.call_static_method(
                class,
                "send",
                "(J[BI)Z",
                &[
                    JValue::Long(handle),
                    JValue::Object(&array),
                    JValue::Int(bytes.len() as jint),
                ],
            )?
            .z()
        })?;
        if sent {
            Ok(())
        } else {
            Err("MIDI send failed (device gone?)".into())
        }
    }
}

impl Drop for AndroidOutput {
    fn drop(&mut self) {
        close_handle(self.handle);
    }
}

impl MidiTransport for AndroidTransport {
    fn input_names(&self) -> Result<Vec<String>, String> {
        self.list(false)
    }

    fn output_names(&self) -> Result<Vec<String>, String> {
        self.list(true)
    }

    fn open_input(&self, name: &str, on_bytes: OnBytes) -> Result<Box<dyn InputConnection>, String> {
        let address = self.address(false, name)?;
        let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
        // Register before opening: the first bytes may arrive before
        // openInput returns.
        input_sinks()
            .lock()
            .map_err(|_| "midi input sinks lock poisoned".to_string())?
            .insert(handle, on_bytes);
        match self.open("openInput", address, handle) {
            Ok(true) => Ok(Box::new(AndroidInput { handle })),
            other => {
                if let Ok(mut sinks) = input_sinks().lock() {
                    sinks.remove(&handle);
                }
                Err(match other {
                    Err(error) => error,
                    _ => format!("could not open MIDI input: {name}"),
                })
            }
        }
    }

    fn open_output(&self, name: &str) -> Result<Box<dyn OutputConnection>, String> {
        let address = self.address(true, name)?;
        let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
        match self.open("openOutput", address, handle)? {
            true => Ok(Box::new(AndroidOutput { handle })),
            false => Err(format!("could not open MIDI output: {name}")),
        }
    }

    fn capabilities(&self) -> MidiCapabilities {
        let available = with_bridge(|env, context, class| {
            env.call_static_method(
                class,
                "isAvailable",
                "(Landroid/content/Context;)Z",
                &[JValue::Object(context)],
            )?
            .z()
        })
        .unwrap_or(false);
        MidiCapabilities {
            available,
            ..MidiCapabilities::default()
        }
    }
}

/// Called by `MidiBridge.Forwarder.onSend` on a Java binder thread. Copies
/// the bytes and runs the listener's callback (framer + channel send) — no
/// locks besides the sink table, no emits.
#[no_mangle]
pub extern "system" fn Java_com_libretracks_desktop_MidiBridge_nativeOnMidiBytes(
    env: JNIEnv,
    _class: JClass,
    handle: jlong,
    data: JByteArray,
    offset: jint,
    count: jint,
) {
    if count <= 0 || offset < 0 {
        return;
    }
    let mut buffer = vec![0i8; count as usize];
    if env.get_byte_array_region(&data, offset, &mut buffer).is_err() {
        return;
    }
    let bytes: Vec<u8> = buffer.into_iter().map(|byte| byte as u8).collect();
    if let Ok(mut sinks) = input_sinks().lock() {
        if let Some(sink) = sinks.get_mut(&handle) {
            sink(&bytes);
        }
    }
}
