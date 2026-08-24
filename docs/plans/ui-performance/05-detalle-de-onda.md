# 05 — Detalle real de la waveform a mucho zoom (picos por ventana)

**Depende de:** 04 (el consumidor es el tile; hacerlo antes duplicaría trabajo).
**Toca:** `native/audio-engine-v2/src/sources/source_manager.cpp`,
`native/audio-engine-v2/src/ffi/*`, `crates/lt-audio-engine-v2/src/lib.rs`,
`apps/desktop/src-tauri/src/commands/`, `Renderer/WaveformTileCache.ts`.
**Riesgo:** medio. Cruza las cuatro capas (C++ → FFI → Rust → TS).
**Impacto: alto para el síntoma 3.** Es la única forma de tener más detalle:
hoy no existen los datos.

## Problema

Ver [00-DIAGNOSTICO.md, C5](00-DIAGNOSTICO.md#c5--el-detalle-de-la-waveform-tiene-un-techo-duro-en-zoom--96-de-64).

El LOD más fino que se genera es de **256 frames por bucket**
(`crates/libretracks-project/src/waveform.rs:25`). Con 44,1 kHz:

- Un bucket por píxel se alcanza a **172,3 px/s** → **zoom ≈ 9,6 de 64**.
- **Por encima de ese zoom no hay más información que enseñar.** Se estira la
  misma.
- Al zoom máximo (1152 px/s) cada bucket ocupa **6,7 px**: escalera.

Subir la resolución del LOD para todo el archivo **no** es la solución. LOD0 de
un stem de 4 min a 44,1 kHz ocupa ~660 KB; a 32 frames/bucket serían **5,3 MB
por archivo**, y una sesión de 25 stems son **132 MB** que habría que generar,
guardar en `.ltpeaks`, cargar en RAM y mandar por IPC. El `SongView` con
waveforms ya pesa ~27 MB.

Lo que se necesita es lo que hacen los DAW: **pedir picos de alta resolución
sólo para la ventana visible, bajo demanda**.

## Lo que ya existe (no hay que inventarlo)

- El engine sabe calcular picos a **cualquier** resolución desde su caché PCM en
  disco: `SourceManager::source_peaks(source_id, resolution_frames)`
  (`native/audio-engine-v2/src/sources/source_manager.cpp:1330`). Ya lee el
  fichero de caché por trozos de 16 384 frames y agrega a buckets.
- Está expuesto por FFI: `lt_audio_engine_get_source_peaks`
  (`native/audio-engine-v2/src/ffi/lt_engine_ffi.cpp:125`) y en Rust como
  `AudioController::source_peaks` (`apps/desktop/src-tauri/src/audio/engine.rs:2527`).
- El `.ltpeaks` guarda un `seek_index` (`waveform.rs:76`), para el caso en que
  el engine no tenga el source cargado.

**Falta una sola cosa: la variante por ventana.** El bucle actual va de
`cursor = 0` a `entry.duration_frames`; con `sf_seek` (o el `seekg` de la rama
sin libsndfile) empieza en `start_frame` y para en `end_frame`.

## Cuánto cuesta (aritmética)

Al zoom máximo, un viewport de 1400 px muestra `1400 / 1152 = 1,22 s`
= **53 700 frames**. Leer eso de la caché PCM: unos cientos de KB, del orden de
1 ms. Un tile de alta resolución para un clip visible son ~1024 buckets ×
4 arrays × 4 B = **16 KB** por IPC.

Comparado con los 5,3 MB por archivo de subir el LOD global: **tres órdenes de
magnitud menos**.

## Cambio pedido

### 1. C++: `source_peaks_window`

```cpp
SourcePeakOverview SourceManager::source_peaks_window(
    const Id& source_id,
    Frame start_frame,
    Frame end_frame,
    int bucket_count) const;
```

Nota el cambio de parámetro: **`bucket_count`, no `resolution_frames`**. El
consumidor sabe cuántos píxeles tiene que llenar; que el motor derive la
resolución evita un redondeo que descuadre los buckets con los píxeles.

Reutilizar el bucle existente. La única novedad es el `seek` inicial y el corte.
Extraer el cuerpo compartido para no duplicar la lógica de agregación.

### 2. FFI + Rust: exponerlo

Mismo patrón que `lt_audio_engine_get_source_peaks`.

**Advertencia de coste:** la implementación actual devuelve los picos como
**JSON** (`out["min_peaks"] = overview.min_peaks;` en
`engine_impl.cpp:1508`). Para una llamada de import, una vez por archivo, vale.
Para una llamada por ventana durante el zoom, **no**: parsear 4 096 flotantes de
texto en cada actualización es justo el coste que este paso viene a evitar.

Devolver **binario** (los cuatro `float32` en little-endian, contiguos), como ya
hace `WaveformLodDto` con `minPeaksBase64` en el camino del `SongView`. El
frontend ya tiene `decodeFloat32Peaks` (`WaveformTileCache.ts:75`).

### 3. Comando de Tauri

```
get_waveform_window(waveform_key, start_seconds, end_seconds, bucket_count)
  -> { sampleRate, startSeconds, endSeconds, bucketCount,
       minPeaksBase64, maxPeaksBase64, minPeaksRightBase64, maxPeaksRightBase64 }
```

**No puede correr bajo el lock de sesión.** Hay precedente explícito en este
repo: analizar ondas bajo el lock congela la UI
(`project_session_lock_heavy_work`, y el comentario de `load_waveforms` en
`state/mod.rs:1398` que documenta un bloqueo de 10,9 s por exactamente esto).
Va al hilo de trabajo, con respuesta asíncrona.

**Fallback obligatorio**: si el source no está cargado en el engine (sesión
recién abierta, source aún preparándose), el comando debe responder «no
disponible» y el frontend seguir con el LOD grueso. Nunca bloquear ni forzar una
decodificación sincrónica.

### 4. Frontend: pedirlo sólo cuando aporta

Regla: **por encima de 172 px/s** (un bucket de LOD0 por píxel), el tile visible
pide su ventana de alta resolución. Por debajo, nada cambia.

Encaja con la cola del paso 04: la petición se encola como una rasterización
más, el tile se pinta primero con el LOD grueso y se repinta cuando llegan los
datos finos. Igual que el sustituto de nivel vecino: **nunca un hueco, siempre
una mejora progresiva**.

Cachear la ventana con la misma política de bytes del paso 04.

### 5. (Opcional, fuera del alcance base) Vista de muestra

Por encima de ~1 frame/píxel se podría dibujar la forma de onda como línea
continua entre muestras, en vez de min/max. Ableton lo hace. **Déjalo fuera de
este paso**: primero que haya datos, luego se decide cómo pintarlos.

## Criterios de aceptación

- [x] `source_peaks_window` existe en C++ con test unitario que compara su
      salida contra un recorte de `source_peaks` sobre el mismo archivo. Debe
      coincidir **exactamente** (mismos min/max) para una ventana alineada.
- [x] La respuesta viaja en **binario**, no en JSON de flotantes. Verificable
      midiendo el tamaño de la respuesta para 1024 buckets estéreo: debe rondar
      los 16 KB, no los ~60 KB de la representación textual.
- [x] El comando de Tauri **no toma `session.lock`** durante la lectura.
      Verificable por inspección; **no** lo pruebes por temporización de hilos
      (hay precedente de dos releases tumbadas por eso —
      `project_ltset_lock_test_timing`).
- [x] Con el source no cargado, el comando responde «no disponible» y la UI
      sigue pintando con el LOD grueso, sin error visible.
- [ ] **Comparativa visual obligatoria**: mismo clip, mismo zoom máximo, antes y
      después. La escalera de 6,7 px debe desaparecer. Capturas en el PR.
- [ ] Medición del coste: tiempo del comando para una ventana de 1,22 s con un
      stem de 4 min, en release. Anotar en el PR.
- [x] Ni el `SongView` ni el `.ltpeaks` crecen. Este paso **no** cambia el
      formato de la caché de ondas (sigue en v6).
- [ ] Sigue funcionando en Android (el engine es el mismo). Compilar para
      Android antes de cerrar: `cargo check` de escritorio **no** compila el
      código `cfg(target_os = "android")`.

## Notas para el implementador

- No toques `WAVEFORM_LOD_RESOLUTIONS`. Añadir un LOD más fino es la solución
  equivocada por las razones de arriba, y además invalidaría toda la caché
  `.ltpeaks` de los usuarios (versión de formato v6, con migración perezosa ya
  documentada en `project_waveform_cache`).
- La caché PCM del engine puede ser **int16** (optimización R1 ya en el repo).
  Comprueba en qué formato está el `cache_file_path` antes de asumir `float`;
  la rama sin libsndfile lee flotantes crudos.
- Si el source está en streaming (`entry.status == "streaming"`), el fichero de
  caché está a medias. `source_peaks` ya devuelve vacío en ese caso (R5,
  `source_manager.cpp:1364`) — la variante por ventana debe hacer lo mismo.
- Este paso es el que más se parece a un «feature» y el que más fácil es
  sobredimensionar. El objetivo es que la onda tenga detalle al zoom máximo, no
  construir un editor de muestras.
