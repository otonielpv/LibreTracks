//! Android output-device enumeration via JNI.
//!
//! The C++ Oboe backend can only see the AAudio *default* route; the list of
//! concrete hardware endpoints (built-in speaker, wired headset, USB audio
//! interface, Bluetooth) lives behind `AudioManager.getDevices()`, a Java-only
//! API the NDK doesn't expose. We call it here from Rust using the `JavaVM` and
//! application `Context` that Tauri/tao already publish through `ndk-context`,
//! so the engine needs no JNI plumbing of its own.
//!
//! The returned ids are the Android `AudioDeviceInfo.getId()` integers rendered
//! as strings. They flow straight through `EngineCommand::SetOutputDevice`'s
//! `device_id` to Oboe's `AudioStreamBuilder::setDeviceId()`, so picking a
//! device in Settings opens exactly that endpoint. An empty id still means
//! "system default" everywhere, unchanged.

use jni::objects::{JIntArray, JObject, JObjectArray, JString};
use jni::JavaVM;

use lt_audio_engine_v2::DeviceInfo;

/// One enumerated Android output endpoint. Mirrors the fields of the engine's
/// `DeviceInfo` that a hardware endpoint can actually fill in; the rest
/// (sample_rate/buffer_size negotiated at open time) stay zeroed until opened.
struct AndroidOutputDevice {
    id: i32,
    /// Human-readable label built from product name + endpoint type.
    name: String,
    channel_count: i32,
}

// AudioDeviceInfo.TYPE_* constants (android.media.AudioDeviceInfo). Kept here
// rather than pulled over JNI so the labels don't cost extra field reads.
fn type_label(type_id: i32) -> &'static str {
    match type_id {
        1 => "Auricular",                 // TYPE_BUILTIN_EARPIECE
        2 => "Altavoz",                   // TYPE_BUILTIN_SPEAKER
        3 => "Auriculares con cable",     // TYPE_WIRED_HEADSET
        4 => "Auriculares con cable",     // TYPE_WIRED_HEADPHONES
        7 => "Bluetooth (SCO)",           // TYPE_BLUETOOTH_SCO
        8 => "Bluetooth",                 // TYPE_BLUETOOTH_A2DP
        9 => "HDMI",                      // TYPE_HDMI
        11 => "USB",                      // TYPE_USB_DEVICE
        12 => "USB",                      // TYPE_USB_ACCESSORY
        13 => "USB",                      // TYPE_DOCK
        22 => "USB",                      // TYPE_USB_HEADSET
        23 => "Altavoz auxiliar",         // TYPE_BUILTIN_SPEAKER_SAFE
        _ => "Salida de audio",
    }
}

/// Enumerate output devices via `AudioManager.getDevices(GET_DEVICES_OUTPUTS)`.
///
/// Returns an empty vec (never an error to the caller) if anything JNI-side
/// fails — a degraded enumeration must not break the audio-settings UI, which
/// still has the "system default" entry the engine always reports.
pub fn enumerate_output_devices() -> Vec<DeviceInfo> {
    match enumerate_inner() {
        Ok(devices) => devices
            .into_iter()
            .map(|d| DeviceInfo {
                device_id: d.id.to_string(),
                device_name: d.name,
                backend: "oboe".to_string(),
                sample_rate: 0,
                buffer_size: 0,
                output_channel_count: d.channel_count.max(1),
                output_channel_names: Vec::new(),
                last_error: String::new(),
            })
            .collect(),
        Err(err) => {
            // Log-and-swallow: the caller falls back to the engine's own list.
            eprintln!("[LT_AUDIO] Android device enumeration failed: {err}");
            Vec::new()
        }
    }
}

fn enumerate_inner() -> Result<Vec<AndroidOutputDevice>, String> {
    // JavaVM + application Context, published by tao's Android bootstrap.
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))?;

    // audioManager = context.getSystemService(Context.AUDIO_SERVICE)
    let audio_service = env
        .get_static_field("android/content/Context", "AUDIO_SERVICE", "Ljava/lang/String;")
        .and_then(|v| v.l())
        .map_err(|e| format!("AUDIO_SERVICE: {e}"))?;
    let audio_manager = env
        .call_method(
            &context,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[(&audio_service).into()],
        )
        .and_then(|v| v.l())
        .map_err(|e| format!("getSystemService(AUDIO_SERVICE): {e}"))?;
    if audio_manager.is_null() {
        return Err("AudioManager is null".to_string());
    }

    // AudioManager.GET_DEVICES_OUTPUTS == 2 (stable public constant).
    const GET_DEVICES_OUTPUTS: i32 = 2;
    let devices_array = env
        .call_method(
            &audio_manager,
            "getDevices",
            "(I)[Landroid/media/AudioDeviceInfo;",
            &[GET_DEVICES_OUTPUTS.into()],
        )
        .and_then(|v| v.l())
        .map_err(|e| format!("getDevices: {e}"))?;
    let array = JObjectArray::from(devices_array);
    let len = env
        .get_array_length(&array)
        .map_err(|e| format!("get_array_length: {e}"))?;

    let mut out = Vec::with_capacity(len as usize);
    for i in 0..len {
        let device = env
            .get_object_array_element(&array, i)
            .map_err(|e| format!("array[{i}]: {e}"))?;

        let id = env
            .call_method(&device, "getId", "()I", &[])
            .and_then(|v| v.i())
            .map_err(|e| format!("getId: {e}"))?;
        let type_id = env
            .call_method(&device, "getType", "()I", &[])
            .and_then(|v| v.i())
            .map_err(|e| format!("getType: {e}"))?;

        // getProductName() returns a CharSequence; toString() it.
        let product = env
            .call_method(&device, "getProductName", "()Ljava/lang/CharSequence;", &[])
            .and_then(|v| v.l())
            .ok()
            .filter(|o| !o.is_null())
            .and_then(|obj| {
                let s = env
                    .call_method(&obj, "toString", "()Ljava/lang/String;", &[])
                    .and_then(|v| v.l())
                    .ok()?;
                let jstr: JString = s.into();
                env.get_string(&jstr).ok().map(|s| s.to_string_lossy().into_owned())
            })
            .unwrap_or_default();

        // Channel count: getChannelCounts() returns an int[]; take the max.
        let channel_count = env
            .call_method(&device, "getChannelCounts", "()[I", &[])
            .and_then(|v| v.l())
            .ok()
            .filter(|o| !o.is_null())
            .and_then(|obj| {
                let arr = JIntArray::from(obj);
                let n = env.get_array_length(&arr).ok()?;
                if n == 0 {
                    return None;
                }
                let mut buf = vec![0i32; n as usize];
                env.get_int_array_region(&arr, 0, &mut buf).ok()?;
                buf.into_iter().max()
            })
            .unwrap_or(2);

        let label = type_label(type_id);
        let name = if product.trim().is_empty() {
            label.to_string()
        } else {
            format!("{label} — {}", product.trim())
        };

        out.push(AndroidOutputDevice {
            id,
            name,
            channel_count,
        });
    }

    Ok(out)
}
