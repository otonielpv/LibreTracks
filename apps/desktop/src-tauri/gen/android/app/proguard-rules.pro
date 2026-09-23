# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# SecureTokenStore is reached only from Rust over JNI (see
# src/platform/android_token_store.rs), which looks the class up by its fully
# qualified name and calls load/save/clear by name and signature. R8 sees no
# reference to any of it from Java or Kotlin, so in release builds it stripped
# the whole thing — the cloud sign-in token could not be stored or read, and
# the only trace was a NoSuchMethodError on System.err. Debug builds do not
# minify, so this never showed up in local testing. Nothing here may be
# renamed or removed.
-keep class com.libretracks.desktop.SecureTokenStore { *; }

# Lo mismo, en MainActivity: `pickPersistableAudioDocuments` (el selector de
# audio con permiso persistible del import por referencia) sólo se llama desde
# Rust por JNI (src/platform/android_persistable_pick.rs), buscándolo por nombre
# y firma. R8 no ve ningún llamante en Java/Kotlin y lo borraba de la build de
# release: en el teléfono salía `NoSuchMethodError` y el import de audio no
# hacía nada. Los métodos `native` (nativeOnTrimMemory,
# nativeOnAudioDocumentsPicked) ya sobreviven por las reglas por defecto; los
# que Rust invoca, no. Cualquier método nuevo que Rust llame por nombre en esta
# Activity tiene que añadirse aquí.
-keepclassmembers class com.libretracks.desktop.MainActivity {
    public void pickPersistableAudioDocuments();
}
