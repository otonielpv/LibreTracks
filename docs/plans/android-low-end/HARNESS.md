# Harness BUILDER / REVIEWER

Protocolo para implementar este plan con dos agentes, ejecutados a mano y en
bucle hasta que cada paso esté terminado. Funciona con **Claude Code** (skills
invocables) y con **Codex** (prompts pegables).

## Piezas

| Fichero | Qué es |
| --- | --- |
| `.claude/skills/builder/SKILL.md` | BUILDER (implementa) — **fuente de verdad** |
| `.claude/skills/reviewer/SKILL.md` | REVIEWER (juzga) — **fuente de verdad** |
| `prompts-codex.md` | Los mismos roles, como prompts pegables para Codex |
| `.github/prompts/*.prompt.md` | Los mismos roles, para Copilot en VS Code |
| `docs/plans/android-low-end/NN-*.md` | La tarea y sus criterios de aceptación |
| `docs/plans/android-low-end/state/NN.md` | Bitácora del paso (la crea el bucle) |

### Cómo se invocan

- **Claude Code**: `/builder 02` y `/reviewer 02`. Las skills de
  `.claude/skills/` se cargan solas al abrir el repo.
- **Codex**: **no tiene comandos `/`.** Copia el bloque entero de
  [`prompts-codex.md`](prompts-codex.md) y pégalo como primer mensaje. Escribir
  `/reviewer 09` solo hace que Codex se ponga a buscar qué significa eso.
- **Copilot en VS Code**: `/builder` y `/reviewer` (requiere
  `"chat.promptFiles": true`, ya en el `.vscode/settings.json` del repo).

Si editas el comportamiento de un agente, edítalo en `.claude/skills/` y
propaga el cambio a las otras dos copias.

## El bucle

```
                 ┌──────────────────────────────┐
                 │  BUILDER  paso 02            │
                 │  implementa o corrige        │
                 └───────────────┬──────────────┘
                                 │ escribe state/02.md (BUILD)
                                 ▼
                 ┌──────────────────────────────┐
                 │  REVIEWER paso 02            │
                 │  verifica criterio a criterio│
                 └───────────────┬──────────────┘
                                 │ escribe state/02.md (REVIEW)
                     ┌───────────┴───────────┐
                 APROBADO                CAMBIOS
                     │                       │
                     ▼                       └──► vuelve al BUILDER
                 siguiente paso
```

**Una iteración = una invocación de cada agente.** Tú lanzas cada una y lees la
salida. Si tras **3 vueltas** un paso no está aprobado, para el bucle: es señal
de que el paso está mal especificado, no de que el agente sea torpe. Revisa el
documento del paso.

## Contrato de estado

Ambos agentes escriben en `docs/plans/android-low-end/state/NN.md`, **añadiendo
al final, nunca sobrescribiendo**. Ese fichero es la memoria entre invocaciones:
el BUILDER lo lee para saber qué le pidió el REVIEWER.

Formato de una entrada:

```markdown
## [BUILD] iteración 2 — 2026-08-20T14:22Z

### Qué he cambiado
- `native/.../thread_policy.h`: añadido `lt_device_profile()`.

### Criterios que creo cumplidos
- [x] C1 — test `device_profile_desktop_parity` pasa
- [ ] C6 — pendiente, necesita dispositivo

### Comandos ejecutados
```
npm run test:native   → 214 passed
cargo check --all-targets → ok
```

### Bloqueos / dudas
Ninguno.
```

```markdown
## [REVIEW] iteración 2 — 2026-08-20T14:41Z

### Veredicto: CAMBIOS SOLICITADOS

### Verificación criterio a criterio
- [x] C1 — confirmado, he ejecutado el test
- [!] C3 — **el test no sabe fallar**: lo he roto a propósito
      (cambiando 512 por 999) y sigue pasando.
- [ ] C6 — requiere dispositivo, marcado como PENDIENTE-HUMANO

### Qué debe corregir el BUILDER
1. `device_profile_test.cpp:44` — el assert compara contra el valor
   calculado, no contra la constante esperada. Fíjalo a 512.
```

## Reglas del bucle

1. **El REVIEWER no escribe código de producción.** Solo juzga y, si acaso,
   arregla el propio test que está evaluando cuando el fallo sea del test.
2. **El REVIEWER ejecuta los comandos él mismo.** No se fía del informe del
   BUILDER. Si el BUILDER dice «214 passed», el REVIEWER lo corre.
3. **Los criterios que requieren el dispositivo se marcan `PENDIENTE-HUMANO`.**
   Ningún agente puede aprobarlos. Los verificas tú con
   `scripts/android-bench` (paso 09) y los marcas en el fichero de estado.
4. **Un paso solo se aprueba con todos los criterios en `[x]` o
   `PENDIENTE-HUMANO` resuelto por ti.**
5. **Un commit por paso aprobado**, en la rama actual (no crear ramas).

## Qué haces tú

- Lanzar BUILDER y REVIEWER alternándolos, **cada uno en una sesión limpia**
  (la memoria entre vueltas es `state/NN.md`, no el contexto del chat: si
  arrastras el contexto, el REVIEWER hereda las suposiciones del BUILDER y deja
  de ser un control independiente).
- Leer `state/NN.md` entre vueltas.
- Verificar los criterios `PENDIENTE-HUMANO` con el móvil conectado.
- Cortar el bucle a las 3 vueltas sin aprobación.
- Hacer el commit cuando un paso quede aprobado.
