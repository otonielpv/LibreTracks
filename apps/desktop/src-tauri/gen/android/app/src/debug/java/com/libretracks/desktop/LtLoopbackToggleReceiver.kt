package com.libretracks.desktop

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log

/**
 * DEBUG ONLY. "Unplug" and "replug" the LT Loopback MIDI device from adb, to
 * test hot-plug reconnection in the emulator (plan mobile-midi, paso 04):
 *
 *   adb shell am broadcast -n com.libretracks.app/com.libretracks.desktop.LtLoopbackToggleReceiver --ez enabled false
 *
 * The shell may not change another app's components; the app may change its
 * own, so the toggle runs here. Lives in the debug source set with the
 * loopback itself, so release builds have neither.
 */
class LtLoopbackToggleReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val enabled = intent.getBooleanExtra("enabled", true)
    context.packageManager.setComponentEnabledSetting(
      ComponentName(context, LtLoopbackService::class.java),
      if (enabled) {
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED
      } else {
        PackageManager.COMPONENT_ENABLED_STATE_DISABLED
      },
      PackageManager.DONT_KILL_APP,
    )
    Log.i("LTMidi", "LT Loopback enabled=$enabled")
  }
}
