# 05 — Publicar el mapa de voces sin el spinlock global de MSVC

**Depende de:** 02.
**Toca:** `native/audio-engine-v2/src/pitch/bungee_voice_manager.cpp`,
`include/lt_engine/pitch/bungee_voice_manager.h`.
**Riesgo:** bajo en concepto, medio en ejecución: hay que tocar todas las rutas
de publicación del mapa, incluida la de saltos prearmados.

## Problema

Hallazgo 5.2 del diagnóstico. `bungee_voice_manager.cpp:896`:

```cpp
std::shared_ptr<BungeePitchVoice> BungeeVoiceManager::voice_for_shared(const Id& clip_id) noexcept {
    auto snapshot = std::atomic_load(&impl_->active);   // ← función libre
    ...
}
```

`docs/HANDOFF_import_while_playing_glitches.md` ya lo tiene documentado como
causa confirmada de stalls en este mismo repo:

> *«MSVC `std::atomic_load(shared_ptr)` global spinlock (microsoft/STL#86): the
> audio thread spun on a process-global spinlock held by a BELOW_NORMAL
> thread»*

Se arregló para `session_`, que hoy usa `std::atomic<std::shared_ptr>`
(`mixer.cpp:234-248`, con la rama `#if !defined(_MSC_VER)`). **No se arregló
para el mapa de voces.**

Tres agravantes:

1. Se llama **una vez por clip warpeado por bloque**, desde
   `render_path_stretched`. Con 25 pistas warpeadas son 25 tomas de un spinlock
   **global del proceso** por bloque.
2. El spinlock lo puede tener un hilo `BELOW_NORMAL` (los que construyen voces:
   `bungee_voice_manager.cpp:594` y `:780` se bajan a esa prioridad a
   propósito). El hilo de audio, a prioridad crítica, gira esperando a un hilo
   que el planificador no tiene prisa por ejecutar. Es inversión de prioridad de
   libro.
3. **Con el pool del paso 08, ese spinlock serializaría justo la sección que
   queremos paralelizar.** Este paso es un prerrequisito duro de 08.

Además, `voice_for_shared` devuelve el `shared_ptr` **por valor**: cada llamada
incrementa y decrementa un contador atómico, y si el decremento llega a cero el
hilo de audio **destruye la voz** — liberando los buffers de Bungee bajo el lock
del allocator. Ver la nota `project_voice_map_freed_on_audio_thread` en la
memoria del proyecto.

## Cambio pedido

### 1. `std::atomic<std::shared_ptr<const VoiceMap>>`

Cambiar `impl_->active` de `std::shared_ptr<const VoiceMap>` a
`std::atomic<std::shared_ptr<const VoiceMap>>`, y sustituir **todos** los
`std::atomic_load` / `std::atomic_store` sobre él por `.load()` / `.store()`.

Sigue el patrón que ya está en `mixer.cpp:234-248`, incluida la rama para
compiladores sin `std::atomic<std::shared_ptr>` si hace falta para macOS/Linux.
Hay que revisar los sitios de publicación: `rebuild_for_session`,
`rebuild_for_seek*`, `publish_prepared_voice_map_realtime` y
`publish_empty_voice_map_realtime`.

Cuidado con `publish_prepared_voice_map_realtime`: por el nombre se llama desde
el hilo de audio (`mixer.cpp:809`, en el camino del salto prearmado). Un
`.store()` de `atomic<shared_ptr>` **también** puede bloquear en algunas
implementaciones. Comprueba qué hace en la vuestra y, si bloquea, documenta el
riesgo y propón alternativa (por ejemplo, publicar el índice de un buffer doble)
en la bitácora **sin implementarla en este paso**.

### 2. No destruir voces en el hilo de audio

Cuando el hilo de audio suelta la última referencia a un mapa, destruye las
voces ahí mismo. Añade una **cola de reclamación**: el mapa saliente se empuja a
una cola sin locks que un hilo de control drena. El hilo de audio nunca ejecuta
el destructor de un `BungeePitchVoice`.

Si esto resulta ser más grande de lo que cabe en el paso, **dilo en la bitácora
y déjalo para un paso propio**, pero deja el contador de C4 puesto para poder
medirlo. No lo implementes a medias.

## Criterios de aceptación

- [ ] C1 — No queda ninguna llamada a `std::atomic_load` ni `std::atomic_store`
      sobre un `shared_ptr` en `bungee_voice_manager.cpp`. Verificable con
      `grep`; pega la salida vacía.
- [ ] C2 — Un `grep` por `std::atomic_load` en todo
      `native/audio-engine-v2/src/` no devuelve ningún uso alcanzable desde el
      hilo de audio. Si queda alguno fuera de ese camino, justifícalo en la
      bitácora.
- [ ] C3 — El mapa de voces se publica y se consume correctamente: test que
      construye un mapa, lo publica, lo consume desde otro hilo, publica uno
      nuevo, y verifica que el consumidor ve el nuevo y que ninguna voz del
      viejo se destruyó mientras se usaba. Sincronizado con `std::latch`, **sin
      `sleep` ni medidas de tiempo**.
- [ ] C4 — Contador nuevo en `BungeeVoiceManagerDiagnostics`:
      `voices_destroyed_on_audio_thread`. Tras 500 bloques con dos rebuilds de
      mapa a mitad de reproducción, vale **0**. (Si la cola de reclamación se
      difiere a otro paso, este criterio se marca `[!]` con el valor medido
      anotado, no `[x]`.)
- [ ] C5 — Prueba de que sabe fallar: fuerza a propósito una destrucción en el
      hilo de audio (suelta la última referencia dentro de la sección) y
      comprueba que C4 la detecta.
- [ ] C6 — El camino del salto prearmado sigue funcionando: los tests de
      `prearmed_jump_tests.cpp` y `warp_timing_tests.cpp` pasan sin cambios de
      resultado.
- [ ] C7 — Salida bit-exacta con warp activo: sesión fija de ≥ 8 pistas
      warpeadas, 200 bloques, cero diferencia muestra a muestra contra la
      implementación anterior.
- [ ] C8 — `npm run test:native` pasa. `cargo check --all-targets` pasa.

## Notas para el implementador

- `std::atomic<std::shared_ptr>` es C++20 y MSVC lo tiene. La cuestión es si su
  implementación es *lock-free* — normalmente **no** lo es, pero usa un lock
  **por objeto** en vez del pool global compartido de `std::atomic_load`. Esa es
  la mejora: el hilo de audio deja de competir con cualquier otro
  `shared_ptr` atómico del proceso. Dilo así en el comentario del código, sin
  prometer lock-free.
- No cambies la semántica de `voice_for_shared` (devolver un `shared_ptr` que
  mantiene viva la voz durante el bloque). Esa propiedad es lo que impide que un
  rebuild concurrente le quite la voz al render a mitad de bloque.
- `warp_timing_tests.cpp` mide el ratio entregado contra el pedido y lo mantiene
  bajo el 0,01 %. Es un test valioso: si empieza a fallar, has cambiado el
  comportamiento del feed, no sólo la publicación.
- Hay un caso conocido: `build_seek_voice_map` abandonaba la voz si la fuente no
  estaba cacheada, y se arregló para instalarla siempre (commit `0b0e6669`). No
  lo reintroduzcas al tocar las rutas de publicación.
