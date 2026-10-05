//! The video output on Android (plan `video-mobile`, pasos 03 and 05): JNI
//! calls into `VideoOutputBridge.kt`, which owns the `Presentation` on the
//! external display and the Media3 players.
//!
//! Every call returns at once: the Kotlin side only `Handler.post`s the work
//! onto the main looper, which is the only thread ExoPlayer may be touched
//! from. The events come back through the `native*` functions at the bottom,
//! which do nothing but decode (`video::native_events`, tested on every host)
//! and push into the output's channel.
//!
//! A missing class (an APK built without the bridge) is
//! `BackendError::Unavailable` with the reason, never a panic.

#![cfg(target_os = "android")]

use std::sync::OnceLock;

use jni::objects::{GlobalRef, JByteArray, JClass, JObject, JObjectArray, JString, JValue};
use jni::sys::{jdouble, jint};
use jni::{JNIEnv, JavaVM};

use libretracks_core::VideoFit;
use libretracks_video::native::NativeVideoBridge;
use libretracks_video::output::{BackendError, PlayerCommand, Slot};

use crate::video::native_events;

/// Kotlin namespace, not the Play applicationId (see `android_token_store`).
const CLASS: &str = "com.libretracks.desktop.VideoOutputBridge";
/// Analysis and thumbnails (paso 07), blocking, for worker threads.
const PROBE_CLASS: &str = "com.libretracks.desktop.VideoProbe";

static BRIDGE_CLASS: OnceLock<GlobalRef> = OnceLock::new();
static PROBE_CLASS_REF: OnceLock<GlobalRef> = OnceLock::new();

fn vm() -> Result<JavaVM, String> {
    let ctx = ndk_context::android_context();
    unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("JavaVM::from_raw: {e}"))
}

/// Run `body` with an env, the app Context and the class `name`, loaded once
/// through the app class loader (a natively attached thread only sees the
/// system one) and cached in `cache`. The output thread calls at up to
/// 100 Hz, so threads attach permanently and each call runs in its own local
/// frame.
fn with_class<T>(
    name: &str,
    cache: &'static OnceLock<GlobalRef>,
    frame: i32,
    body: impl FnOnce(&mut JNIEnv, &JObject, &JClass) -> jni::errors::Result<T>,
) -> Result<T, String> {
    let vm = vm()?;
    let mut env = vm
        .attach_current_thread_permanently()
        .map_err(|e| format!("attach_current_thread_permanently: {e}"))?;
    let context = unsafe { JObject::from_raw(ndk_context::android_context().context().cast()) };
    let result = env.with_local_frame(frame, |env| -> jni::errors::Result<T> {
        let class = match cache.get() {
            Some(class) => class,
            None => {
                let loader = env
                    .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
                    .l()?;
                let class_name = env.new_string(name)?;
                let class = env
                    .call_method(
                        &loader,
                        "loadClass",
                        "(Ljava/lang/String;)Ljava/lang/Class;",
                        &[JValue::Object(&class_name)],
                    )?
                    .l()?;
                let global = env.new_global_ref(class)?;
                cache.get_or_init(|| global)
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
    result.map_err(|e| format!("{name}: {e}"))
}

fn with_bridge<T>(
    body: impl FnOnce(&mut JNIEnv, &JClass) -> jni::errors::Result<T>,
) -> Result<T, String> {
    with_class(CLASS, &BRIDGE_CLASS, 16, |env, _context, class| {
        body(env, class)
    })
}

/// `VideoProbe.probe(context, path)`: the analysis as JSON
/// (`libretracks_video::media::parse_native_probe`).
pub fn probe_json(path: &str) -> Result<String, String> {
    with_class(PROBE_CLASS, &PROBE_CLASS_REF, 16, |env, context, class| {
        let path = env.new_string(path)?;
        let value = env
            .call_static_method(
                class,
                "probe",
                "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(context), JValue::Object(&path)],
            )?
            .l()?;
        Ok(env.get_string(&JString::from(value))?.into())
    })
}

/// The provider's display name of a picked `content://` document
/// (`OpenableColumns.DISPLAY_NAME`), if it gives one.
pub fn display_name(uri: &str) -> Option<String> {
    with_class(PROBE_CLASS, &PROBE_CLASS_REF, 16, |env, context, class| {
        let uri = env.new_string(uri)?;
        let value = env
            .call_static_method(
                class,
                "displayName",
                "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(context), JValue::Object(&uri)],
            )?
            .l()?;
        if value.is_null() {
            return Ok(None);
        }
        Ok(Some(env.get_string(&JString::from(value))?.into()))
    })
    .ok()
    .flatten()
}

/// `VideoProbe.frames(context, path, times, width)`: one JPEG per time, or
/// null where the decoder produced nothing.
pub fn frames(path: &str, times: &[f64], max_width: u32) -> Vec<Option<Vec<u8>>> {
    let result = with_class(
        PROBE_CLASS,
        &PROBE_CLASS_REF,
        (times.len() as i32 + 16).max(16),
        |env, context, class| {
            let path = env.new_string(path)?;
            let array = env.new_double_array(times.len() as i32)?;
            env.set_double_array_region(&array, 0, times)?;
            let value = env
                .call_static_method(
                    class,
                    "frames",
                    "(Landroid/content/Context;Ljava/lang/String;[DI)[[B",
                    &[
                        JValue::Object(context),
                        JValue::Object(&path),
                        JValue::Object(&array),
                        JValue::Int(max_width as i32),
                    ],
                )?
                .l()?;
            let mut out = Vec::with_capacity(times.len());
            if value.is_null() {
                out.resize(times.len(), None);
                return Ok(out);
            }
            let array = JObjectArray::from(value);
            for index in 0..env.get_array_length(&array)? {
                let item = env.get_object_array_element(&array, index)?;
                if item.is_null() {
                    out.push(None);
                } else {
                    out.push(Some(env.convert_byte_array(JByteArray::from(item))?));
                }
            }
            Ok(out)
        },
    );
    match result {
        Ok(frames) => frames,
        Err(error) => {
            eprintln!("[LT_VIDEO] frames: {error}");
            vec![None; times.len()]
        }
    }
}

fn slot_arg(slot: Slot) -> JValue<'static, 'static> {
    JValue::Int(match slot {
        Slot::A => 0,
        Slot::B => 1,
    })
}

fn fit_arg(fit: VideoFit) -> JValue<'static, 'static> {
    JValue::Int(match fit {
        VideoFit::Contain => 0,
        VideoFit::Cover => 1,
        VideoFit::Stretch => 2,
    })
}

fn log_failure(what: &str, result: Result<(), String>) {
    if let Err(error) = result {
        eprintln!("[LT_VIDEO] {what}: {error}");
    }
}

/// [`NativeVideoBridge`] over the Kotlin object.
pub struct AndroidVideoBridge;

impl AndroidVideoBridge {
    /// Ask the native side for the current displays (it pushes them again
    /// through `nativeOnDisplays`) and start listening for changes.
    pub fn start() {
        log_failure(
            "start",
            with_bridge(|env, class| {
                env.call_static_method(class, "start", "()V", &[])?;
                Ok(())
            }),
        );
    }

    fn call(&self, what: &str, method: &str, signature: &str, args: &[JValue]) {
        log_failure(
            what,
            with_bridge(|env, class| {
                env.call_static_method(class, method, signature, args)?;
                Ok(())
            }),
        );
    }
}

impl NativeVideoBridge for AndroidVideoBridge {
    fn open(&self, display: &str, fit: VideoFit) -> Result<(), BackendError> {
        with_bridge(|env, class| {
            let display = env.new_string(display)?;
            env.call_static_method(
                class,
                "open",
                "(Ljava/lang/String;I)Z",
                &[JValue::Object(&display), fit_arg(fit)],
            )?
            .z()
        })
        .map_err(BackendError::Unavailable)
        .and_then(|queued| {
            if queued {
                Ok(())
            } else {
                Err(BackendError::Failed(
                    "la salida de vídeo aún no tiene ventana de la app".into(),
                ))
            }
        })
    }

    fn close(&self) {
        self.call("close", "close", "()V", &[]);
    }

    fn player(&self, slot: Slot, command: &PlayerCommand) {
        let result = with_bridge(|env, class| {
            match command {
                PlayerCommand::Load {
                    path,
                    start_seconds,
                    paused,
                } => {
                    let path = env.new_string(path)?;
                    env.call_static_method(
                        class,
                        "load",
                        "(ILjava/lang/String;DZ)V",
                        &[
                            slot_arg(slot),
                            JValue::Object(&path),
                            JValue::Double(*start_seconds),
                            JValue::Bool((*paused).into()),
                        ],
                    )?;
                }
                PlayerCommand::Seek { seconds } => {
                    env.call_static_method(
                        class,
                        "seek",
                        "(ID)V",
                        &[slot_arg(slot), JValue::Double(*seconds)],
                    )?;
                }
                PlayerCommand::SetPause(paused) => {
                    env.call_static_method(
                        class,
                        "setPause",
                        "(IZ)V",
                        &[slot_arg(slot), JValue::Bool((*paused).into())],
                    )?;
                }
                PlayerCommand::SetSpeed(speed) => {
                    env.call_static_method(
                        class,
                        "setSpeed",
                        "(ID)V",
                        &[slot_arg(slot), JValue::Double(*speed)],
                    )?;
                }
                PlayerCommand::Stop => {
                    env.call_static_method(class, "stop", "(I)V", &[slot_arg(slot)])?;
                }
            }
            Ok(())
        });
        log_failure("player", result);
    }

    fn show_slot(&self, slot: Slot) {
        self.call("showSlot", "showSlot", "(I)V", &[slot_arg(slot)]);
    }

    fn set_brightness(&self, value: f64) {
        self.call(
            "setBrightness",
            "setBrightness",
            "(D)V",
            &[JValue::Double(value)],
        );
    }

    fn set_fit(&self, fit: VideoFit) {
        self.call("setFit", "setFit", "(I)V", &[fit_arg(fit)]);
    }

    fn show_image(&self, slot: Slot, path: Option<&str>) {
        let result = with_bridge(|env, class| {
            let path = match path {
                Some(path) => JObject::from(env.new_string(path)?),
                None => JObject::null(),
            };
            env.call_static_method(
                class,
                "showImage",
                "(ILjava/lang/String;)V",
                &[slot_arg(slot), JValue::Object(&path)],
            )?;
            Ok(())
        });
        log_failure("showImage", result);
    }

    fn dual_players(&self) -> bool {
        // Two until the native side fails to create the second decoder and
        // says so (`kind::SECOND_PLAYER`).
        true
    }

    fn set_keep_awake(&self, on: bool) {
        self.call(
            "setKeepAwake",
            "setKeepAwake",
            "(Z)V",
            &[JValue::Bool(on.into())],
        );
    }
}

fn optional_string(env: &mut JNIEnv, text: &JString) -> Option<String> {
    if text.is_null() {
        return None;
    }
    env.get_string(text).ok().map(Into::into)
}

/// `VideoOutputBridge.nativeOnVideoTime`, once per display frame per playing
/// player (`Choreographer`). A channel send.
#[no_mangle]
pub extern "system" fn Java_com_libretracks_desktop_VideoOutputBridge_nativeOnVideoTime(
    _env: JNIEnv,
    _class: JClass,
    slot: jint,
    seconds: jdouble,
) {
    native_events::emit(libretracks_video::output::BackendEvent::TimePos {
        slot: if slot == 1 { Slot::B } else { Slot::A },
        seconds,
    });
}

/// `VideoOutputBridge.nativeOnVideoEvent`: everything else, by kind
/// (`native_events::kind`).
#[no_mangle]
pub extern "system" fn Java_com_libretracks_desktop_VideoOutputBridge_nativeOnVideoEvent(
    mut env: JNIEnv,
    _class: JClass,
    kind: jint,
    slot: jint,
    text: JString,
) {
    let text = optional_string(&mut env, &text);
    if let Some(event) = native_events::decode_event(kind, slot, text.as_deref()) {
        native_events::emit(event);
    }
}

/// `VideoOutputBridge.nativeOnDisplays`: the external displays, one per line
/// (`native_events::parse_displays`).
#[no_mangle]
pub extern "system" fn Java_com_libretracks_desktop_VideoOutputBridge_nativeOnDisplays(
    mut env: JNIEnv,
    _class: JClass,
    lines: JString,
) {
    let lines = optional_string(&mut env, &lines).unwrap_or_default();
    native_events::displays_changed(native_events::parse_displays(&lines));
}
