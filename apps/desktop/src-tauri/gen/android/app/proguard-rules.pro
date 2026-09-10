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
