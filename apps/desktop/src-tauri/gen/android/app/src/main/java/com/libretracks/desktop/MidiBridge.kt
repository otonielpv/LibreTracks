package com.libretracks.desktop

import android.content.Context
import android.content.pm.PackageManager
import android.media.midi.MidiDevice
import android.media.midi.MidiDeviceInfo
import android.media.midi.MidiInputPort
import android.media.midi.MidiManager
import android.media.midi.MidiOutputPort
import android.media.midi.MidiReceiver
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import java.io.Closeable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * MIDI transport for Android (`android.media.midi`), driven from Rust over JNI.
 * See `src/midi/transport/android.rs` and plan mobile-midi, paso 03.
 *
 * Android's naming is inverted from ours: a device's OUTPUT port is where WE
 * receive, and a device's INPUT port ([MidiInputPort]) is where WE send. In
 * this file "input" and "output" are always from LibreTracks' point of view.
 *
 * Every method catches everything and reports failure as `false` or an empty
 * list: an exception crossing back into Rust would poison the JNI thread.
 *
 * Rust looks this class up by name through the app class loader and calls
 * its methods by name and signature, so R8 must keep it (proguard-rules.pro).
 */
object MidiBridge {
  private const val TAG = "LTMidi"
  private const val OPEN_TIMEOUT_MS = 2000L

  /** `openDevice` answers on a Handler; never the main thread. */
  private val handler: Handler by lazy {
    val thread = HandlerThread("lt-midi-open")
    thread.start()
    Handler(thread.looper)
  }

  /** One open MidiDevice per device id, shared by its ports. */
  private class SharedDevice(val device: MidiDevice) {
    var users = 0
  }

  private val devices = HashMap<Int, SharedDevice>()

  private class OpenPort(val deviceId: Int, val port: Closeable, val receiver: MidiReceiver?)

  private val ports = ConcurrentHashMap<Long, OpenPort>()

  private fun manager(ctx: Context): MidiManager? =
    ctx.getSystemService(Context.MIDI_SERVICE) as? MidiManager

  @JvmStatic
  fun isAvailable(ctx: Context): Boolean =
    try {
      ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_MIDI) && manager(ctx) != null
    } catch (error: Throwable) {
      Log.w(TAG, "isAvailable: $error")
      false
    }

  private fun deviceInfos(manager: MidiManager): List<MidiDeviceInfo> =
    if (Build.VERSION.SDK_INT >= 33) {
      manager.getDevicesForTransport(MidiManager.TRANSPORT_MIDI_BYTE_STREAM).toList()
    } else {
      @Suppress("DEPRECATION")
      manager.devices.toList()
    }

  private fun deviceName(info: MidiDeviceInfo): String {
    val properties = info.properties
    val product = properties.getString(MidiDeviceInfo.PROPERTY_PRODUCT)
    if (!product.isNullOrBlank()) return product
    val name = properties.getString(MidiDeviceInfo.PROPERTY_NAME)
    if (!name.isNullOrBlank()) return name
    return "MIDI ${info.id}"
  }

  /**
   * Ports in one direction, one line per port:
   * `deviceId \t portIndex \t deviceName \t portName`. A flat string array is
   * far simpler to read from JNI than an array of objects. Tabs and newlines
   * in names are replaced with spaces so the format can't break.
   */
  @JvmStatic
  fun listPorts(ctx: Context, ourOutput: Boolean): Array<String> {
    return try {
      val manager = manager(ctx) ?: return emptyArray()
      val wanted =
        if (ourOutput) MidiDeviceInfo.PortInfo.TYPE_INPUT else MidiDeviceInfo.PortInfo.TYPE_OUTPUT
      val clean = { text: String? -> (text ?: "").replace('\t', ' ').replace('\n', ' ') }
      deviceInfos(manager)
        .sortedBy { it.id }
        .flatMap { info ->
          info.ports
            .filter { it.type == wanted }
            .map { port ->
              "${info.id}\t${port.portNumber}\t${clean(deviceName(info))}\t${clean(port.name)}"
            }
        }
        .toTypedArray()
    } catch (error: Throwable) {
      Log.w(TAG, "listPorts: $error")
      emptyArray()
    }
  }

  /** Opens (or reuses) the device, waiting at most [OPEN_TIMEOUT_MS]. */
  private fun acquireDevice(ctx: Context, deviceId: Int): MidiDevice? {
    synchronized(devices) {
      devices[deviceId]?.let {
        it.users += 1
        return it.device
      }
    }
    val manager = manager(ctx) ?: return null
    val info = deviceInfos(manager).firstOrNull { it.id == deviceId } ?: return null
    val opened = AtomicReference<MidiDevice?>(null)
    val latch = CountDownLatch(1)
    manager.openDevice(info, { device ->
      opened.set(device)
      latch.countDown()
    }, handler)
    if (!latch.await(OPEN_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
      Log.w(TAG, "openDevice($deviceId) timed out")
      return null
    }
    val device = opened.get() ?: return null
    synchronized(devices) {
      val existing = devices[deviceId]
      if (existing != null) {
        // Another thread won the race; keep theirs.
        existing.users += 1
        try {
          device.close()
        } catch (_: Throwable) {
        }
        return existing.device
      }
      devices[deviceId] = SharedDevice(device).also { it.users = 1 }
    }
    return device
  }

  private fun releaseDevice(deviceId: Int) {
    val toClose = synchronized(devices) {
      val shared = devices[deviceId] ?: return
      shared.users -= 1
      if (shared.users > 0) return
      devices.remove(deviceId)
      shared.device
    }
    try {
      toClose.close()
    } catch (error: Throwable) {
      Log.w(TAG, "close device $deviceId: $error")
    }
  }

  private class Forwarder(private val handle: Long) : MidiReceiver() {
    override fun onSend(msg: ByteArray, offset: Int, count: Int, timestamp: Long) {
      try {
        nativeOnMidiBytes(handle, msg, offset, count)
      } catch (error: UnsatisfiedLinkError) {
        // Native library not loaded (should not happen while a port is open).
      }
    }
  }

  /** Open the port where WE receive; bytes arrive through [nativeOnMidiBytes]. */
  @JvmStatic
  fun openInput(ctx: Context, deviceId: Int, portIndex: Int, handle: Long): Boolean =
    try {
      val device = acquireDevice(ctx, deviceId)
      if (device == null) {
        false
      } else {
        val port: MidiOutputPort? = device.openOutputPort(portIndex)
        if (port == null) {
          releaseDevice(deviceId)
          false
        } else {
          val forwarder = Forwarder(handle)
          port.connect(forwarder)
          ports[handle] = OpenPort(deviceId, port, forwarder)
          true
        }
      }
    } catch (error: Throwable) {
      Log.w(TAG, "openInput($deviceId, $portIndex): $error")
      false
    }

  /** Open the port where WE send. */
  @JvmStatic
  fun openOutput(ctx: Context, deviceId: Int, portIndex: Int, handle: Long): Boolean =
    try {
      val device = acquireDevice(ctx, deviceId)
      if (device == null) {
        false
      } else {
        val port: MidiInputPort? = device.openInputPort(portIndex)
        if (port == null) {
          releaseDevice(deviceId)
          false
        } else {
          ports[handle] = OpenPort(deviceId, port, null)
          true
        }
      }
    } catch (error: Throwable) {
      Log.w(TAG, "openOutput($deviceId, $portIndex): $error")
      false
    }

  @JvmStatic
  fun send(handle: Long, bytes: ByteArray, count: Int): Boolean {
    val port = ports[handle]?.port as? MidiInputPort ?: return false
    return try {
      port.send(bytes, 0, count)
      true
    } catch (error: Throwable) {
      // IOException once the cable is pulled: report, never crash.
      false
    }
  }

  @JvmStatic
  fun close(handle: Long) {
    val open = ports.remove(handle) ?: return
    try {
      if (open.port is MidiOutputPort && open.receiver != null) {
        open.port.disconnect(open.receiver)
      }
      open.port.close()
    } catch (error: Throwable) {
      Log.w(TAG, "close port: $error")
    }
    releaseDevice(open.deviceId)
  }

  @JvmStatic
  external fun nativeOnMidiBytes(handle: Long, data: ByteArray, offset: Int, count: Int)
}
