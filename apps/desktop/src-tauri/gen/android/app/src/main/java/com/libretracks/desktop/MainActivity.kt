package com.libretracks.desktop

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

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
