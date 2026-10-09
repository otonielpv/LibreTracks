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
    public void pickVideoDocuments();
    public void createDocument(java.lang.String);
    public void pickLibraryTree();
    public java.lang.String[] listLibraryTree(java.lang.String);
    public void releaseLibraryTree(java.lang.String);
}

# MidiBridge: el transporte MIDI de Android (src/midi/transport/android.rs).
# Rust lo carga por nombre con el class loader de la app y llama a
# isAvailable/listPorts/openInput/openOutput/send/close por nombre y firma.
# Sin esta regla R8 lo borraría de la build de release, igual que pasó con
# SecureTokenStore. `nativeOnMidiBytes` ya lo protege la regla de métodos
# native de proguard-wry.pro, pero se mantiene todo el objeto por claridad.
-keep class com.libretracks.desktop.MidiBridge { *; }

# VideoOutputBridge: la salida de vídeo de Android (src/platform/android_video.rs,
# plan video-mobile). Rust lo carga por nombre con el class loader de la app y
# llama a start/open/close/load/seek/setPause/setSpeed/stop/showSlot/
# setBrightness/setFit/showImage/setKeepAwake por nombre y firma; R8 no ve a
# ningún llamante y lo borraría de la build de release.
-keep class com.libretracks.desktop.VideoOutputBridge { *; }
# VideoProbe: análisis y miniaturas de vídeo en Android (paso 07 de
# video-mobile); Rust llama a probe/frames por nombre y firma.
-keep class com.libretracks.desktop.VideoProbe { *; }
