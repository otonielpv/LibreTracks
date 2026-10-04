package com.libretracks.desktop

import android.Manifest
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Looper
import android.os.ParcelUuid
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import java.util.UUID
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
   * True for LibreTracks' own virtual device (paso 10). Rust drops those
   * lines: opening our own device through MidiManager would loop the app into
   * itself. Compared by service class, not by package, because the debug-only
   * loopback is in our package too and must stay listed.
   */
  private fun isOwnVirtualDevice(ctx: Context, info: MidiDeviceInfo): Boolean {
    if (info.type != MidiDeviceInfo.TYPE_VIRTUAL) return false
    // The framework puts the providing service under "service_info"; the key
    // is not public API, so fall back to the names in lt_virtual_midi.xml.
    @Suppress("DEPRECATION")
    val service = info.properties.getParcelable<ServiceInfo>("service_info")
    if (service != null) {
      return service.packageName == ctx.packageName &&
        service.name == LtVirtualMidiService::class.java.name
    }
    val properties = info.properties
    return properties.getString(MidiDeviceInfo.PROPERTY_MANUFACTURER) == "LibreTracks" &&
      properties.getString(MidiDeviceInfo.PROPERTY_PRODUCT) == "LibreTracks"
  }

  /**
   * Ports in one direction, one line per port:
   * `deviceId \t portIndex \t deviceName \t portName \t own` (`own` is `1` for
   * our own virtual device). A flat string array is far simpler to read from
   * JNI than an array of objects. Tabs and newlines in names are replaced with
   * spaces so the format can't break.
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
              val own = if (isOwnVirtualDevice(ctx, info)) "1" else "0"
              "${info.id}\t${port.portNumber}\t${clean(deviceName(info))}\t${clean(port.name)}\t$own"
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

  private var deviceCallback: MidiManager.DeviceCallback? = null

  /**
   * Hot-plug (paso 04): tell Rust whenever a MIDI device appears or goes away,
   * so a pulled OTG cable reconnects by itself. Rust re-lists and reopens off
   * this thread (reopening here would wait on our own Handler).
   */
  @JvmStatic
  fun registerDeviceCallback(ctx: Context): Boolean {
    return try {
      val manager = manager(ctx) ?: return false
      synchronized(this) {
        if (deviceCallback == null) {
          val callback = object : MidiManager.DeviceCallback() {
            override fun onDeviceAdded(device: MidiDeviceInfo) = notifyChanged()

            override fun onDeviceRemoved(device: MidiDeviceInfo) = notifyChanged()
          }
          @Suppress("DEPRECATION")
          manager.registerDeviceCallback(callback, handler)
          deviceCallback = callback
        }
      }
      true
    } catch (error: Throwable) {
      Log.w(TAG, "registerDeviceCallback: $error")
      false
    }
  }

  private fun notifyChanged() {
    try {
      nativeOnDevicesChanged()
    } catch (error: UnsatisfiedLinkError) {
      // Native library not loaded yet; the next change will try again.
    }
  }

  // ── Bluetooth LE MIDI (paso 06) ─────────────────────────────────────────
  //
  // Unlike iOS, Android only publishes a BLE MIDI device while some app holds
  // it open through openBluetoothDevice. We hold it here (bleDevices) for as
  // long as the app runs; from then on it is an ordinary entry in
  // getDevices() and the USB code path (openInput/openOutput) just works.

  private const val BLE_OPEN_TIMEOUT_MS = 10_000L
  private const val PERMISSION_TIMEOUT_MS = 120_000L
  private val MIDI_SERVICE_UUID: UUID = UUID.fromString("03B80E5A-EDE8-4B33-A751-6CE34EC4C700")
  private val bleDevices = ConcurrentHashMap<String, MidiDevice>()
  private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

  @JvmStatic
  fun hasBluetoothLe(ctx: Context): Boolean =
    try {
      ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)
    } catch (error: Throwable) {
      false
    }

  private fun blePermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= 31) {
      arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else {
      arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

  private fun hasBlePermissions(ctx: Context): Boolean =
    blePermissions().all {
      ContextCompat.checkSelfPermission(ctx, it) == PackageManager.PERMISSION_GRANTED
    }

  /**
   * Ask for the BLE permissions if needed, only when the user pressed the
   * Bluetooth button (never at startup). Blocks the calling (Rust) thread
   * until the user answers. 1 = granted, 0 = denied, -1 = could not ask.
   */
  @JvmStatic
  fun ensureBluetoothPermissions(ctx: Context): Int {
    if (hasBlePermissions(ctx)) return 1
    val activity = ctx as? ComponentActivity ?: return -1
    val granted = AtomicReference<Boolean?>(null)
    val latch = CountDownLatch(1)
    mainHandler.post {
      try {
        var launcher: ActivityResultLauncher<Array<String>>? = null
        launcher =
          activity.activityResultRegistry.register(
            "lt-ble-midi-permissions",
            ActivityResultContracts.RequestMultiplePermissions(),
          ) { result ->
            granted.set(result.values.all { it })
            launcher?.unregister()
            latch.countDown()
          }
        launcher.launch(blePermissions())
      } catch (error: Throwable) {
        Log.w(TAG, "ensureBluetoothPermissions: $error")
        latch.countDown()
      }
    }
    if (!latch.await(PERMISSION_TIMEOUT_MS, TimeUnit.MILLISECONDS)) return -1
    return when (granted.get()) {
      true -> 1
      false -> 0
      null -> -1
    }
  }

  /**
   * Scan for BLE MIDI devices (filtered by the MIDI service UUID) for
   * [timeoutMs]. One line per device: `address \t name`. Empty on any error;
   * `null` when Bluetooth is switched off, so the UI can say so.
   */
  @JvmStatic
  fun scanBle(ctx: Context, timeoutMs: Int): Array<String>? {
    return try {
      val adapter =
        (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
          ?: return emptyArray()
      if (!adapter.isEnabled) return null
      val scanner = adapter.bluetoothLeScanner ?: return null
      val found = LinkedHashMap<String, String>()
      val callback =
        object : ScanCallback() {
          override fun onScanResult(callbackType: Int, result: ScanResult) {
            val address = result.device.address ?: return
            val name =
              result.scanRecord?.deviceName
                ?: try {
                  result.device.name
                } catch (error: SecurityException) {
                  null
                }
                ?: address
            synchronized(found) { found[address] = name.replace('\t', ' ') }
          }
        }
      val filters =
        listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(MIDI_SERVICE_UUID)).build())
      val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
      scanner.startScan(filters, settings, callback)
      Thread.sleep(timeoutMs.toLong())
      scanner.stopScan(callback)
      synchronized(found) { found.map { (address, name) -> "$address\t$name" }.toTypedArray() }
    } catch (error: Throwable) {
      Log.w(TAG, "scanBle: $error")
      emptyArray()
    }
  }

  /** Connect to a BLE MIDI device and keep it open. Blocks up to 10 s. */
  @JvmStatic
  fun openBluetooth(ctx: Context, address: String): Boolean {
    if (bleDevices.containsKey(address)) return true
    return try {
      val manager = manager(ctx) ?: return false
      val adapter =
        (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
          ?: return false
      if (!adapter.isEnabled || !hasBlePermissions(ctx)) return false
      val device = adapter.getRemoteDevice(address)
      val opened = AtomicReference<MidiDevice?>(null)
      val latch = CountDownLatch(1)
      manager.openBluetoothDevice(device, { midiDevice ->
        opened.set(midiDevice)
        latch.countDown()
      }, handler)
      if (!latch.await(BLE_OPEN_TIMEOUT_MS, TimeUnit.MILLISECONDS)) return false
      val midiDevice = opened.get() ?: return false
      bleDevices[address] = midiDevice
      true
    } catch (error: Throwable) {
      Log.w(TAG, "openBluetooth($address): $error")
      false
    }
  }

  // ── Virtual port "LibreTracks In"/"LibreTracks Out" (paso 10) ──────────

  /** The running [LtVirtualMidiService], while another app has it open. */
  @Volatile
  var virtualService: LtVirtualMidiService? = null

  /** Rust's handle for "LibreTracks In"; 0 = nothing attached, drop bytes. */
  @Volatile
  private var virtualInputHandle: Long = 0

  /** Turn the virtual device on or off for other apps. */
  @JvmStatic
  fun setVirtualPortEnabled(ctx: Context, enabled: Boolean): Boolean {
    return try {
      val state =
        if (enabled) {
          PackageManager.COMPONENT_ENABLED_STATE_ENABLED
        } else {
          PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        }
      ctx.packageManager.setComponentEnabledSetting(
        ComponentName(ctx, LtVirtualMidiService::class.java),
        state,
        PackageManager.DONT_KILL_APP,
      )
      true
    } catch (error: Throwable) {
      Log.w(TAG, "setVirtualPortEnabled($enabled): $error")
      false
    }
  }

  @JvmStatic
  fun attachVirtualInput(handle: Long) {
    virtualInputHandle = handle
  }

  @JvmStatic
  fun detachVirtualInput(handle: Long) {
    if (virtualInputHandle == handle) {
      virtualInputHandle = 0
    }
  }

  /** From [LtVirtualMidiService]: another app sent to "LibreTracks In". */
  fun onVirtualInput(msg: ByteArray, offset: Int, count: Int) {
    val handle = virtualInputHandle
    if (handle == 0L) return
    try {
      nativeOnMidiBytes(handle, msg, offset, count)
    } catch (error: UnsatisfiedLinkError) {
      // Started by another app before LibreTracks loaded its library.
    }
  }

  /** Send on "LibreTracks Out". No connected app = nothing to do. */
  @JvmStatic
  fun sendVirtual(bytes: ByteArray, count: Int): Boolean {
    return try {
      virtualService?.sendToOtherApps(bytes, count)
      true
    } catch (error: Throwable) {
      false
    }
  }

  @JvmStatic
  external fun nativeOnMidiBytes(handle: Long, data: ByteArray, offset: Int, count: Int)

  @JvmStatic
  external fun nativeOnDevicesChanged()
}
