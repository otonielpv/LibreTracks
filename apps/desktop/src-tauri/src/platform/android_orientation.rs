//! Girar la Activity a vertical u horizontal (plan `portrait-text-modals`).
//!
//! La parte de Java es `MainActivity.setScreenOrientation`, que delega en
//! `OrientationBridge.kt` y fija `requestedOrientation` en el hilo de UI. Se
//! llama como método de instancia de la Activity (igual que
//! `android_create_document`) para no tener que cargar la clase con el class
//! loader de la app desde un hilo nativo.
//!
//! Girar no recrea la Activity: `configChanges` del manifiesto incluye
//! `orientation|screenSize`, así que el audio sigue sonando.

#![cfg(target_os = "android")]

use jni::objects::{JObject, JValue};
use jni::JavaVM;

use super::screen_orientation::ScreenOrientation;

pub fn set_screen_orientation(orientation: ScreenOrientation) -> Result<(), String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))?;
    // Tiene que coincidir con OrientationBridge.kt.
    let mode: i32 = match orientation {
        ScreenOrientation::Landscape => 0,
        ScreenOrientation::Portrait => 1,
        ScreenOrientation::Free => 2,
    };
    let result = env
        .call_method(
            &activity,
            "setScreenOrientation",
            "(I)V",
            &[JValue::Int(mode)],
        )
        .map(|_| ())
        .map_err(|e| format!("setScreenOrientation: {e}"));
    super::android_content_uri::clear_pending_exception(&mut env);
    result
}
