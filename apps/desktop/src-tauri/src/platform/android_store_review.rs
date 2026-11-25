//! Pedir a Google Play la hoja de valoración (Play In-App Review).
//!
//! La parte de Java es `MainActivity.requestStoreReview`, que delega en
//! `StoreReviewBridge.kt`. Se llama como método de instancia de la Activity,
//! igual que `android_orientation`, para no cargar la clase desde un hilo
//! nativo. La comprobación de que no suena audio está en
//! `commands/store_review.rs`, nunca aquí.

#![cfg(target_os = "android")]

use jni::objects::JObject;
use jni::JavaVM;

pub fn request_store_review() -> Result<(), String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))?;
    let result = env
        .call_method(&activity, "requestStoreReview", "()V", &[])
        .map(|_| ())
        .map_err(|e| format!("requestStoreReview: {e}"));
    super::android_content_uri::clear_pending_exception(&mut env);
    result
}
