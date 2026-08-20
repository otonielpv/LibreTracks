# Plan: LibreTracks en Android de gama baja

Origen: el 2026-08-20 el Oppo CPH1931 (2,58 GB de RAM) **reinició el sistema**
al importar un `.ltset` de 2,02 GiB. Diagnóstico completo con evidencia de
`adb logcat` en [`00-DIAGNOSTICO.md`](00-DIAGNOSTICO.md).

## Pasos

| # | Paso | Depende de | Riesgo | Impacto |
| --- | --- | --- | --- | --- |
| [01](01-perfil-de-dispositivo.md) | Perfil de dispositivo (RAM disponible, no física) | — | bajo | base |
| [02](02-presupuestos-moviles.md) | Presupuestos de caché/hilos/disco en móvil | 01 | medio | **alto** |
| [03](03-presion-de-memoria.md) | Reaccionar a `onTrimMemory` | 02 | medio-alto | alto |
| [04](04-import-sin-staging.md) | Import sin copia de staging | — | medio | **el más alto** |
| [05](05-extraccion-amable.md) | Extracción amable con el FS | 04 | bajo | medio |
| [06](06-export-optimizado.md) | Modo de export «Optimizado» | 04, 05 | medio | **alto** |
| [07](07-preflight-de-viabilidad.md) | Preflight y aviso al usuario | 01, 05 | bajo | alto (UX) |
| [08](08-diagnostico-en-dispositivo.md) | Diagnóstico sin cable | 01 | bajo | medio |
| [09](09-banco-de-pruebas.md) | Banco de pruebas en dispositivo | — | ninguno | base |

## Orden recomendado

```
09 (baseline)  →  01  →  02  →  03
                   ↓
                  07
04  →  05  →  06
08 (cuando esté 01)
```

**Empieza por 09**: sin línea base no se puede demostrar ninguna mejora.

Los caminos `01→02→03` (memoria) y `04→05→06` (I/O y paquetes) son
independientes entre sí y pueden llevarse en paralelo por dos agentes distintos.

## Reglas que aplican a todos los pasos

1. **Regresión cero en escritorio.** Windows/macOS/Linux no deben cambiar de
   comportamiento salvo que el paso lo diga explícitamente. Varios pasos tienen
   un criterio de aceptación dedicado a esto.
2. **Medir en el dispositivo real.** Las afirmaciones de rendimiento van con
   cifras del Oppo o no van.
3. **No tests que dependan de temporización de hilos.** Hay precedente en este
   repo de dos releases tumbadas por eso.
4. **Verifica que un test de regresión sabe fallar** antes de darlo por bueno.
5. **`cargo check` de escritorio no compila el código `cfg(target_os="android")`.**
   Compila para Android antes de cerrar cualquier paso que lo toque.

## Harness de agentes

El bucle BUILDER/REVIEWER y cómo lanzarlo está en [`HARNESS.md`](HARNESS.md).

- **Claude Code**: `/builder NN` y `/reviewer NN` (skills en `.claude/skills/`).
- **Codex**: prompts pegables en [`prompts-codex.md`](prompts-codex.md).
- **Copilot**: `.github/prompts/*.prompt.md`.
