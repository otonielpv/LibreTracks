//! Android implementation of the cloud [`TokenStore`], over JNI.
//!
//! The desktop builds keep the Google refresh token in the OS credential store
//! through the `keyring` crate, which has no Android backend. Here the storage
//! is [`SecureTokenStore`](../../gen/android/app/src/main/java/com/libretracks/desktop/SecureTokenStore.kt):
//! an AES key that never leaves `AndroidKeyStore` — in hardware wherever the
//! device has a TEE — encrypting the token before it reaches SharedPreferences.
//!
//! Only the JNI plumbing lives here. Everything about *what* is stored, and the
//! rule that an unreadable blob means "sign in again" rather than a hard error,
//! belongs to the crate and the Kotlin side respectively.

#![cfg(target_os = "android")]

use jni::objects::{JClass, JObject, JString, JValue};
use jni::JavaVM;

use libretracks_cloud::token::{StoredToken, TokenStore};
use libretracks_cloud::CloudError;

/// Fully-qualified name of the Kotlin helper, in the dotted form `loadClass`
/// wants.
///
/// This is the Kotlin *namespace* (`com.libretracks.desktop`), NOT the Play
/// applicationId (`com.libretracks.app`). They differ on purpose, and using the
/// wrong one here fails at run time with a class-not-found that says nothing
/// about which of the two was meant.
const CLASS: &str = "com.libretracks.desktop.SecureTokenStore";

pub struct AndroidTokenStore {
    /// Entry name, so a second provider later does not collide with Google's.
    name: String,
}

impl AndroidTokenStore {
    pub fn new(provider: &str) -> Self {
        Self {
            name: provider.to_string(),
        }
    }

    pub fn google_drive() -> Self {
        Self::new("google-drive")
    }
}

/// Run `body` with an attached JNI environment, the application Context, and
/// the Kotlin helper class.
///
/// Every call re-attaches rather than caching an env: a `JNIEnv` is bound to the
/// thread that made it, and these run from whichever async task needed a token.
///
/// # Why the class is looked up through the Context, not by name
///
/// A thread attached from native code does NOT inherit the application class
/// loader — it gets the system one, whose `DexPathList` holds nothing of ours.
/// `env.call_static_method("com/libretracks/desktop/SecureTokenStore", ...)`
/// therefore failed at run time with `ClassNotFoundException` even though the
/// class was compiled and dexed into the APK. Asking the Context for its own
/// loader and calling `loadClass` finds it from any thread.
fn with_env<T>(
    body: impl FnOnce(&mut jni::JNIEnv, &JObject, &JClass) -> Result<T, jni::errors::Error>,
) -> Result<T, CloudError> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| CloudError::Network(format!("JavaVM::from_raw: {e}")))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| CloudError::Network(format!("attach_current_thread: {e}")))?;

    let context = unsafe { JObject::from_raw(ctx.context().cast()) };

    let result = (|| {
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
        let class = JClass::from(class);
        body(&mut env, &context, &class)
    })();

    // A pending Java exception poisons every later JNI call on this thread, so
    // it has to be cleared whatever happened — otherwise one failed read makes
    // everything after it fail too, for reasons that never appear in the log.
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }

    result.map_err(|e| CloudError::Network(format!("secure token store: {e}")))
}

impl TokenStore for AndroidTokenStore {
    fn load(&self) -> Result<Option<StoredToken>, CloudError> {
        let raw: Option<String> = with_env(|env, context, class| {
            let name = env.new_string(&self.name)?;
            let value = env
                .call_static_method(
                    class,
                    "load",
                    "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                    &[JValue::Object(context), JValue::Object(&name)],
                )?
                .l()?;

            if value.is_null() {
                return Ok(None);
            }
            let text: String = env.get_string(&JString::from(value))?.into();
            Ok(Some(text))
        })?;

        // Same rule as the desktop store: a blob that will not parse is from an
        // older shape or is corrupt, and either way asking for a fresh sign-in
        // beats leaving the user stuck with an error they cannot clear.
        Ok(raw.and_then(|text| serde_json::from_str(&text).ok()))
    }

    fn save(&self, token: &StoredToken) -> Result<(), CloudError> {
        let payload =
            serde_json::to_string(token).map_err(|e| CloudError::Network(e.to_string()))?;

        with_env(|env, context, class| {
            let name = env.new_string(&self.name)?;
            let value = env.new_string(&payload)?;
            env.call_static_method(
                class,
                "save",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V",
                &[
                    JValue::Object(context),
                    JValue::Object(&name),
                    JValue::Object(&value),
                ],
            )?;
            Ok(())
        })
    }

    fn clear(&self) -> Result<(), CloudError> {
        with_env(|env, context, class| {
            let name = env.new_string(&self.name)?;
            env.call_static_method(
                class,
                "clear",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[JValue::Object(context), JValue::Object(&name)],
            )?;
            Ok(())
        })
    }
}
