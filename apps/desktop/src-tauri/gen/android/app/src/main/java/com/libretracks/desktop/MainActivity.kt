package com.libretracks.desktop

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    hideSystemBars()

    // The show must go on: never let the device sleep mid-performance while
    // LibreTracks is in the foreground.
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

    // Foreground media service + audio focus so playback survives the screen
    // turning off or the user switching apps. Lives for the whole app run;
    // see AudioPlaybackService for the rationale.
    ContextCompat.startForegroundService(
      this,
      Intent(this, AudioPlaybackService::class.java),
    )

    installBundledAssets()
    registerStorageVolumeReceiver()
  }

  // ── Volumenes que aparecen y desaparecen ─────────────────────────────────
  //
  // Una microSD que se inserta o un pendrive por OTG que se enchufa (o se
  // quitan) con la app abierta. Sin esto, Ajustes y "Tus sesiones" seguian
  // con la lista del arranque hasta que el usuario volvia a entrar. Son
  // broadcasts del sistema que cualquier app recibe sin pedir permiso.
  //
  // Registrado en la Activity y no en el manifiesto: desde Android 8 los
  // broadcasts implicitos no despiertan receptores del manifiesto, y solo
  // interesa mientras la app esta abierta.
  private var storageVolumeReceiver: BroadcastReceiver? = null

  private fun registerStorageVolumeReceiver() {
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        Log.i("LTStorage", "volumen: ${intent.action} ${intent.data}")
        try {
          nativeOnStorageVolumesChanged()
        } catch (error: UnsatisfiedLinkError) {
          Log.w("LTStorage", "libreria nativa no cargada: ${error.message}")
        }
      }
    }
    val filter = IntentFilter().apply {
      addAction(Intent.ACTION_MEDIA_MOUNTED)
      addAction(Intent.ACTION_MEDIA_UNMOUNTED)
      addAction(Intent.ACTION_MEDIA_REMOVED)
      addAction(Intent.ACTION_MEDIA_BAD_REMOVAL)
      addAction(Intent.ACTION_MEDIA_EJECT)
      // Estos broadcasts llevan la ruta del volumen como dato `file://`: sin
      // declarar el esquema, el filtro no los deja pasar.
      addDataScheme("file")
    }
    registerReceiver(receiver, filter)
    storageVolumeReceiver = receiver
  }

  private external fun nativeOnStorageVolumesChanged()

  // Android warns before it kills. Ignoring that warning is how importing a
  // 2 GB .ltset ended with the system killing ~40 other processes and
  // restarting system_server; see docs/plans/android-low-end/.
  //
  // Straight to native rather than through the WebView: under real pressure the
  // WebView process is itself a kill candidate, so a warning that has to travel
  // through it is a warning we may never receive. The native side keeps each
  // playing source's read-ahead window, so this never silences a performance.
  override fun onTrimMemory(level: Int) {
    super.onTrimMemory(level)
    notifyNativeMemoryPressure(level)
  }

  override fun onLowMemory() {
    super.onLowMemory()
    notifyNativeMemoryPressure(TRIM_MEMORY_COMPLETE)
  }

  private fun notifyNativeMemoryPressure(level: Int) {
    try {
      val freed = nativeOnTrimMemory(level)
      Log.i("LTMemory", "onTrimMemory(level=$level) released $freed bytes")
    } catch (error: UnsatisfiedLinkError) {
      // The Rust library may not be loaded yet (very early in startup) — there
      // is nothing cached to release in that case anyway.
      Log.w("LTMemory", "memory pressure before the native library: ${error.message}")
    }
  }

  // Whether the transport is running is decided on the native side, which owns
  // the answer; asking Kotlin would mean keeping a second copy of that state in
  // sync for no benefit.
  private external fun nativeOnTrimMemory(level: Int): Long

  // Bundled asset folders ship inside the APK (assets/<name>/), but the native
  // decoder needs fopen-able paths and Tauri's resource bundler doesn't ship
  // `resources` on Android. Copy each one to filesDir/<name> when the install
  // changes so the Rust side can point at a real directory.
  //
  //   voices - the voice-guide WAV bank (~33 MB)
  //   demo   - the bundled demo set: session document + recorded stems (~7 MB),
  //            which is what makes a first run, and an App Store review, show
  //            something instead of an empty timeline.
  //
  // Keyed by lastUpdateTime (not versionCode) so re-installing a build that
  // changed an asset without bumping the version still refreshes it. Runs off
  // the UI thread.
  private fun installBundledAssets() {
    Thread {
      val version = try {
        packageManager.getPackageInfo(packageName, 0).lastUpdateTime.toString()
      } catch (e: Exception) {
        Log.e("LTAssets", "could not read the install stamp", e)
        return@Thread
      }
      // Independent per folder on purpose: a failure copying the 33 MB voice
      // bank must not cost the user the 7 MB demo, or the other way round.
      for (name in listOf("voices", "demo")) {
        try {
          val dest = File(filesDir, name)
          val stamp = File(filesDir, "$name/.version")
          if (dest.isDirectory && stamp.isFile && stamp.readText() == version) {
            continue
          }
          dest.deleteRecursively()
          copyAssetDir(name, dest)
          stamp.writeText(version)
          Log.i("LTAssets", "$name assets installed to ${dest.absolutePath}")
        } catch (e: Exception) {
          Log.e("LTAssets", "failed to install $name assets", e)
        }
      }
    }.start()
  }

  private fun copyAssetDir(assetPath: String, destDir: File) {
    val entries = assets.list(assetPath) ?: emptyArray()
    if (entries.isEmpty()) {
      // A leaf (file): copy its bytes.
      destDir.parentFile?.mkdirs()
      assets.open(assetPath).use { input ->
        destDir.outputStream().use { output -> input.copyTo(output) }
      }
      return
    }
    destDir.mkdirs()
    for (entry in entries) {
      copyAssetDir("$assetPath/$entry", File(destDir, entry))
    }
  }

  // ── Selector de audio con permiso PERSISTIBLE ────────────────────────────
  //
  // Por que no vale el de tauri-plugin-dialog: abre con ACTION_GET_CONTENT
  // (lo dice su propio fuente, con un "TODO: ACTION_OPEN_DOCUMENT ??" al
  // lado). Un URI de GET_CONTENT lleva un permiso TEMPORAL atado a la tarea:
  // `takePersistableUriPermission` sobre el lanza SecurityException, y al
  // reiniciar el proceso la app deja de poder leer el fichero.
  //
  // Para importar POR REFERENCIA hace falta lo contrario: un permiso que
  // sobreviva al reinicio del telefono. Eso es ACTION_OPEN_DOCUMENT con
  // FLAG_GRANT_PERSISTABLE_URI_PERMISSION, y despues tomarlo de verdad. Es el
  // equivalente exacto de los marcadores de seguridad que ya hace iOS en
  // IosFolderPickerPlugin.swift (`retainAccess` / `restoreBookmarks`).
  //
  // Vive en MainActivity y no en un plugin de Tauri porque el resultado llega
  // por onActivityResult, que es de la Activity, y porque el repo ya tiene el
  // camino Kotlin -> Rust montado (ver nativeOnTrimMemory).
  fun pickPersistableAudioDocuments() {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      // SAF filtra por MIME y los proveedores publican audio con tipos que una
      // lista nuestra no acertaria; se acepta todo y valida el importador.
      type = "*/*"
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
      addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or
          Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
      )
    }
    try {
      startActivityForResult(intent, REQUEST_PICK_PERSISTABLE_AUDIO)
    } catch (error: Exception) {
      Log.e("LTPick", "no se pudo abrir el selector", error)
      deliverPickedDocuments(emptyArray())
    }
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQUEST_PICK_PERSISTABLE_AUDIO) {
      super.onActivityResult(requestCode, resultCode, data)
      return
    }
    val uris = mutableListOf<Uri>()
    data?.clipData?.let { clip ->
      for (index in 0 until clip.itemCount) uris.add(clip.getItemAt(index).uri)
    }
    if (uris.isEmpty()) data?.data?.let { uris.add(it) }

    val taken = mutableListOf<String>()
    for (uri in uris) {
      // ESTA es la linea que hace que la referencia sobreviva al reinicio. Si
      // falla, el URI no sirve para referenciar y es mejor no devolverlo: el
      // llamante cae al camino de copia de siempre en vez de crear una sesion
      // que dejara de sonar manana.
      try {
        contentResolver.takePersistableUriPermission(
          uri,
          Intent.FLAG_GRANT_READ_URI_PERMISSION
        )
        taken.add(uri.toString())
      } catch (error: SecurityException) {
        Log.w("LTPick", "sin permiso persistible para $uri: ${error.message}")
      }
    }
    deliverPickedDocuments(taken.toTypedArray())
  }

  /** Devuelve el resultado al lado Rust, que espera en un canal. */
  private fun deliverPickedDocuments(uris: Array<String>) {
    try {
      nativeOnAudioDocumentsPicked(uris)
    } catch (error: UnsatisfiedLinkError) {
      Log.e("LTPick", "libreria nativa no cargada", error)
    }
  }

  private external fun nativeOnAudioDocumentsPicked(uris: Array<String>)

  override fun onDestroy() {
    storageVolumeReceiver?.let { receiver ->
      try {
        unregisterReceiver(receiver)
      } catch (error: IllegalArgumentException) {
        // Ya no estaba registrado; nada que soltar.
      }
    }
    storageVolumeReceiver = null
    stopService(Intent(this, AudioPlaybackService::class.java))
    super.onDestroy()
  }

  // Some OEM skins (ColorOS on the Oppo A5 test device) drop the immersive
  // state whenever the window regains focus — after the transient bars, a
  // notification shade pull, or app switching — leaving the status bar
  // permanently drawn OVER the app's top controls and stealing their taps.
  // Re-asserting on every focus gain is the documented pattern.
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) {
      hideSystemBars()
    }
  }

  // Immersive fullscreen: with edge-to-edge the WebView draws under the
  // status bar, whose overlay also STEALS the touches in that strip — the
  // app's top bar (transport buttons) sat exactly there and was untappable.
  // A live-performance DAW wants the whole screen anyway, so hide the system
  // bars; swipe from the edge reveals them transiently.
  private fun hideSystemBars() {
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    controller.hide(WindowInsetsCompat.Type.systemBars())
  }

  companion object {
    private const val REQUEST_PICK_PERSISTABLE_AUDIO = 0x4C54
  }
}
