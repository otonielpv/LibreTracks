package com.libretracks.desktop

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Immersive fullscreen: with edge-to-edge the WebView draws under the
    // status bar, whose overlay also STEALS the touches in that strip — the
    // app's top bar (FILE menu, transport buttons) sat exactly there and was
    // untappable. A live-performance DAW wants the whole screen anyway, so
    // hide the system bars; swipe from the edge reveals them transiently.
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    controller.hide(WindowInsetsCompat.Type.systemBars())

    // The show must go on: never let the device sleep mid-performance while
    // LibreTracks is in the foreground.
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }
}
