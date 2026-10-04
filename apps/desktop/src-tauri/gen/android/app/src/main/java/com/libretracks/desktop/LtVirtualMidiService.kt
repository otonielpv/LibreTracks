package com.libretracks.desktop

import android.media.midi.MidiDeviceService
import android.media.midi.MidiReceiver

/**
 * LibreTracks as a MIDI device for other apps on the same phone (plan
 * mobile-midi, paso 10): a synth or a lyrics app connects to "LibreTracks Out"
 * to receive what LibreTracks' MIDI tracks send, and to "LibreTracks In" to
 * fire MIDI Learn bindings. Same names as the iOS virtual ports (paso 07).
 *
 * The system starts this service when another app opens the device, even if
 * LibreTracks is not in the foreground. Everything goes through [MidiBridge],
 * which drops bytes while Rust has nothing attached, so an early start never
 * crashes.
 *
 * Disabled in the manifest; [MidiBridge.setVirtualPortEnabled] turns the
 * component on and off with the "Publish LibreTracks virtual MIDI port" setting,
 * so other apps see no LibreTracks device while it is off.
 *
 * Not the same thing as the debug-only `LtLoopbackService`: different class,
 * different device name, and only this one is in the release manifest.
 */
class LtVirtualMidiService : MidiDeviceService() {
  private val fromOtherApps = object : MidiReceiver() {
    override fun onSend(msg: ByteArray, offset: Int, count: Int, timestamp: Long) {
      MidiBridge.onVirtualInput(msg, offset, count)
    }
  }

  override fun onCreate() {
    super.onCreate()
    MidiBridge.virtualService = this
  }

  override fun onDestroy() {
    if (MidiBridge.virtualService === this) {
      MidiBridge.virtualService = null
    }
    super.onDestroy()
  }

  override fun onGetInputPortReceivers(): Array<MidiReceiver> = arrayOf(fromOtherApps)

  /** Send to whatever apps are connected to "LibreTracks Out". */
  fun sendToOtherApps(bytes: ByteArray, count: Int) {
    outputPortReceivers.firstOrNull()?.send(bytes, 0, count)
  }
}
