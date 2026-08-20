# 00 — Diagnóstico: apagado del Oppo CPH1931 al importar un `.ltset` de 2,1 GB

Documento de contexto compartido. **Todo agente (BUILDER o REVIEWER) debe leer
este fichero antes de tocar nada.** No contiene tareas; contiene los hechos
medidos que justifican cada paso del plan.

## Evidencia recogida (2026-08-20, dispositivo conectado por adb)

### Dispositivo

| Dato | Valor |
| --- | --- |
| Modelo | Oppo CPH1931 (A5 2020) |
| Android | 10 (API 29) |
| ABI | arm64-v8a |
| **RAM total** | **2 706 168 kB ≈ 2,58 GiB** |
| RAM libre en el momento de la captura | 55 MB (`MemAvailable` ≈ 1,0 GB) |
| Núcleos | 8 (Snapdragon 665, big.LITTLE — 4 A73 lentos + 4 A53) |
| `/data` | 47 GB, 37 GB usados, **10 GB libres (79 %)** |
| `dalvik.vm.heapsize` | 512m |
| `dalvik.vm.heapgrowthlimit` | 384m |

### El paquete

`WhatAGod-Reckless.ltset` = **2 172 357 899 bytes (2,02 GiB)**, 71 entradas:

- 24 WAV de ~76 MB cada uno (~1,8 GB) — 44,1 kHz estéreo.
- 12 MP3 de ~4-8 MB.
- ~30 sidecars `.ltpeaks` de ~1,4 MB.

Es decir: **el paquete comprimido pesa casi tanto como toda la RAM del
teléfono**, y descomprimido pesa lo mismo (el audio ya está sin comprimir).

### Lo que ocurrió, en orden

Reconstruido de `logcat -b all` (buffer aún vivo):

1. `08:47:10` — arranque de la app. `LaunchTime: 12483 ms` (12,5 s solo en abrir).
2. `08:47:49` → `08:48:33` — dos vueltas por el SAF picker (elegir `.ltset`,
   elegir destino). Encaja con `start_import_session_package_from_dialog`.
3. `08:48:33` en adelante — staging + extracción. Sin logs de progreso propios.
4. **`08:51:16` — `FATAL EXCEPTION: FinalizerWatchdogDaemon`**:

   ```
   java.util.concurrent.TimeoutException:
     android.content.ContentResolver$ParcelFileDescriptorInner.finalize() timed out after 10 seconds
       at android.os.BinderProxy.transactNative(Native Method)
       at android.app.IActivityManager$Stub$Proxy.refContentProvider(...)
       at android.app.ActivityThread.releaseProvider(ActivityThread.java:7206)
       at android.content.ContentResolver$ParcelFileDescriptorInner.releaseResources(...)
       at android.os.ParcelFileDescriptor.finalize(ParcelFileDescriptor.java:1018)
   ```

   En el mismo segundo: `SlowSQLite: /execute COMMIT;/ cost= 44043` (44 s para
   un COMMIT del sistema). El teléfono entero estaba en thrashing de I/O.

5. `08:51:01` — `F/libc: crash_dump helper failed to exec`: el sistema ni
   siquiera pudo generar el tombstone (no quedaba memoria para lanzar el helper).
   Por eso `/data/tombstones` está vacío.
6. `08:54:28` → `08:55:44` — **matanza masiva de LMK**: ~40 `am_kill` seguidos
   (gapps, maps, chrome, whatsapp, gearhead, keyboard, calendar, incluso
   `com.google.android.gms.unstable` y `packageinstaller`). Esa cascada es la
   firma de un reinicio del `system_server` por presión de memoria — lo que el
   usuario percibió como «el móvil se ha apagado».

### Interpretación

**No hubo apagado térmico ni de batería** (`OppoThermalService` reportaba
`mEnvironmentTempType:0`, temperatura ambiente normal). Fue **presión de memoria
y de I/O sostenida** hasta que el sistema se reinició.

El `TimeoutException` del finalizer es sintomático, no causal: el hilo
finalizador tenía 10 s para cerrar un `ParcelFileDescriptor` del SAF y no lo
consiguió porque **todos los hilos estaban compitiendo por I/O y CPU**. Android
mata el proceso cuando eso pasa.

## Causas raíz en NUESTRO código

### C1 — El `.ltset` se copia entero a staging antes de descomprimir

[`apps/desktop/src-tauri/src/commands/project.rs`](../../../apps/desktop/src-tauri/src/commands/project.rs)
llama a `stage_picked_file_to_temp` en la rama Android, que hace un
`std::io::copy` del `content://` a `app_cache_dir()/saf-staging/`.

Coste real en este caso: **2,02 GiB copiados a disco** solo para poder abrir el
zip con una ruta `std::fs`, seguidos de **2,02 GiB más** al extraer. Total
≈ 4 GB escritos, sobre 10 GB libres, en un eMMC de gama baja. Esto explica
íntegramente «ha tardado bastante en importarla, después bastante en
descomprimir».

El `ParcelFileDescriptor` del crash es precisamente el fd de esa copia SAF.

### C2 — Los presupuestos de memoria/hilos están calibrados para PC

[`native/audio-engine-v2/include/lt_engine/core/thread_policy.h`](../../../native/audio-engine-v2/include/lt_engine/core/thread_policy.h)
escala por RAM, pero su escalón más bajo es «≤ 4,5 GB → 2 hilos de decode». Un
móvil de 2,58 GB cae ahí y arranca **2 decodificadores concurrentes**.

[`native/audio-engine-v2/src/sources/source_manager.cpp:89`](../../../native/audio-engine-v2/src/sources/source_manager.cpp#L89)
(`source_cache_mb_for_ram`) devuelve **512 MB de block cache** para «≤ 8,5 GB».
En un teléfono con 2,58 GB totales y ~1 GB disponible, **512 MB de caché de
bloques es aproximadamente la mitad de toda la memoria libre del sistema**.

Ninguna de las dos funciones tiene rama `__ANDROID__`, y ambas usan
`lt_physical_ram_bytes()` (RAM *física*, no disponible), que en Android sobrestima
groseramente lo que la app puede usar: el límite real es el del `ActivityManager`
por proceso, no la RAM del aparato.

### C3 — El límite de caché en disco es 10 % del disco libre, mínimo 4 GiB

[`source_manager.cpp:329`](../../../native/audio-engine-v2/src/sources/source_manager.cpp#L329)
(`source_disk_cache_limit_bytes`): con 10 GB libres, el 10 % son 1 GB, que es
menor que el mínimo de 4 GiB, así que **se aplica el mínimo: 4 GiB de caché PCM
permitidos sobre 10 GB libres**. Sumado a los ~4 GB del staging + extracción, el
import puede dejar el teléfono sin espacio.

### C4 — No hay ninguna comprobación previa de viabilidad

Nada en el flujo mira el tamaño del `.ltset` frente al espacio libre o la RAM
del dispositivo. La app acepta felizmente un paquete de 2 GB en un teléfono de
2,58 GB de RAM y se lleva el sistema por delante. **No se avisa al usuario, no
se ofrece una alternativa, no se aborta.**

### C5 — Los WAV no se convierten nunca

24 WAV de 76 MB son 1,8 GB que, decodificados a float32, ocuparían el doble. En
móvil el formato razonable de almacenamiento es comprimido (el propio paquete
«Ligero» ya existe). Un `.ltset` «Completo» exportado desde el PC arrastra los
WAV originales a un dispositivo que no puede con ellos.

### C6 — La app no reacciona a `onTrimMemory` / `onLowMemory`

`MainActivity.kt` no implementa ningún callback de presión de memoria. Android
avisa (`TRIM_MEMORY_RUNNING_CRITICAL`) antes de matar, y nosotros ignoramos el
aviso en lugar de vaciar el block cache.

## Qué NO es el problema

- **No es el decoder.** La ruta Android ya usa MediaCodec para AAC/OGG/Opus
  (`mediacodec_decoder.cpp`) y dr_mp3/libsndfile para MP3/WAV. Correcto.
- **No es térmico ni de batería.** Descartado por logs.
- **No es el engine stub.** El engine real está enlazado (había actividad de
  preparación de audio).
- **No es un bug de corrección.** Todo el código hace lo que dice hacer; lo que
  falla es que los presupuestos asumen un PC.

## Principio rector del plan

> En un dispositivo modesto, la app debe **negarse a hacer lo imposible y
> explicar por qué**, antes que intentarlo y llevarse el sistema por delante.

Orden de prioridad de los pasos que siguen:

1. **No matar el teléfono** (pasos 01, 02, 03) — presupuestos y guardarraíles.
2. **No hacer trabajo innecesario** (pasos 04, 05) — streaming SAF, sin staging.
3. **Avisar y ofrecer salida** (pasos 06, 07) — preflight y import selectivo.
4. **Poder demostrarlo** (pasos 08, 09) — telemetría y banco de pruebas.
