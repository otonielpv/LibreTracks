# Pasos 01→05 — implementación directa

**Cómo se hizo:** el usuario pidió saltarse el bucle BUILDER/REVIEWER y hacer
los cinco pasos del tirón, un commit por paso. No hay entradas [BUILD]/[REVIEW]
alternas; esta es la bitácora completa. **Ninguno de estos pasos ha pasado por
un REVIEWER independiente.**

| Paso | Commit | Estado |
| --- | --- | --- |
| 01 perfil de dispositivo | `ea485fa9` | Implementado |
| 02 presupuestos móviles | `32a3c697` | Implementado |
| 03 presión de memoria | `e44523b6` | Implementado |
| 04 import sin staging | `0bd996de` | Implementado |
| 05 extracción amable | `f39efe5b` | Implementado |

## Verificación ejecutada

```
lt_engine_tests            300 casos, 111 367 aserciones — SUCCESS
cargo test -p libretracks-project    16 tests de session_package — ok
cargo check --all-targets            sin errores (warnings preexistentes)
cargo check --target aarch64-linux-android --lib   Finished, sin errores
```

El target Android se compiló de verdad (NDK 26.2.11394342), no solo el de
escritorio: la mitad de este trabajo vive tras `cfg(target_os = "android")`,
que `cargo check` de escritorio no mira.

## Bugs que los tests encontraron antes de llegar al commit

Cuatro, todos en código escrito en esta misma sesión:

1. **`BlockCache::release_unprotected`, umbral 0.** Un umbral de "conservar
   todo" expresado como 0 no protegía el bloque cuyo `last_used` era 0 — el
   primero que se cachea. Se perdía un bloque por fuente.
2. **`BlockCache::release_unprotected`, índice de `nth_element`.** Pedía el
   K-ésimo mayor en el índice K, que es el (K+1)-ésimo. Conservaba un bloque de
   más.
3. **Test de limpieza que no sabía fallar.** Usaba un zip truncado, que revienta
   en `ZipArchive::new` ANTES de crear el directorio: pasaba igual con la
   limpieza desactivada. Rehecho con un paquete de directorio central válido
   pero sin `session.ltsession`, que llega a escribir y falla al final.
4. **Orden del `match` en `plan_trim_response`.** Las constantes de Android
   **no están ordenadas por severidad**: `MODERATE` (60) es mayor que
   `BACKGROUND` (40) pero es el aviso más suave. Un brazo `level >= BACKGROUND`
   se tragaba `MODERATE`. Hay un test que fija esa trampa.

Los tres primeros salieron de tests de la propia tanda; el cuarto, de ejecutar
la política extraída del fichero contra un banco de comprobaciones en host.

## Prueba de "sabe fallar"

Se rompió a propósito y se comprobó el rojo en:

- `test_device_profile.cpp`: cambiando 512 → 400 (regresión de escritorio) y
  clasificando por RAM física en vez de disponible.
- `test_memory_pressure.cpp`: desactivando la protección de bloques →
  `read("playing", 7, …)` devuelve `false`, que es literalmente el silencio que
  el paso 03 promete no provocar.
- `session_package.rs`: `EXTRACTION_HEADROOM_BYTES` a 0 y limpieza desactivada.

## Regresión en escritorio

Ninguna detectada. Los presupuestos de PC (512/1024/2048/3072 MB, 2/3/4/6 hilos)
están fijados como literales en `test_device_profile.cpp`, y los 300 tests del
engine pasan.

Un test de frontend falla — `library.test.tsx > merges the old song library
folder…` — pero **es preexistente**: verificado haciendo `git stash` de todo el
trabajo y reproduciéndolo sobre el commit base.

## Pendiente de medir en el dispositivo

Nada de esto está confirmado sobre el Oppo. Contra
`baseline-CPH1931.json` (4,91 GB consumidos, 353 s, RSS 606 MB, 75 muertes de
procesos, 53,85 % de frames con jank) hay que comprobar:

- [ ] `import-full`: la escritura baja ≈2 GB (paso 04)
- [ ] Pico de RSS del motor < 64 MB (paso 02)
- [ ] `[LT_DEVICE]` aparece en logcat con `class=Constrained` (paso 01)
- [ ] `[LT_MEMPRESSURE]` aparece al provocar presión (paso 03)
- [ ] La reproducción NO se corta bajo presión (paso 03, criterio central)
- [ ] Fluidez de UI mejorada respecto al 53,85 % de jank

Comando: `node ./scripts/android-bench.mjs --scenario import-full --out despues.json`

**Requiere compilar e instalar la APK primero.**

## Fuera de alcance, anotado

- El import de `.ltpkg` (canción suelta) sigue usando
  `stage_picked_file_to_temp` y tiene el mismo problema que arregló el paso 04,
  a menor escala.
- Pausar la cola de preparación del motor bajo presión (parte del paso 03):
  suspender los workers de `SourcePreparationQueue` toca el hot path de decode
  y merece su propia medición. El flag existe; no gatea esa cola.
