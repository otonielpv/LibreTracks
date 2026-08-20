# 03 — Reaccionar a la presión de memoria de Android

**Depende de:** 02 (necesita `release_cached_blocks_under_pressure`).
**Toca:** `apps/desktop/src-tauri/gen/android/app/src/main/java/com/libretracks/desktop/MainActivity.kt`,
un comando/FFI nuevo en `apps/desktop/src-tauri/src/platform/`,
`native/audio-engine-v2/src/ffi/engine_impl.cpp`.
**Riesgo:** medio-alto. Toca `gen/android`, que Tauri regenera.

## Problema

Android **avisa antes de matar**. Manda `onTrimMemory(level)` con niveles
crecientes, y `TRIM_MEMORY_RUNNING_CRITICAL` significa literalmente «suelta
memoria ya o te mato». LibreTracks no implementa ningún callback: ignoramos el
aviso y seguimos llenando el block cache hasta que el LMK actúa. En el incidente
del 20-08 esa cascada se llevó ~40 procesos del sistema por delante.

## Cambio pedido

### 1. Cadena Kotlin → Rust → C++

`MainActivity.kt`:

```kotlin
override fun onTrimMemory(level: Int) {
    super.onTrimMemory(level)
    LibreTracksMemory.onTrimMemory(level)
}

override fun onLowMemory() {
    super.onLowMemory()
    LibreTracksMemory.onTrimMemory(TRIM_MEMORY_COMPLETE)
}
```

El puente puede ser un `external fun` JNI o, más simple y más en línea con el
repo, un `emit` al frontend que dispare un comando Tauri. **Elige la vía que
menos toque `gen/android`** — ver la nota sobre regeneración más abajo.

### 2. Política por nivel

| Nivel | Acción |
| --- | --- |
| `RUNNING_MODERATE` | Nada (solo telemetría) |
| `RUNNING_LOW` | Vaciar bloques no usados: `release_cached_blocks_under_pressure()` |
| `RUNNING_CRITICAL` | Vaciar + reducir el techo del caché a la mitad para esta sesión + **pausar la cola de preparación** |
| `UI_HIDDEN` / `BACKGROUND` / `COMPLETE` | Vaciar todo lo que no sea la pista sonando |

**Regla dura: nunca parar la reproducción en curso.** Si hay transporte
rodando, se libera caché pero no se toca la voz activa. Un usuario en directo
prefiere un glitch a que se pare la canción.

### 3. Pausa de la cola de preparación

Añadir al `PreparationQueue` (o al `SourceManager`) un `set_paused(bool)`. Bajo
`RUNNING_CRITICAL`, la preparación de fuentes que aún no se han pedido se
detiene; se reanuda cuando llega un `RUNNING_MODERATE` o tras 30 s sin nuevos
avisos.

### 4. Log

`[LT_MEMPRESSURE] level=CRITICAL freed=37MB queue=paused`

## Criterios de aceptación

- [ ] `onTrimMemory` llega hasta el engine: verificado en el dispositivo real
      provocando presión (abrir Chrome con varias pestañas mientras LibreTracks
      carga) y viendo `[LT_MEMPRESSURE]` en `adb logcat`.
- [ ] Bajo `RUNNING_CRITICAL` con transporte **parado**, `ram_bytes_used` del
      snapshot baja de forma medible (al menos un 50 % de lo cacheado).
- [ ] Bajo `RUNNING_CRITICAL` con transporte **en marcha**, la reproducción
      **continúa**. Test manual en el dispositivo: reproducir, provocar presión,
      comprobar que no hay corte ni parada.
- [ ] La cola de preparación se pausa y se reanuda; hay un test unitario del
      `set_paused` (encolar, pausar, comprobar que no progresa, reanudar,
      comprobar que termina).
- [ ] El cambio en `gen/android` está documentado en `docs/ANDROID_PORT.md` bajo
      un apartado «Modificaciones manuales en gen/android» con instrucciones de
      cómo reaplicarlo si Tauri regenera el proyecto.
- [ ] La app compila y arranca en el Oppo. `npm run test:native` pasa.

## Notas para el implementador

- **`gen/android` es código generado.** `npx tauri android init` lo sobrescribe.
  Antes de editar `MainActivity.kt`, comprueba si el repo ya tiene precedente de
  modificarlo (`AudioPlaybackService.kt` sugiere que sí) y sigue ese patrón.
  Si existe una vía para hacerlo desde un plugin Tauri sin tocar `gen/`,
  prefiérela y explica por qué en el PR.
- Cuidado con la trampa documentada en la memoria del proyecto: el código tras
  `#[cfg(target_os = "android")]` **no lo ve `cargo check` de escritorio**.
  Compila para Android antes de dar el paso por terminado.
