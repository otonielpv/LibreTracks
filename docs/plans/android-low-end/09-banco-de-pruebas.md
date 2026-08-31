# 09 — Banco de pruebas en dispositivo real

**Depende de:** idealmente 01-08, pero **el script base debe escribirse el
primero** para poder medir el «antes».
**Toca:** `scripts/`, `docs/testing.md`.
**Riesgo:** ninguno (herramienta, no producto).

## Problema

Todo este plan afirma que el rendimiento en móviles modestos mejora. Sin una
medición repetible, esas afirmaciones no valen nada — y hay precedente en este
proyecto de teorizar antes de medir y equivocarse (el «tembleque» del playhead
resultó ser el redondeo de la rejilla, no la cámara).

Además, los criterios de aceptación de los pasos 02, 04, 06 y 07 **exigen cifras
en el dispositivo**. Esto es la herramienta que las produce.

## Cambio pedido

### 1. Script de medición

`scripts/android-bench.ps1` (o `.mjs`), que con el dispositivo conectado por adb:

1. Registre el perfil: modelo, RAM total/disponible, disco libre, núcleos.
2. Limpie el estado: `pm clear` opcional, purgue la caché de fuentes.
3. Lance la app y ejecute un escenario.
4. Muestree cada segundo, durante la operación:
   - RSS del proceso (`dumpsys meminfo com.libretracks.app`)
   - `MemAvailable` del sistema
   - Bytes escritos por el proceso (`/proc/<pid>/io`, campo `write_bytes`)
   - Cualquier `am_kill` en logcat
5. Emita un JSON + un resumen legible.

### 2. Escenarios

| Id | Escenario | Métrica principal |
| --- | --- | --- |
| `import-full` | Importar el `.ltset` Completo de 2 GB | Bytes escritos, tiempo, pico RSS, kills |
| `import-optimized` | El mismo set exportado como Optimizado (paso 06) | Tiempo hasta «listo», bytes escritos |
| `open-prepared` | Abrir una sesión ya importada | Tiempo hasta «listo» |
| `playback-8` | Reproducir 8 pistas 60 s | Cortes de audio, `[LT_STARVATION]` |
| `pressure` | Provocar presión con otra app durante la carga | Que la app sobreviva |

### 3. Línea base ANTES de tocar nada

Ejecutar los escenarios contra el build actual y guardar el resultado como
`docs/plans/android-low-end/baseline-CPH1931.json`. **Es el número contra el que
se compara todo lo demás.**

Nota honesta: `import-full` en el estado actual **puede reiniciar el teléfono**.
Ejecútalo sabiendo eso, con el dispositivo sin nada importante abierto, y si el
sistema muere, ese es el resultado a registrar (`outcome: "system_restart"`).

### 4. Criterio de éxito global del plan

Al terminar los pasos 01-08, sobre el Oppo CPH1931:

- `import-full` **completa sin reiniciar el sistema** y sin `am_kill` en cascada.
- Bytes escritos en `import-full` bajan **≈2 GB** (paso 04).
- Pico de `ram_bytes_used` del motor **< 64 MB** (paso 02).
- `import-optimized` llega a «listo para reproducir` **sin escribir caché PCM**
  (paso 06).
- `playback-8` sin cortes audibles.

## Criterios de aceptación

- [ ] El script corre en Windows con el dispositivo por USB y produce JSON +
      resumen.
- [ ] Falla con un mensaje claro si no hay dispositivo o no está autorizado.
- [ ] No requiere root (todo con `dumpsys`, `/proc/<pid>/io` del propio proceso y
      `logcat`).
- [ ] `baseline-CPH1931.json` está commiteado con los números del build actual.
- [ ] Documentado en `docs/testing.md`: cómo ejecutarlo y cómo leer la salida.
- [ ] Los cinco escenarios están implementados; los que requieran interacción de
      UI pueden pedir un paso manual, pero deben decir **exactamente** qué tocar.

## Notas para el implementador

- No intentes automatizar el SAF picker. Pide el paso manual y mide desde que la
  operación arranca.
- No conviertas esto en un test de CI: no hay dispositivo en el runner, y hay
  precedente doloroso en el repo de tests que dependen de temporización y tumban
  releases. **Esta herramienta es para ejecutar a mano y leer con criterio.**
