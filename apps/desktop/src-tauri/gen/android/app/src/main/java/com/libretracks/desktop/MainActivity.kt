package com.libretracks.desktop

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.util.Log
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    hideSystemBars()

    // The show must go on: never let the device sleep mid-performance while
    // LibreTracks is in the foreground.
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

    // Foreground media service + audio focus so playback survives the screen
    // turning off or the user switching apps. Lives for the whole app run;
    // see AudioPlaybackService for the rationale.
    ContextCompat.startForegroundService(
      this,
      Intent(this, AudioPlaybackService::class.java),
    )

    requestStorageAccessOnce()
    installVoiceGuideAssets()
  }

  // Android warns before it kills. Ignoring that warning is how importing a
  // 2 GB .ltset ended with the system killing ~40 other processes and
  // restarting system_server; see docs/plans/android-low-end/.
  //
  // Straight to native rather than through the WebView: under real pressure the
  // WebView process is itself a kill candidate, so a warning that has to travel
  // through it is a warning we may never receive. The native side keeps each
  // playing source's read-ahead window, so this never silences a performance.
  override fun onTrimMemory(level: Int) {
    super.onTrimMemory(level)
    notifyNativeMemoryPressure(level)
  }

  override fun onLowMemory() {
    super.onLowMemory()
    notifyNativeMemoryPressure(TRIM_MEMORY_COMPLETE)
  }

  private fun notifyNativeMemoryPressure(level: Int) {
    try {
      val freed = nativeOnTrimMemory(level)
      Log.i("LTMemory", "onTrimMemory(level=$level) released $freed bytes")
    } catch (error: UnsatisfiedLinkError) {
      // The Rust library may not be loaded yet (very early in startup) — there
      // is nothing cached to release in that case anyway.
      Log.w("LTMemory", "memory pressure before the native library: ${error.message}")
    }
  }

  // Whether the transport is running is decided on the native side, which owns
  // the answer; asking Kotlin would mean keeping a second copy of that state in
  // sync for no benefit.
  private external fun nativeOnTrimMemory(level: Int): Long

  // The voice-guide WAV bank ships as Android assets (assets/voices/), but the
  // native decoder needs fopen-able paths and Tauri's resource bundler doesn't
  // ship `resources` on Android. Copy the bank to filesDir/voices when the
  // install changes so the Rust side can point the engine at a real directory.
  // Keyed by lastUpdateTime (not versionCode) so re-installing a build that
  // changed the bank without bumping the version still refreshes it. Runs off
  // the UI thread — ~33 MB of WAVs.
  private fun installVoiceGuideAssets() {
    Thread {
      try {
        val dest = File(filesDir, "voices")
        val stamp = File(filesDir, "voices/.version")
        val version = packageManager
          .getPackageInfo(packageName, 0)
          .lastUpdateTime
          .toString()
        if (dest.isDirectory && stamp.isFile && stamp.readText() == version) {
          return@Thread
        }
        dest.deleteRecursively()
        copyAssetDir("voices", dest)
        stamp.writeText(version)
        Log.i("LTVoiceGuide", "voice-guide assets installed to ${dest.absolutePath}")
      } catch (e: Exception) {
        Log.e("LTVoiceGuide", "failed to install voice-guide assets", e)
      }
    }.start()
  }

  private fun copyAssetDir(assetPath: String, destDir: File) {
    val entries = assets.list(assetPath) ?: emptyArray()
    if (entries.isEmpty()) {
      // A leaf (file): copy its bytes.
      destDir.parentFile?.mkdirs()
      assets.open(assetPath).use { input ->
        destDir.outputStream().use { output -> input.copyTo(output) }
      }
      return
    }
    destDir.mkdirs()
    for (entry in entries) {
      copyAssetDir("$assetPath/$entry", File(destDir, entry))
    }
  }

  // Open-session-in-place needs to read session FOLDERS anywhere on storage
  // (the engine streams audio by real path; SAF's single-file URIs can't
  // cover a folder). Android 10: the classic runtime permission (with
  // requestLegacyExternalStorage). Android 11+: the "all files access"
  // toggle — fire its Settings screen once on first run.
  private fun requestStorageAccessOnce() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      if (Environment.isExternalStorageManager()) return
      val prefs = getSharedPreferences("lt_permissions", MODE_PRIVATE)
      if (prefs.getBoolean("asked_all_files", false)) return
      prefs.edit().putBoolean("asked_all_files", true).apply()
      try {
        startActivity(
          Intent(
            Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
            Uri.parse("package:$packageName"),
          ),
        )
      } catch (e: Exception) {
        try {
          startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
        } catch (_: Exception) {
          // Device without the screen: the in-app error message covers it.
        }
      }
    } else {
      val granted = ContextCompat.checkSelfPermission(
        this,
        Manifest.permission.READ_EXTERNAL_STORAGE,
      ) == PackageManager.PERMISSION_GRANTED
      if (!granted) {
        ActivityCompat.requestPermissions(
          this,
          arrayOf(
            Manifest.permission.READ_EXTERNAL_STORAGE,
            Manifest.permission.WRITE_EXTERNAL_STORAGE,
          ),
          0x4C54,
        )
      }
    }
  }

  override fun onDestroy() {
    stopService(Intent(this, AudioPlaybackService::class.java))
    super.onDestroy()
  }

  // Some OEM skins (ColorOS on the Oppo A5 test device) drop the immersive
  // state whenever the window regains focus — after the transient bars, a
  // notification shade pull, or app switching — leaving the status bar
  // permanently drawn OVER the app's top controls and stealing their taps.
  // Re-asserting on every focus gain is the documented pattern.
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) {
      hideSystemBars()
    }
  }

  // Immersive fullscreen: with edge-to-edge the WebView draws under the
  // status bar, whose overlay also STEALS the touches in that strip — the
  // app's top bar (transport buttons) sat exactly there and was untappable.
  // A live-performance DAW wants the whole screen anyway, so hide the system
  // bars; swipe from the edge reveals them transiently.
  private fun hideSystemBars() {
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    controller.hide(WindowInsetsCompat.Type.systemBars())
  }
}
