# 00 — Diagnóstico: el warp satura el hilo de audio

Documento de contexto compartido. **Todo agente (BUILDER o REVIEWER) debe leer
este fichero antes de tocar nada.** No contiene tareas; contiene los hechos
medidos que justifican cada paso del plan.

Medido el 2026-09-03. Máquina de referencia: **Intel i7-12700KF** (12 núcleos /
20 hilos, 8 P-cores + 4 E-cores), Windows 11, build Release con MSVC 2022.

## El síntoma

Un usuario activa el warp en una canción y la reproducción «cruje, como
arenosa». El medidor de **Carga de audio** llega al **96 %**.

## Qué mide ese porcentaje

`native/audio-engine-v2/src/render/mixer.cpp:1140-1145`

```cpp
double load = (dur / budget_ms) * 100.0;
callback_load_percent_.store(0.9 * prev_load + 0.1 * load, ...);
```

Es la fracción del presupuesto del buffer (`frames / sample_rate`) que se pasa
dentro de `Mixer::render`, suavizada con una EMA 0.9/0.1. **Un 96 % mostrado es
una media sostenida del 96 %**, con picos p95/max de 1,5-2x por encima. Por
encima del 100 % el buffer no llega a tiempo y la tarjeta repite o salta
muestras: eso es el crujido.

El cronómetro envuelve `Mixer::render` entera, así que incluye pistas,
metrónomo, pads, voz guía y medidores.

## Hecho 1 — el porcentaje es CPU pura; el disco no puede subirlo

El hilo de audio **nunca espera a la I/O**.
`native/audio-engine-v2/src/sources/streaming_source.cpp:48-67`:

```cpp
bool hit = cache_->read(source_id_, block_index, ...);   // solo RAM
if (!hit) {
    std::fill(...0.f);                                    // silencio y sigue
    starvation_count_.fetch_add(1, ...);
}
```

Un bloque que no está listo se rellena con ceros y se sigue. Los hilos de fondo
rellenan la caché. Consecuencia para el diagnóstico:

| Síntoma | Causa | Firma |
| --- | --- | --- |
| Crujido continuo mientras suena todo | CPU saturada | carga alta y sostenida |
| Huecos de silencio limpios | starvation de disco | carga **normal** + `[LT_STARVATION]` |

Los dos pueden coexistir. Este plan ataca **solo el primero**.

### Evidencia del PC afectado (log recibido el 2026-09-03)

El usuario tiene un **Intel i5-11400H (6 núcleos / 12 hilos), 8 GB de RAM y
una RTX 3050**. No es una máquina insuficiente para reproducción multitrack:
la GPU no participa en Bungee y el CPU tiene paralelismo de sobra para el pool
de 4 hilos propuesto. Los 8 GB sí sitúan al equipo en el perfil
`ModestDesktop` y dejan menos margen para caché, WebView y paginación.

El fichero real `libretracks-engine-1788425424.log` cambia el diagnóstico de
"una causa probable" a **dos fallos observados**:

- 172 líneas `[LT_STARVATION]` en el historial. En el tramo iniciado el
  2026-08-30 hay 141 eventos y unos 660 423 frames silenciados acumulados
  (~13,8 s a 48 kHz); una ventana individual llega a ~963 ms. En sesiones
  anteriores hay ventanas de 2,8 s y 12,1 s.
- El proceso elige 4 hilos de relleno y 3 de decode para 12 hilos lógicos y
  7,6 GB detectados. Es decir, el log es posterior al pool de relleno: volver a
  añadir ese pool no es una solución.
- Reserva un working set mínimo de 1957 MB, con máximo de 2981 MB. En una
  máquina de 8 GB puede ser correcto o contraproducente según la memoria
  **disponible**; el log no contiene `pf+=`, `fill_q` ni tiempos de lectura con
  los que decidirlo.
- No hay ninguna línea `[LT_PITCH_DEBUG]`: faltan `active_voices`, ratio y
  backend. Por eso este log **no demuestra** cuántas voces llevaron el callback
  al 96 %, aunque sí demuestra starvation independiente.
- Hay 61 mensajes `MMCSS promotion FAILED (err=1552)`. En Windows, 1552 es
  `ERROR_THREAD_ALREADY_IN_TASK`: el hilo ya pertenecía a una tarea MMCSS. No
  debe presentarse como ausencia de MMCSS ni activar un fallback como si la
  promoción multimedia no existiera; hay que convivir con la promoción del
  backend JUCE (paso 09).

Consecuencia: completar 01-09 puede bajar mucho la carga de Bungee y aun así
dejar cortes por bloques no residentes. El [paso 10](10-validacion-pc-afectado.md)
es ahora la puerta de cierre del reporte real y obliga a medir ambas firmas por
separado.

## Hecho 2 — el warp cuesta ~1 % del presupuesto por pista, y es plano

Con warp activo, `render/pitch_resolution.cpp:104-111` manda **todos** los clips
de la región al camino `Stretched`, y `pitch/bungee_voice_manager.cpp:225-243`
da una **voz Bungee propia a cada clip**. Sin warp esos clips van por `Direct`,
que es una copia de memoria.

Banco `native/audio-engine-v2/bench/bench_bungee_voice_cost.cpp`, 48 kHz,
hop=-1:

| voces | 512 fr (10,67 ms) | 256 fr (5,33 ms) | 128 fr (2,67 ms) |
| ---: | ---: | ---: | ---: |
| 8 | 8,2 % | 8,3 % | 8,5 % |
| 16 | 16,3 % | 16,8 % | 17,1 % |
| 24 | 24,7 % | 25,3 % | 25,7 % |
| 32 | 32,8 % | 33,7 % | 34,4 % |

**El coste por voz es ~1,05 % del tiempo real y no depende de nada más:**

- Ni del tamaño de buffer.
- Ni del `hop` (0 y -1 miden igual: 108,7 vs 106,4 µs/voz).
- **Ni del ratio de warp** — 1.00, 0.80 y 1.25 miden 106,4 / 107,3 / 106,7 µs.
- Ni del pitch (+3 semitonos: 110,6 µs).

Sólo escala con el **número de voces**, y el hilo de audio las recorre en serie.

> Consecuencia directa: **activar warp con ratio 1.0 y sin transposición se paga
> entero a cambio de nada.** Es el paso [06](06-bypass-de-warp-neutro.md).

Para llegar al 96 % en esta máquina harían falta ~90 voces. El i5-11400H del
usuario no explica por especificación, él solo, una diferencia de ~4x por hilo.
Antes de atribuirla al hardware hay que conocer las voces activas, la frecuencia
real bajo carga, el plan de energía y el resto del trabajo del callback. Esos
datos faltan en el log recibido.

## Hecho 3 — el paralelismo sí escala, incluso con buffers pequeños

Banco `native/audio-engine-v2/bench/bench_bungee_thread_scaling.cpp`: prioridad
MMCSS Pro Audio en todos los hilos, barrera de espera activa (nada de `condition_variable`), el
director también trabaja. Mide el tiempo de pared que pagaría el callback.

**24 voces:**

| hilos | 512 fr | 128 fr | speedup |
| ---: | ---: | ---: | ---: |
| 1 | 24,7 % | 25,6 % | 1,00x |
| 2 | 12,4 % | 12,9 % | ~2,0x |
| 4 | 6,4 % | 6,7 % | ~3,8x |
| 6 | 5,3 % | 4,9 % | ~4,7x |
| 8 | 4,2 % | 4,4 % | ~5,9x |

Los dos resultados que importan:

1. **Escala casi lineal hasta 4 hilos** y sigue mejorando hasta 8.
2. **Funciona igual de bien con buffer de 128 que de 512.** Esto era lo que
   podía tumbar la idea. La barrera de espera activa no cuesta prácticamente
   nada; con `condition_variable` el resultado habría sido el contrario, porque
   despertar un hilo por el SO cuesta decenas de µs sobre un presupuesto de
   2,67 ms.

**Aviso sobre estas cifras**: la máquina estaba ociosa y tiene 20 hilos. Un
trabajador que caiga en un E-core es 2-3x más lento y se convierte en el
rezagado que define la latencia del bloque, así que las columnas de 6 y 8 hilos
probablemente ya lo estén sufriendo. En una máquina de 4 hilos lógicos, además,
compite con el WebView. Es el motivo del paso [09](09-politica-de-hilos.md).

## Hecho 4 — por qué hay un solo hilo, y por qué eso no es toda la historia

El driver nos entrega **un único hilo de callback** con fecha límite dura. ASIO,
WASAPI, CoreAudio y Oboe funcionan así; no existe API que dé varios callbacks en
paralelo. Ese hilo está bien montado: se promociona a MMCSS «Pro Audio» con
`AVRT_PRIORITY_CRITICAL` en `devices/audio_device_manager.cpp:48-67`.

Lo que no hicimos es lo que los DAW profesionales construyen encima. Todos
tienen **dos** mecanismos distintos:

- **(a) Paralelismo de grafo dentro del bloque.** El hilo del callback hace de
  director y despierta N-1 trabajadores en prioridad de tiempo real, que toman
  nodos independientes de una cola; el director hace la junta antes de devolver
  el buffer. Live (desde la v5), Logic («Processing Threads»), Cubase, Bitwig.
- **(b) Procesado anticipado.** Renderizar por adelantado en hilos de fondo todo
  lo que no necesita responder a una entrada en vivo, a un FIFO. Reaper
  (*Anticipative FX Processing*, 200 ms por defecto), Cubase (*ASIO-Guard*),
  Studio One (*Dropout Protection*), Logic (*Process Buffer Range*).

La regla que comparten: **el camino de tiempo real duro es sólo para lo que debe
responder a la entrada en vivo** — pistas armadas o monitorizadas.

**Nuestra diferencia**: el motor **no tiene entrada de audio, ni grabación, ni
monitorización**. En su taxonomía, el 100 % de nuestro grafo cumple los
requisitos del camino anticipado.

### Por qué este plan hace (a) y no (b)

(b) daría más margen, pero LibreTracks es una herramienta de directo y alguien
mueve faders desde el remote mientras suena. Renderizar 200 ms por delante haría
que un mute tardara 200 ms en oírse.

La versión correcta de (b) para nosotros sería partirlo: adelantar sólo la parte
cara e independiente de parámetros (lectura de fuente + Bungee) a FIFOs por
pista, y dejar en el callback la parte barata que sí depende de parámetros
(ganancia, pan, mute, solo, routing, medidores). Encaja bien con el código —
`BungeePitchVoice` ya tiene FIFO interno y `render_path_stretched` ya está
separado de `finalise_clip_block`.

**Se descarta por ahora** porque (a) da ~3,8x medido sin tocar el modelo de
transporte ni añadir latencia, y porque (b) sobre un hilo sin sanear sería
inauditable. Si tras el paso 09 sigue faltando margen, (b) es el siguiente
plan, no un paso de éste.

## Hecho 5 — tres violaciones de tiempo real en el hilo de audio

Salieron al auditar el bucle de pistas. **No son la causa del 96 %** (Bungee
domina por goleada), pero son la causa de los picos esporádicos, y con N
trabajadores empeorarían por N.

### 5.1 — Asignación de memoria por pista y por bloque

`render/mixer.cpp:647` y `render/mixer.cpp:979`:

```cpp
auto route = route_channels(resolve_effective_audio_route(track, song), ...);
```

- `resolve_effective_audio_route` devuelve `std::string` por valor y llama a
  `normalize_audio_route(std::string route)` — **parámetro por valor** — dentro
  de un bucle sobre la cadena de padres.
- `route_channels` copia otro `std::string` y devuelve **`std::vector<int>`**,
  que siempre va al heap.

Son 2-3 `malloc` por pista por bloque en el hilo de tiempo real. Y cinco líneas
más arriba, en la misma función, está este comentario:

> *«gain_override=1.0f: ... we neutralize them here WITHOUT copying the Track
> (that per-block heap allocation contended the global allocator lock with
> import-time allocations and stalled the audio thread).»*

Es **el mismo bug**, ya diagnosticado y arreglado para `Track`, todavía vivo dos
líneas más abajo. `docs/HANDOFF_import_while_playing_glitches.md` lo registra
como causa confirmada de stalls.

### 5.2 — El spinlock global de MSVC, en el camino del warp

`pitch/bungee_voice_manager.cpp:896`:

```cpp
auto snapshot = std::atomic_load(&impl_->active);   // función libre
```

`docs/HANDOFF_import_while_playing_glitches.md` lo documenta:

> *«MSVC `std::atomic_load(shared_ptr)` global spinlock (microsoft/STL#86): the
> audio thread spun on a process-global spinlock held by a BELOW_NORMAL
> thread»*

Se arregló para `session_`, que hoy usa `std::atomic<std::shared_ptr>`
(`render/mixer.cpp:238`), pero **no** para el mapa de voces, que se consulta
**una vez por clip warpeado por bloque**. Con 25 pistas warpeadas son 25 tomas
de un spinlock global del *proceso* por bloque. Con N trabajadores, ese
spinlock serializaría justo la sección que queremos paralelizar.

### 5.3 — Búsquedas lineales con comparación de cadenas

`Id = std::string` (`core/types.h:14`).

- `render/mixer.cpp:283-293` — `control_index_for_track` recorre linealmente
  **todos** los slots comparando `std::string`, una vez por pista por bloque.
  Los slots cubren todas las pistas de **todas** las canciones de la sesión →
  coste O(pistas × slots), cuadrático con el tamaño de la sesión.
- `render/mixer.cpp:1572-1576` — `update_ancestor_folder_meters` hace otro
  `std::find_if` lineal por ancestro.
- `resolve_effective_audio_route` llama a `find_track_in_song`, otro lineal.

## Hecho 6 — qué bloquea hoy la paralelización

Lo que **ya está bien** y no hay que tocar:

- `renderers_[ti]` es **uno por pista**, cada uno con su `scratch_l_/scratch_r_`
  y su `bungee_in_l_/bungee_in_r_`. Ya es seguro en paralelo.
- Las voces Bungee son por clip, independientes entre sí.
- El estado suavizado (`control->current_gain`, etc.) es por slot de pista.
- `compute_effective_controls` usa `parent_control_index` precalculado y es de
  sólo lectura.

Los bloqueantes reales:

| # | Qué | Dónde |
| --- | --- | --- |
| B1 | `mix_l_`/`mix_r_` es **un único bus compartido** reutilizado pista a pista | `include/lt_engine/render/mixer.h:228-230` |
| B2 | Los medidores de carpeta hacen `load` → `max` → `store` sobre atómicos: con varios hilos se pierden actualizaciones | `render/mixer.cpp:1586-1597` |
| B3 | La acumulación final es `output_channels[ch][f] += ...` sobre el buffer compartido | `render/mixer.cpp:655-676` |

B1 es *el* punto de serialización y es lo que resuelve el paso 07.

## Lo que este plan NO cambia

- El modelo de transporte, el reloj, ni el playhead a 60 fps.
- La latencia de Bungee (~110 ms a hop=-1). Ver
  `native/audio-engine-v2/WARP_BACKEND_NOTES.md`.
- La calidad del warp. Bungee sigue siendo el backend; el paso 06 sólo evita
  invocarlo cuando es la identidad.
- El camino de starvation de disco. Es otro problema con otra firma; el paso 10
  impide dar por resuelto el reporte del usuario si esa firma sigue presente,
  pero su corrección puede requerir un plan específico.
