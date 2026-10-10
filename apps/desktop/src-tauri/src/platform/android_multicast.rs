//! Android filters incoming multicast unless the app holds a Wi-Fi
//! `MulticastLock`, so mDNS (network-session discovery) hears nothing without
//! one. Held only while this device advertises or browses: it costs battery.
//!
//! `WifiManager` is a system class, so plain JNI reaches it from any thread
//! (no app class loader needed, unlike the Kotlin bridges). Needs the normal
//! permission `CHANGE_WIFI_MULTICAST_STATE`.

#![cfg(target_os = "android")]

use std::sync::Mutex;

use jni::{
    objects::{GlobalRef, JObject, JValue},
    JavaVM,
};

static LOCK: Mutex<Option<GlobalRef>> = Mutex::new(None);

fn vm() -> Result<JavaVM, String> {
    let ctx = ndk_context::android_context();
    unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("JavaVM::from_raw: {e}"))
}

/// Acquire (`on`) or release the lock. Idempotent; failures are logged and
/// ignored (discovery then only works on devices that do not filter).
pub fn set_multicast_lock(on: bool) {
    if let Err(error) = set(on) {
        eprintln!("[libretracks-link] multicast lock: {error}");
    }
}

fn set(on: bool) -> Result<(), String> {
    let mut held = LOCK.lock().map_err(|_| "lock poisoned".to_string())?;
    if on == held.is_some() {
        return Ok(());
    }
    let vm = vm()?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach: {e}"))?;

    if !on {
        if let Some(lock) = held.take() {
            env.call_method(lock.as_obj(), "release", "()V", &[])
                .map_err(|e| format!("release: {e}"))?;
        }
        return Ok(());
    }

    let context = unsafe { JObject::from_raw(ndk_context::android_context().context().cast()) };
    let app_context = env
        .call_method(
            &context,
            "getApplicationContext",
            "()Landroid/content/Context;",
            &[],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("getApplicationContext: {e}"))?;
    let service = env.new_string("wifi").map_err(|e| e.to_string())?;
    let wifi = env
        .call_method(
            &app_context,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[JValue::Object(&service)],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("getSystemService: {e}"))?;
    if wifi.is_null() {
        return Err("no WifiManager".into());
    }
    let tag = env
        .new_string("libretracks-link")
        .map_err(|e| e.to_string())?;
    let lock = env
        .call_method(
            &wifi,
            "createMulticastLock",
            "(Ljava/lang/String;)Landroid/net/wifi/WifiManager$MulticastLock;",
            &[JValue::Object(&tag)],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("createMulticastLock: {e}"))?;
    env.call_method(&lock, "setReferenceCounted", "(Z)V", &[JValue::Bool(0)])
        .map_err(|e| format!("setReferenceCounted: {e}"))?;
    env.call_method(&lock, "acquire", "()V", &[])
        .map_err(|e| format!("acquire: {e}"))?;
    *held = Some(env.new_global_ref(&lock).map_err(|e| e.to_string())?);
    Ok(())
}
