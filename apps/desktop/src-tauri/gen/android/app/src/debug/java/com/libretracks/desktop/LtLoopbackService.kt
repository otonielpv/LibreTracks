package com.libretracks.desktop

import android.media.midi.MidiDeviceService
import android.media.midi.MidiReceiver

/**
 * DEBUG ONLY. A virtual MIDI device "LT Loopback" with one input and one
 * output: whatever it receives on its input it sends back on its output.
 *
 * Lets the emulator run a full MIDI round trip without hardware: a MIDI track
 * sending to "LT Loopback" comes back as input and can fire a MIDI Learn
 * binding. Lives in the `debug` source set with its own manifest, so a release
 * build never contains it (plan mobile-midi, paso 03).
 */
class LtLoopbackService : MidiDeviceService() {
  private val echo = object : MidiReceiver() {
    override fun onSend(msg: ByteArray, offset: Int, count: Int, timestamp: Long) {
      outputPortReceivers.firstOrNull()?.send(msg, offset, count, timestamp)
    }
  }

  override fun onGetInputPortReceivers(): Array<MidiReceiver> = arrayOf(echo)
}
