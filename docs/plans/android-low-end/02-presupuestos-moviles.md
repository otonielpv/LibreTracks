# 02 — Aplicar el perfil: caché, hilos y límite de disco en móvil

**Depende de:** 01.
**Toca:** `native/audio-engine-v2/src/sources/source_manager.cpp`,
`native/audio-engine-v2/include/lt_engine/core/thread_policy.h`.
**Riesgo:** medio. Cambia números que afectan al rendimiento de reproducción.

## Problema

Tres presupuestos, medidos en el código actual, aplicados tal cual a un móvil de
2,58 GB:

| Presupuesto | Valor actual en el Oppo | Por qué es absurdo |
| --- | --- | --- |
| `source_cache_mb_for_ram()` | **512 MB** | ~50 % de la RAM disponible del sistema |
| `lt_recommend_worker_threads(Decode)` | **2 hilos** | 2 decodificadores × buffer de decode + copia de resample |
| `source_disk_cache_limit_bytes()` | **4 GiB** (el mínimo) | Sobre 10 GB libres, con 4 GB ya gastados en staging+extracción |

## Cambio pedido

### 1. `source_cache_mb_for_ram()` → consulta el perfil

```
Constrained → 48 MB
Handheld    → 96 MB
resto       → los valores actuales (512 / 1024 / 2048 / 3072)
```

Justificación de 48 MB: con bloques de `kDefaultBlockFrames` estéreo float32,
48 MB dan un working set holgado para ~8-12 pistas reproduciéndose desde disco,
que es lo máximo realista en este hardware. El objetivo del block cache es
absorber el jitter de I/O, no tener la canción en RAM.

### 2. Hilos en móvil

```
Constrained → decode: 1, fill: 1
Handheld    → decode: 2, fill: 2
resto       → los actuales
```

Razón para 1 en `Constrained`: los 8 núcleos del Snapdragon 665 son 4 A73 + 4
A53; con 2 decodificadores concurrentes, cada uno con su buffer, el pico de RSS
se duplica sin ganar throughput real (el cuello es el eMMC, no la CPU). Ver
`project_decode_workers_not_the_bottleneck` — bajar hilos no reduce fallos de
página cuando el cuello es la escritura, pero **sí reduce el pico de RSS**, que
es lo que dispara al LMK.

### 3. Límite de caché en disco

El mínimo de 4 GiB debe desaparecer en móvil:

```
Handheld/Constrained → min(10% del disco libre, 512 MB)
resto                → comportamiento actual (10 %, mínimo 4 GiB)
```

Además, **nunca** dejar el disco por debajo de 1 GB libre: si
`free_disk_bytes` < 1 GB, el límite es 0 (sin caché nueva; se sirve desde el
fichero original).

### 4. Vaciado bajo presión

Añadir al `SourceManager` un método público:

```cpp
// Suelta todos los bloques cacheados que no estén en uso por el hilo de audio.
// Seguro de llamar desde cualquier hilo. Devuelve bytes liberados.
std::size_t SourceManager::release_cached_blocks_under_pressure();
```

Este método lo consumirá el paso 03 desde `onTrimMemory`. No debe tocar
`retired_entries_` de forma que invalide punteros prestados al hilo de audio —
reutiliza la disciplina ya existente en `publish_locked`.

## Criterios de aceptación

- [ ] Con el perfil forzado a `Constrained`, `source_cache_mb_for_ram()`
      devuelve 48 y el `BlockCache` se construye con el número de bloques
      correspondiente. Test unitario.
- [ ] Con perfil de escritorio (4/8/16/32 GB), los tres presupuestos devuelven
      **exactamente los valores actuales**. Test parametrizado que lo fija.
- [ ] `LIBRETRACKS_SOURCE_CACHE_MB`, `LIBRETRACKS_FILL_THREADS` y
      `LIBRETRACKS_SOURCE_DISK_CACHE_MB` siguen ganando al perfil. Test.
- [ ] Con menos de 1 GB de disco libre, `source_disk_cache_limit_bytes()`
      devuelve 0. Test con un directorio simulado o inyectando `free_bytes`.
- [ ] `release_cached_blocks_under_pressure()` existe, devuelve el número de
      bytes liberados y **no rompe una reproducción en curso**: test que
      reproduce, llama al método, y verifica que el render siguiente no produce
      silencio ni lee memoria liberada (ejecutar bajo ASAN si está disponible).
- [ ] En el Oppo, tras el cambio, `[LT_THREADS]` reporta `1 worker(s)` y el
      snapshot de `ram_bytes_used` se mantiene **por debajo de 64 MB** durante
      una carga completa. Verificado con `adb logcat`.
- [ ] Reproducción de 8 pistas en el Oppo sin cortes audibles durante 60 s.
      **Este es el criterio que puede obligar a subir los 48 MB** — si hay
      starvation, sube a 64 y vuelve a medir, documentando el número final.
- [ ] `npm run test:native` pasa.

## Notas para el implementador

- Los valores 48/96 MB son un **punto de partida medido a ojo**, no dogma. El
  criterio real es el de reproducción sin cortes con el `ram_bytes_used` más
  bajo posible. Si tienes que cambiarlos, cambia también este documento.
- Busca `[LT_STARVATION]` en los logs: si aparece durante la prueba de 8 pistas,
  el caché es demasiado pequeño.
