# Harness BUILDER / REVIEWER — plan `audio-thread-parallelism`

Protocolo para implementar este plan con dos agentes, ejecutados en bucle hasta
que cada paso esté terminado. Es **el mismo protocolo** que el plan
`android-low-end`, con otro directorio de plan y otro de bitácoras, para que
ambos puedan avanzar sin pisarse.

## Piezas

| Fichero | Qué es |
| --- | --- |
| `.claude/skills/audio-builder/SKILL.md` | BUILDER (implementa) — **fuente de verdad** |
| `.claude/skills/audio-reviewer/SKILL.md` | REVIEWER (juzga) — **fuente de verdad** |
| `prompts-codex.md` | Los mismos roles, como prompts pegables para Codex |
| `.github/prompts/audio-*.prompt.md` | Los mismos roles, para Copilot en VS Code |
| `docs/plans/audio-thread-parallelism/NN-*.md` | La tarea y sus criterios |
| `docs/plans/audio-thread-parallelism/state/NN.md` | Bitácora del paso (la crea el bucle) |

### Cómo se invocan

- **Claude Code (VS Code)**: `/audio-builder 03` y `/audio-reviewer 03`. Las
  skills de `.claude/skills/` se cargan solas al abrir el repo.
- **Codex**: **no tiene comandos `/`.** Copia el bloque entero de
  [`prompts-codex.md`](prompts-codex.md) y pégalo como primer mensaje.
- **Copilot en VS Code**: `/audio-builder` y `/audio-reviewer` (requiere
  `"chat.promptFiles": true`, ya en el `.vscode/settings.json` del repo).

Si editas el comportamiento de un agente, edítalo en `.claude/skills/` y propaga
el cambio a las otras dos copias.

> **Ojo con los nombres.** `/builder` y `/reviewer` (sin prefijo) son del plan
> `android-low-end` y escriben en **otro** directorio de bitácoras. Para este
> plan son siempre `/audio-builder` y `/audio-reviewer`.

## El bucle

```
                 ┌──────────────────────────────┐
                 │  BUILDER  paso 03            │
                 │  implementa o corrige        │
                 └───────────────┬──────────────┘
                                 │ escribe state/03.md (BUILD)
                                 ▼
                 ┌──────────────────────────────┐
                 │  REVIEWER paso 03            │
                 │  verifica criterio a criterio│
                 └───────────────┬──────────────┘
                                 │ escribe state/03.md (REVIEW)
                     ┌───────────┴───────────┐
                 APROBADO                CAMBIOS
                     │                       │
                     ▼                       └──► vuelve al BUILDER
                 siguiente paso
```

**Una iteración = una invocación de cada agente.** Tú lanzas cada una y lees la
salida. Si tras **3 vueltas** un paso no está aprobado, para el bucle: es señal
de que el paso está mal especificado, no de que el agente sea torpe.

## Contrato de estado

Ambos agentes escriben en `docs/plans/audio-thread-parallelism/state/NN.md`,
**añadiendo al final, nunca sobrescribiendo**. Ese fichero es la memoria entre
invocaciones: el BUILDER lo lee para saber qué le pidió el REVIEWER.

Formato de una entrada:

```markdown
## [BUILD] iteración 2 — 2026-09-05T14:22Z

### Qué he cambiado
- `native/.../mixer.cpp`: routing precalculado en el slot de control.

### Criterios que creo cumplidos
- [x] C1 — `test_rt_no_allocations` en verde, 0 asignaciones en 200 bloques
- [ ] C9 — PENDIENTE-HUMANO (requiere escucha real)

### Comandos ejecutados
npm run test:native → 231 passed

### He verificado que los tests saben fallar
Metí un `new int[4]` en Mixer::render → C1 rojo. Quitado.

### Bloqueos / dudas
Ninguno.
```

```markdown
## [REVIEW] iteración 2 — 2026-09-05T14:41Z

### Veredicto: CAMBIOS SOLICITADOS

### Verificación criterio a criterio
- [x] C1 — confirmado, ejecuté el test yo
- [!] C7 — **la comparación no es bit-exacta**: `mixer_equivalence_test.cpp:88`
      usa una tolerancia de 1e-6. Con orden descendente sigue pasando.
- [ ] C9 — PENDIENTE-HUMANO

### Qué debe corregir el BUILDER
1. `mixer_equivalence_test.cpp:88` — comparar con `==` sobre el patrón de bits,
   no con tolerancia. Luego rehacer la prueba de "sabe fallar" de C8.
```

## Reglas del bucle

1. **El REVIEWER no escribe código de producción.** Sólo juzga y, si acaso,
   arregla el propio test que está evaluando cuando el fallo sea del test.
2. **El REVIEWER ejecuta los comandos él mismo.** No se fía del informe del
   BUILDER.
3. **Los criterios que requieren escucha o hardware concreto se marcan
   `PENDIENTE-HUMANO`.** Ningún agente puede aprobarlos.
4. **Un paso sólo se aprueba con todos los criterios en `[x]` o
   `PENDIENTE-HUMANO` resuelto por ti.**
5. **Un commit por paso aprobado**, en la rama actual (no crear ramas).

## Reglas específicas de este plan

Estas son las que más veces van a provocar un rechazo. Están aquí para que
ambos agentes las tengan a mano:

1. **Nada de tests que midan tiempos de hilos.** Hay dos releases tumbadas en
   este repo por eso (`project_ltset_lock_test_timing`,
   `project_e2e_cannot_prove_lock_contention`). El rendimiento se demuestra con
   `bench_render_callback`, ejecutado por la persona y anotado en la bitácora.
   Los tests verifican **orden, contadores y equivalencia numérica**.
2. **«Bit-exacto» significa bit-exacto.** Sin tolerancia, sobre todas las
   muestras de todos los bloques. Un test de equivalencia con `abs(a-b) < 1e-6`
   es motivo de rechazo automático en los pasos 03, 04, 05, 06, 07 y 08.
3. **Cada test nuevo tiene que demostrar que sabe fallar**, con la salida roja
   pegada en la bitácora. Es el chequeo más valioso del bucle.
4. **Sincroniza con `std::latch`, `std::barrier` o átomicos, nunca con
   `sleep`.**
5. **`cargo test -p libretracks-desktop` SIEMPRE falla** por enlazado, no es
   tuyo. Usa `cargo check --all-targets` y `npm --prefix apps/desktop run test`.

## Comandos

```
npm run test:native                    # tests del engine C++
cargo check --all-targets              # Rust, sin enlazar
npm --prefix apps/desktop run test     # tests del frontend
npm test                               # las 4 suites

cmake --build native/audio-engine-v2/build-bungee-on-ffmpeg --config Release
cmake --build native/audio-engine-v2/build-bungee-on-ffmpeg --config Release --target bench_render_callback
```

El build con Bungee activo necesita `-DLT_ENGINE_USE_BUNGEE=ON` y
`-DLT_BUNGEE_DIR=<release desempaquetado>`. **Si falta esa carpeta el engine
compila con el warp mudo y no es un bug de código** (ver
`project_bungee_dir_missing_breaks_warp`).

## Qué haces tú

- Lanzar BUILDER y REVIEWER alternándolos, **cada uno en una sesión limpia**.
  La memoria entre vueltas es `state/NN.md`, no el contexto del chat: si
  arrastras el contexto, el REVIEWER hereda las suposiciones del BUILDER y deja
  de ser un control independiente.
- Leer `state/NN.md` entre vueltas.
- Verificar los criterios `PENDIENTE-HUMANO` (escucha real, portátil modesto).
- Cortar el bucle a las 3 vueltas sin aprobación.
- Hacer el commit cuando un paso quede aprobado.
