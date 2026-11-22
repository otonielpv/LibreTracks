package com.libretracks.desktop

import android.app.Activity
import android.content.pm.ActivityInfo

/**
 * Gira la app a vertical mientras está abierto un menú de escribir texto
 * (plan portrait-text-modals) y la devuelve a horizontal al cerrarlo. Con la
 * letra y acordes a pantalla completa la deja girar con el sensor (FREE).
 *
 * Lo llama Rust (`platform/android_orientation.rs`) a través de
 * `MainActivity.setScreenOrientation`. Fuera de esos menús la app sigue como
 * dice el manifiesto: `sensorLandscape`.
 *
 * Girar no recrea la Activity porque `configChanges` incluye
 * `orientation|screenSize`: el audio sigue sonando.
 */
object OrientationBridge {
  // Tienen que coincidir con platform/android_orientation.rs.
  const val LANDSCAPE = 0
  const val PORTRAIT = 1
  const val FREE = 2

  @JvmStatic
  fun set(activity: Activity, mode: Int) {
    val requested = when (mode) {
      PORTRAIT -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
      // SENSOR y no USER: sigue a como se sostiene el móvil aunque el
      // bloqueo de giro del sistema esté puesto, así nunca salta a vertical
      // con el móvil tumbado.
      FREE -> ActivityInfo.SCREEN_ORIENTATION_SENSOR
      else -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    }
    activity.runOnUiThread {
      if (activity.requestedOrientation != requested) {
        activity.requestedOrientation = requested
      }
    }
  }
}
