package com.libretracks.desktop

import android.app.Activity
import android.util.Log
import com.google.android.play.core.review.ReviewManagerFactory

/**
 * Pide a Google Play la hoja de "valora la app" (Play In-App Review).
 *
 * Play decide por su cuenta si la enseña (cuota por usuario, nunca en un APK
 * que no venga de Play) y no dice si lo hizo, así que aquí no hay respuesta:
 * se lanza y se olvida. Lo llama Rust (`platform/android_store_review.rs`) a
 * través de `MainActivity.requestStoreReview`, y solo después de comprobar que
 * no suena audio (`commands/store_review.rs`).
 */
object StoreReviewBridge {
  @JvmStatic
  fun request(activity: Activity) {
    activity.runOnUiThread {
      try {
        val manager = ReviewManagerFactory.create(activity)
        manager.requestReviewFlow().addOnCompleteListener { task ->
          if (!task.isSuccessful) {
            Log.w("LTReview", "requestReviewFlow falló", task.exception)
            return@addOnCompleteListener
          }
          if (activity.isFinishing || activity.isDestroyed) return@addOnCompleteListener
          manager.launchReviewFlow(activity, task.result)
        }
      } catch (error: Throwable) {
        Log.w("LTReview", "no se pudo pedir la valoración", error)
      }
    }
  }
}
