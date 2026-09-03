# 04 — Quitar las búsquedas lineales por `std::string` del bucle de pistas

**Depende de:** 02.
**Toca:** `native/audio-engine-v2/src/render/mixer.cpp`,
`include/lt_engine/render/mixer.h`.
**Riesgo:** bajo-medio. Toca la resolución de slots, que tiene una disciplina de
publicación delicada durante los rebuilds.

## Problema

Hallazgo 5.3 del diagnóstico. `Id = std::string` (`core/types.h:14`), y el bucle
de pistas hace tres búsquedas lineales con comparación de cadenas por bloque:

**1. `control_index_for_track` (`mixer.cpp:283-293`)**, una vez por pista:

```cpp
for (int i = 0; i < count; ++i) {
    if (controls_[i]->initialized && controls_[i]->track_id == track_id)
        return i;
}
```

`controls_` cubre **todas las pistas de todas las canciones de la sesión**. Con
3 canciones de 25 pistas son 75 slots, y 25 pistas sonando dan ~940 comparaciones
de cadena por bloque. El coste es O(pistas_sonando × slots_totales): **crece al
cuadrado con el tamaño de la sesión**, no con lo que suena.

**2. `update_ancestor_folder_meters` (`mixer.cpp:1572-1576`)**, un `std::find_if`
lineal por cada nivel de carpeta, por pista, por bloque.

**3. `find_track_in_song`**, dentro de la resolución de routing — lo elimina el
paso 03, pero si 03 y 04 se hacen en paralelo, coordinadlo en la bitácora.

## Cambio pedido

### 1. Índice de slot cacheado por ranura de renderer

El bucle ya itera `song.tracks[ti]` con el mismo `ti` que indexa `renderers_[ti]`
y `track_meters_[ti]`. Añade un vector paralelo, rellenado en la hebra de
control junto a los renderers:

```cpp
// control_slot_for_renderer_[ti] = índice en controls_ de song.tracks[ti],
// o -1 si esa pista no tiene slot. Rellenado por rebuild_control_slots /
// prepare_render_resources; el hilo de audio sólo lee.
std::vector<int> control_slot_for_renderer_;
```

El bucle pasa de buscar a indexar. **La búsqueda lineal se queda** como respaldo
para la ventana en que `control_count_` es 0 durante un rebuild — no la borres,
sólo deja de usarla en el camino normal.

### 2. Cadena de ancestros precalculada

`update_ancestor_folder_meters` sube por `parent_track_id` buscando por nombre.
`TrackControlState` **ya tiene** `parent_control_index` precalculado. Reescribe
la función para subir por índices, no por cadenas.

Ojo: la función indexa `track_meters_[parent_index]` usando el índice del padre
**dentro de `song.tracks`**, que no es lo mismo que el índice en `controls_`.
Necesitas una cadena de índices de *renderer/meter*, no de *control*. Añade lo
que haga falta al vector del punto 1 (por ejemplo un
`std::vector<std::array<int, kMaxFolderDepth>>` con la cadena ya resuelta) y
documenta cuál es cuál, porque confundirlos hace que los medidores de carpeta
apunten a la pista equivocada y es un fallo silencioso.

### 3. Acumulación de medidores de carpeta segura para varios hilos

Bloqueante B2 del diagnóstico. Hoy:

```cpp
meter.left_peak.store(std::max(meter.left_peak.load(relaxed), left_peak), relaxed);
```

Es un read-modify-write no atómico: con un hilo es correcto, con varios se
pierden picos. Sustitúyelo por un bucle CAS (`compare_exchange_weak` sobre el
máximo). Con un solo hilo el resultado es idéntico; el paso 08 depende de esto.

## Criterios de aceptación

- [ ] C1 — El bucle de pistas **no llama a `control_index_for_track`** en el
      camino normal. Verificable con un contador de diagnóstico incrementado
      dentro de esa función: tras 200 bloques con los slots construidos, vale 0.
- [ ] C2 — El respaldo sigue funcionando: test que fuerza `control_count_ == 0`
      durante el render y verifica que las pistas siguen sonando con su
      ganancia/pan/mute/solo correctos (es la garantía que documenta
      `mixer.cpp:472-476`; no la rompas).
- [ ] C3 — **Equivalencia de medidores de carpeta.** Sesión con 3 niveles de
      carpetas anidadas y ≥ 10 pistas; los valores de `track_meters_` de todas
      las carpetas coinciden **exactamente** con los de la implementación
      anterior, bloque a bloque, durante 200 bloques.
- [ ] C4 — El caso de la pista huérfana: una pista cuyo `parent_track_id` apunta
      a un id inexistente, y otra cuyo padre no es `TrackKind::Folder`, se
      comportan igual que hoy (se corta la cadena, no se accede fuera de rango).
      Test.
- [ ] C5 — Profundidad máxima: una cadena de más de `kMaxFolderDepth` niveles se
      trunca igual que hoy. Test.
- [ ] C6 — La acumulación de picos usa CAS y **no pierde el máximo** cuando dos
      hilos acumulan a la vez sobre el mismo slot. Test con dos hilos,
      sincronizados con `std::latch`, cada uno acumulando 10 000 valores
      conocidos; el máximo final debe ser el máximo real. **Sin `sleep` ni
      medidas de tiempo.**
- [ ] C7 — Prueba de que sabe fallar: revierte el CAS al `load/max/store` y
      comprueba que C6 se pone rojo. Pega ambas salidas. Si con el código
      antiguo **también** pasa, tu test no ejerce la carrera y no vale.
- [ ] C8 — Salida bit-exacta contra la implementación anterior: sesión fija con
      carpetas, 200 bloques, cero diferencia muestra a muestra.
- [ ] C9 — `npm run test:native` pasa. `cargo check --all-targets` pasa.

## Notas para el implementador

- El vector nuevo lo escribe la hebra de control y lo lee el hilo de audio. Usa
  **exactamente** la misma disciplina que ya usan `renderers_` y `track_meters_`:
  crecer mientras el contador publicado es 0, y publicar con `release` al final
  (`mixer.h:161-177` lo explica). No inventes un esquema nuevo.
- Este paso **no** debe cambiar ningún valor de medidor ni ninguna muestra. Si
  un test de equivalencia falla, el fallo es tuyo, no del test.
- C6 es el criterio con más trampa del paso: un test de carrera que no ejerce la
  carrera pasa siempre. Por eso C7 exige demostrar que el código antiguo lo
  suspende. Este repo tiene precedente de un test de regresión que no sabía
  fallar y dejó pasar el bug que decía cubrir.
- Si el paso 03 se está haciendo en paralelo, ambos tocan el bucle de pistas y
  `TrackControlState`. Coordinadlo por la bitácora y aplicad el segundo sobre el
  primero; no los fusionéis en un solo paso.
