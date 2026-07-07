package com.libretracks.desktop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * Foreground media-playback service that keeps the process (and therefore the
 * native AAudio stream) alive when the activity is backgrounded or the screen
 * is turned off. Without it, Android freezes the cached process and playback
 * dies mid-song — unacceptable for a live-performance DAW.
 *
 * Runs for the whole app lifetime (started/stopped by MainActivity) rather
 * than tracking transport state: wiring play/stop through a Tauri mobile
 * plugin isn't worth the moving parts yet, and a persistent "running"
 * notification is normal for DAW/live apps.
 *
 * Audio focus: requested once so the system treats us as the active media app
 * (pausing Spotify & co. when we start). On focus LOSS we deliberately do
 * NOTHING — auto-pausing mid-performance because a notification chimed or a
 * call arrived would be far worse than letting the OS duck us.
 */
class AudioPlaybackService : Service() {

  private var focusRequest: AudioFocusRequest? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    requestAudioFocus()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    // The activity restarts us explicitly; if the system kills the service we
    // don't want a zombie notification with no engine behind it.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    abandonAudioFocus()
    super.onDestroy()
  }

  private fun buildNotification(): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        getString(R.string.app_name),
        // LOW: no sound/heads-up; it's a passive "engine is running" pin.
        NotificationManager.IMPORTANCE_LOW,
      )
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel)
    }

    val contentIntent = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE,
    )

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    return builder
      .setContentTitle(getString(R.string.app_name))
      .setContentText("Audio engine running")
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .build()
  }

  private fun requestAudioFocus() {
    val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val listener = AudioManager.OnAudioFocusChangeListener { change ->
      // Deliberately no pause/duck handling — see class comment.
      Log.i(TAG, "audio focus change: $change")
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
        .build()
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(attributes)
        .setOnAudioFocusChangeListener(listener)
        .build()
      focusRequest = request
      audioManager.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      audioManager.requestAudioFocus(
        listener,
        AudioManager.STREAM_MUSIC,
        AudioManager.AUDIOFOCUS_GAIN,
      )
    }
  }

  private fun abandonAudioFocus() {
    val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
      focusRequest = null
    }
  }

  companion object {
    private const val TAG = "LTAudioService"
    private const val CHANNEL_ID = "libretracks_playback"
    private const val NOTIFICATION_ID = 0x4C54 // "LT"
  }
}
