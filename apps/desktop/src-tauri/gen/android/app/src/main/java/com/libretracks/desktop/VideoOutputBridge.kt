package com.libretracks.desktop

import android.app.Activity
import android.app.Presentation
import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Color
import android.hardware.display.DisplayManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Choreographer
import android.view.Display
import android.view.Gravity
import android.view.TextureView
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.ui.AspectRatioFrameLayout
import java.io.File
import java.lang.ref.WeakReference

/**
 * Video output for Android (plan video-mobile, pasos 05 and 06), driven from
 * Rust over JNI: src/platform/android_video.rs calls the @JvmStatic methods
 * below and receives the events through the `external fun`s at the bottom.
 *
 * What it draws: a [Presentation] on the external display (DisplayPort over
 * USB-C, or a simulated secondary display) with, bottom to top, player A,
 * player B, one image per slot (idle picture, test pattern) and a black view
 * whose alpha is the brightness. The phone keeps LibreTracks' UI.
 *
 * Threading: ExoPlayer may only be touched from its looper, the main one. So
 * every entry point posts onto the main Handler and returns at once (README
 * regla 3); nothing here ever waits for a decoder.
 *
 * Players: Media3 with the audio track type disabled, so they never open an
 * AudioTrack that would compete with Oboe or the Dolby deep-buffer path. The
 * second player is optional: low-end SoCs may have one hardware video decoder
 * in all. If slot B's decoder fails to initialise, B is released and Rust is
 * told (SECOND_PLAYER = 0) and serves jumps with one player.
 *
 * Event kinds must match `video/native_events.rs::kind`. Rust looks this
 * object up by name (proguard-rules.pro keeps it).
 */
@OptIn(UnstableApi::class)
object VideoOutputBridge {
  private const val TAG = "LTVideo"

  private const val FILE_LOADED = 0
  private const val PLAYBACK_RESTART = 1
  private const val LOAD_FAILED = 2
  private const val FRAME_DROPS = 3
  private const val SECOND_PLAYER = 5
  private const val SUSPENDED = 6
  private const val RESUMED = 7
  private const val SURFACE_FAILED = 8

  private val main = Handler(Looper.getMainLooper())

  @Volatile private var activityRef: WeakReference<Activity>? = null
  private var displayManager: DisplayManager? = null
  private var listening = false

  private var presentation: OutputPresentation? = null
  private var displayName: String? = null
  private val slots = arrayOf(SlotState(0), SlotState(1))
  private var visibleSlot = 0
  private var brightness = 0.0
  private var resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
  private var secondPlayerFailed = false
  private var appVisible = true
  private var suspended = false
  private var keepAwake = false
  private var keepAwakeBefore = false

  private class SlotState(val index: Int) {
    var player: ExoPlayer? = null
    var path: String? = null
    var paused = true
    var speed = 1.0f
    var loadPending = false
    var droppedFrames = 0L
  }

  // ── Activity lifecycle (MainActivity) ──────────────────────────────────

  @JvmStatic
  fun attach(activity: Activity) {
    activityRef = WeakReference(activity)
  }

  @JvmStatic
  fun detach(activity: Activity) {
    if (activityRef?.get() === activity) {
      tearDown()
      displayManager?.unregisterDisplayListener(displayListener)
      listening = false
      activityRef = null
    }
  }

  /**
   * onStart / onStop. With the phone's screen off the Activity stops and the
   * Presentation is hidden with it (00-DISENO §3): say so, and show it again
   * when the Activity is back. Rust resyncs on RESUMED.
   */
  @JvmStatic
  fun onActivityVisible(visible: Boolean) {
    appVisible = visible
    val shown = presentation ?: return
    if (!visible) {
      main.postDelayed({
        if (!appVisible && presentation === shown && !suspended && !shown.isShowing) {
          suspended = true
          emit(SUSPENDED, 0, null)
        }
      }, 300)
    } else {
      if (!shown.isShowing) {
        try {
          shown.show()
        } catch (error: WindowManager.InvalidDisplayException) {
          Log.w(TAG, "display gone while hidden: ${error.message}")
        }
      }
      if (suspended) {
        suspended = false
        emit(RESUMED, 0, null)
      }
    }
  }

  // ── Displays ────────────────────────────────────────────────────────────

  private val displayListener = object : DisplayManager.DisplayListener {
    override fun onDisplayAdded(displayId: Int) = reportDisplays()

    override fun onDisplayRemoved(displayId: Int) {
      if (presentation?.display?.displayId == displayId) tearDown()
      reportDisplays()
    }

    override fun onDisplayChanged(displayId: Int) = reportDisplays()
  }

  /** External presentation displays, never the phone's own (paso 06 §1). */
  private fun externalDisplays(): List<Pair<String, Display>> {
    val manager = displayManager ?: return emptyList()
    val seen = HashMap<String, Int>()
    return manager.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION)
      .filter { it.displayId != Display.DEFAULT_DISPLAY && it.isValid }
      .map { display ->
        var name = display.name?.takeIf { it.isNotBlank() } ?: "Pantalla externa"
        val count = (seen[name] ?: 0) + 1
        seen[name] = count
        if (count > 1) name = "$name $count"
        name to display
      }
  }

  private fun reportDisplays() {
    val lines = externalDisplays().joinToString("\n") { (name, display) ->
      val mode = display.mode
      val clean = name.replace('\t', ' ').replace('\n', ' ')
      "$clean\t${mode.physicalWidth}\t${mode.physicalHeight}"
    }
    try {
      nativeOnDisplays(lines)
    } catch (error: UnsatisfiedLinkError) {
      Log.w(TAG, "native library not loaded: ${error.message}")
    }
  }

  @JvmStatic
  fun start() {
    main.post {
      val activity = activityRef?.get() ?: return@post
      if (!listening) {
        val manager = activity.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        displayManager = manager
        manager.registerDisplayListener(displayListener, main)
        listening = true
      }
      reportDisplays()
    }
  }

  // ── Surface ─────────────────────────────────────────────────────────────

  private class OutputPresentation(context: Context, display: Display) :
    Presentation(context, display) {
    val frames = arrayOfNulls<AspectRatioFrameLayout>(2)
    val textures = arrayOfNulls<TextureView>(2)
    val images = arrayOfNulls<ImageView>(2)
    lateinit var black: View

    override fun onCreate(savedInstanceState: Bundle?) {
      super.onCreate(savedInstanceState)
      val root = FrameLayout(context)
      root.setBackgroundColor(Color.BLACK)
      val match = FrameLayout.LayoutParams.MATCH_PARENT
      for (slot in 0..1) {
        // TextureView, not SurfaceView: hiding a SurfaceView destroys its
        // surface and a paused player shows black until its next seek,
        // which is exactly the A/B swap. A TextureView keeps its last
        // frame under alpha 0.
        val frame = AspectRatioFrameLayout(context)
        val texture = TextureView(context)
        frame.addView(texture, FrameLayout.LayoutParams(match, match, Gravity.CENTER))
        root.addView(frame, FrameLayout.LayoutParams(match, match, Gravity.CENTER))
        frames[slot] = frame
        textures[slot] = texture
      }
      for (slot in 0..1) {
        val image = ImageView(context)
        image.setBackgroundColor(Color.BLACK)
        image.visibility = View.GONE
        root.addView(image, FrameLayout.LayoutParams(match, match))
        images[slot] = image
      }
      black = View(context)
      black.setBackgroundColor(Color.BLACK)
      black.alpha = 0f
      root.addView(black, FrameLayout.LayoutParams(match, match))
      setContentView(root)
    }
  }

  @JvmStatic
  fun open(display: String, fit: Int): Boolean {
    if (activityRef?.get() == null) return false
    main.post { openOnMain(display, fit) }
    return true
  }

  private fun openOnMain(display: String, fit: Int) {
    val activity = activityRef?.get()
    val target = externalDisplays().firstOrNull { it.first == display }?.second
    if (activity == null || target == null) {
      emit(SURFACE_FAILED, 0, "la pantalla $display ya no está conectada")
      return
    }
    if (presentation != null && displayName == display) return
    tearDown()
    resizeMode = resizeModeFor(fit)
    val created = OutputPresentation(activity, target)
    try {
      created.show()
    } catch (error: WindowManager.InvalidDisplayException) {
      emit(SURFACE_FAILED, 0, "Presentation: ${error.message}")
      return
    }
    presentation = created
    displayName = display
    secondPlayerFailed = false
    for (slot in slots) createPlayer(activity, slot)
    applyVisibility()
    applyBrightness()
    applyResizeMode()
    if (suspended) emit(SUSPENDED, 0, null)
  }

  private fun tearDown() {
    stopTicking()
    for (slot in slots) releasePlayer(slot)
    presentation?.let {
      try {
        it.dismiss()
      } catch (error: IllegalArgumentException) {
        // Already detached from its window manager.
      }
    }
    presentation = null
    displayName = null
  }

  @JvmStatic
  fun close() {
    main.post { tearDown() }
  }

  // ── Players ─────────────────────────────────────────────────────────────

  private fun createPlayer(context: Context, slot: SlotState) {
    if (slot.index == 1 && secondPlayerFailed) return
    val renderers = DefaultRenderersFactory(context).setEnableDecoderFallback(true)
    val player = ExoPlayer.Builder(context, renderers).build()
    player.trackSelectionParameters = player.trackSelectionParameters
      .buildUpon()
      .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, true)
      .build()
    player.volume = 0f
    player.setSeekParameters(SeekParameters.EXACT)
    player.repeatMode = Player.REPEAT_MODE_OFF
    player.setVideoTextureView(presentation?.textures?.get(slot.index))
    player.addListener(object : Player.Listener {
      override fun onPlaybackStateChanged(state: Int) {
        if (state == Player.STATE_READY && slot.loadPending) {
          slot.loadPending = false
          emit(FILE_LOADED, slot.index, null)
        }
      }

      override fun onRenderedFirstFrame() {
        emit(PLAYBACK_RESTART, slot.index, null)
      }

      override fun onVideoSizeChanged(videoSize: VideoSize) {
        if (videoSize.width > 0 && videoSize.height > 0) {
          presentation?.frames?.get(slot.index)?.setAspectRatio(
            videoSize.width * videoSize.pixelWidthHeightRatio / videoSize.height,
          )
        }
      }

      override fun onIsPlayingChanged(isPlaying: Boolean) = updateTicking()

      override fun onPlayerError(error: PlaybackException) {
        onPlayerFailed(slot, error)
      }
    })
    player.addAnalyticsListener(object : AnalyticsListener {
      override fun onDroppedVideoFrames(
        eventTime: AnalyticsListener.EventTime,
        droppedFrames: Int,
        elapsedMs: Long,
      ) {
        slot.droppedFrames += droppedFrames
        emit(FRAME_DROPS, slot.index, slot.droppedFrames.toString())
      }
    })
    slot.player = player
  }

  private fun isDecoderShortage(error: PlaybackException): Boolean =
    error.errorCode == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED ||
      error.errorCode == PlaybackException.ERROR_CODE_DECODING_RESOURCES_RECLAIMED

  private fun onPlayerFailed(slot: SlotState, error: PlaybackException) {
    val reason = "${error.errorCodeName}: ${error.message ?: ""}".trim()
    // Paso 05 §4: slot B cannot get a decoder while A holds one. Run with a
    // single player instead of reporting a broken file.
    if (slot.index == 1 && isDecoderShortage(error) && slots[0].player != null) {
      Log.w(TAG, "second player unavailable: $reason")
      secondPlayerFailed = true
      releasePlayer(slot)
      emit(SECOND_PLAYER, 0, reason)
      return
    }
    slot.path = null
    emit(LOAD_FAILED, slot.index, reason)
  }

  private fun releasePlayer(slot: SlotState) {
    slot.player?.release()
    slot.player = null
    slot.path = null
    slot.loadPending = false
    slot.paused = true
  }

  private fun uriFor(path: String): Uri =
    if (path.startsWith("content://") || path.startsWith("file://")) {
      Uri.parse(path)
    } else {
      Uri.fromFile(File(path))
    }

  @JvmStatic
  fun load(slot: Int, path: String, startSeconds: Double, paused: Boolean) {
    main.post {
      val state = slots[slot]
      val player = state.player ?: run {
        if (slot == 1 && secondPlayerFailed) emit(SECOND_PLAYER, 0, null)
        return@post
      }
      hideImage(slot)
      state.path = path
      state.paused = paused
      state.loadPending = true
      state.droppedFrames = 0
      player.setMediaItem(MediaItem.fromUri(uriFor(path)))
      player.prepare()
      player.seekTo((startSeconds.coerceAtLeast(0.0) * 1000).toLong())
      player.setPlaybackSpeed(state.speed)
      player.playWhenReady = !paused
      updateTicking()
    }
  }

  @JvmStatic
  fun seek(slot: Int, seconds: Double) {
    main.post {
      // Media3 keeps only the last pending seek by itself.
      slots[slot].player?.seekTo((seconds.coerceAtLeast(0.0) * 1000).toLong())
    }
  }

  @JvmStatic
  fun setPause(slot: Int, paused: Boolean) {
    main.post {
      val state = slots[slot]
      state.paused = paused
      state.player?.playWhenReady = !paused
      updateTicking()
    }
  }

  @JvmStatic
  fun setSpeed(slot: Int, speed: Double) {
    main.post {
      val state = slots[slot]
      state.speed = speed.toFloat()
      state.player?.setPlaybackSpeed(state.speed)
    }
  }

  @JvmStatic
  fun stop(slot: Int) {
    main.post {
      val state = slots[slot]
      state.player?.stop()
      state.player?.clearMediaItems()
      state.path = null
      state.paused = true
      updateTicking()
    }
  }

  @JvmStatic
  fun showSlot(slot: Int) {
    main.post {
      visibleSlot = slot
      applyVisibility()
    }
  }

  private fun applyVisibility() {
    val shown = presentation ?: return
    for (index in 0..1) {
      val visible = index == visibleSlot
      shown.frames[index]?.alpha = if (visible) 1f else 0f
      val image = shown.images[index] ?: continue
      image.visibility = if (visible && image.drawable != null) View.VISIBLE else View.GONE
    }
  }

  /** −100 → black, 0 → picture. Next frame, no animation. */
  @JvmStatic
  fun setBrightness(value: Double) {
    main.post {
      brightness = value
      applyBrightness()
    }
  }

  private fun applyBrightness() {
    presentation?.black?.alpha = (-brightness / 100.0).coerceIn(0.0, 1.0).toFloat()
  }

  private fun resizeModeFor(fit: Int): Int = when (fit) {
    1 -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
    2 -> AspectRatioFrameLayout.RESIZE_MODE_FILL
    else -> AspectRatioFrameLayout.RESIZE_MODE_FIT
  }

  @JvmStatic
  fun setFit(fit: Int) {
    main.post {
      resizeMode = resizeModeFor(fit)
      applyResizeMode()
    }
  }

  private fun applyResizeMode() {
    val shown = presentation ?: return
    for (index in 0..1) {
      shown.frames[index]?.resizeMode = resizeMode
      shown.images[index]?.scaleType = when (resizeMode) {
        AspectRatioFrameLayout.RESIZE_MODE_ZOOM -> ImageView.ScaleType.CENTER_CROP
        AspectRatioFrameLayout.RESIZE_MODE_FILL -> ImageView.ScaleType.FIT_XY
        else -> ImageView.ScaleType.FIT_CENTER
      }
    }
  }

  /** A still image on `slot` instead of its video, or black with null. */
  @JvmStatic
  fun showImage(slot: Int, path: String?) {
    main.post {
      val state = slots[slot]
      state.player?.stop()
      state.player?.clearMediaItems()
      state.path = null
      state.paused = true
      val image = presentation?.images?.get(slot) ?: return@post
      val bitmap = path?.let { BitmapFactory.decodeFile(it) }
      image.setImageBitmap(bitmap)
      if (bitmap == null) image.setImageDrawable(null)
      applyVisibility()
      updateTicking()
    }
  }

  private fun hideImage(slot: Int) {
    val image = presentation?.images?.get(slot) ?: return
    image.setImageDrawable(null)
    image.visibility = View.GONE
  }

  // ── Time reporting ──────────────────────────────────────────────────────

  private var ticking = false

  private val frameCallback = object : Choreographer.FrameCallback {
    override fun doFrame(frameTimeNanos: Long) {
      if (!ticking) return
      for (slot in slots) {
        val player = slot.player ?: continue
        if (!slot.paused && slot.path != null && player.playbackState == Player.STATE_READY) {
          emitTime(slot.index, player.currentPosition / 1000.0)
        }
      }
      Choreographer.getInstance().postFrameCallback(this)
    }
  }

  /** Only while a player runs: unregistered when everything is paused, so
   *  an idle output costs no frame callbacks (project_idle_power_android). */
  private fun updateTicking() {
    val running = presentation != null && slots.any { !it.paused && it.path != null }
    if (running && !ticking) {
      ticking = true
      Choreographer.getInstance().postFrameCallback(frameCallback)
    } else if (!running) {
      stopTicking()
    }
  }

  private fun stopTicking() {
    if (ticking) {
      ticking = false
      Choreographer.getInstance().removeFrameCallback(frameCallback)
    }
  }

  // ── Sleep ───────────────────────────────────────────────────────────────

  /** Paso 06 §4. MainActivity already keeps the screen on for the whole run;
   *  this restores whatever was there before, never clears it by accident. */
  @JvmStatic
  fun setKeepAwake(on: Boolean) {
    main.post {
      val window = activityRef?.get()?.window ?: return@post
      if (on == keepAwake) return@post
      keepAwake = on
      val flag = WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
      if (on) {
        keepAwakeBefore = (window.attributes.flags and flag) != 0
        window.addFlags(flag)
      } else if (!keepAwakeBefore) {
        window.clearFlags(flag)
      }
    }
  }

  // ── Events to Rust ──────────────────────────────────────────────────────

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

  @JvmStatic external fun nativeOnVideoTime(slot: Int, seconds: Double)

  @JvmStatic external fun nativeOnVideoEvent(kind: Int, slot: Int, text: String?)

  @JvmStatic external fun nativeOnDisplays(lines: String)
}
