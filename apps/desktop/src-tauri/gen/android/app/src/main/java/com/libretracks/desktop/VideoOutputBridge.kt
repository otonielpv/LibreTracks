package com.libretracks.desktop

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log

/**
 * Video output for Android, driven from Rust over JNI
 * (src/platform/android_video.rs; plan video-mobile, paso 03).
 *
 * STUB of paso 03: it draws nothing. It answers each order with the events
 * the real one will send (FileLoaded, PlaybackRestart, a TimePos that moves
 * with the clock) so the Rust side — output thread and sync runtime — runs
 * end to end on a phone. Paso 05 replaces it with Media3 in a Presentation.
 *
 * Every entry point returns at once: the work is posted to the main looper.
 * Event kinds must match `video/native_events.rs::kind`.
 */
object VideoOutputBridge {
  private const val TAG = "LTVideo"

  private const val FILE_LOADED = 0
  private const val PLAYBACK_RESTART = 1

  private val main = Handler(Looper.getMainLooper())

  private class Player {
    var path: String? = null
    var position = 0.0
    var anchoredAt = 0L
    var playing = false
    var speed = 1.0

    fun now(): Double =
      if (playing) position + (SystemClock.uptimeMillis() - anchoredAt) / 1000.0 * speed else position

    fun anchor() {
      position = now()
      anchoredAt = SystemClock.uptimeMillis()
    }
  }

  private val players = arrayOf(Player(), Player())
  private var open = false

  private val ticker = object : Runnable {
    override fun run() {
      for (slot in 0..1) {
        val player = players[slot]
        if (open && player.playing && player.path != null) {
          emitTime(slot, player.now())
        }
      }
      if (open) main.postDelayed(this, 16)
    }
  }

  @JvmStatic
  fun start() {
    main.post { emitDisplays("") }
  }

  @JvmStatic
  fun open(display: String, fit: Int): Boolean {
    main.post {
      open = true
      main.removeCallbacks(ticker)
      main.post(ticker)
      Log.i(TAG, "stub open on $display (fit $fit)")
    }
    return true
  }

  @JvmStatic
  fun close() {
    main.post {
      open = false
      for (player in players) player.path = null
    }
  }

  @JvmStatic
  fun load(slot: Int, path: String, startSeconds: Double, paused: Boolean) {
    main.post {
      val player = players[slot]
      player.path = path
      player.position = startSeconds
      player.anchoredAt = SystemClock.uptimeMillis()
      player.playing = !paused
      emit(FILE_LOADED, slot, null)
      emit(PLAYBACK_RESTART, slot, null)
    }
  }

  @JvmStatic
  fun seek(slot: Int, seconds: Double) {
    main.post {
      val player = players[slot]
      player.position = seconds
      player.anchoredAt = SystemClock.uptimeMillis()
      emit(PLAYBACK_RESTART, slot, null)
    }
  }

  @JvmStatic
  fun setPause(slot: Int, paused: Boolean) {
    main.post {
      val player = players[slot]
      player.anchor()
      player.playing = !paused
    }
  }

  @JvmStatic
  fun setSpeed(slot: Int, speed: Double) {
    main.post {
      val player = players[slot]
      player.anchor()
      player.speed = speed
    }
  }

  @JvmStatic
  fun stop(slot: Int) {
    main.post { players[slot].path = null }
  }

  @JvmStatic fun showSlot(slot: Int) {}

  @JvmStatic fun setBrightness(value: Double) {}

  @JvmStatic fun setFit(fit: Int) {}

  @JvmStatic fun showImage(slot: Int, path: String?) {}

  @JvmStatic fun setKeepAwake(on: Boolean) {}

  private fun emit(kind: Int, slot: Int, text: String?) {
    try {
      nativeOnVideoEvent(kind, slot, text)
    } catch (error: UnsatisfiedLinkError) {
      Log.w(TAG, "native library not loaded: ${error.message}")
    }
  }

  private fun emitTime(slot: Int, seconds: Double) {
    try {
      nativeOnVideoTime(slot, seconds)
    } catch (error: UnsatisfiedLinkError) {
      Log.w(TAG, "native library not loaded: ${error.message}")
    }
  }

  private fun emitDisplays(lines: String) {
    try {
      nativeOnDisplays(lines)
    } catch (error: UnsatisfiedLinkError) {
      Log.w(TAG, "native library not loaded: ${error.message}")
    }
  }

  @JvmStatic external fun nativeOnVideoTime(slot: Int, seconds: Double)

  @JvmStatic external fun nativeOnVideoEvent(kind: Int, slot: Int, text: String?)

  @JvmStatic external fun nativeOnDisplays(lines: String)
}
