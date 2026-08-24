# Protocolo de medición

Para que dos personas (o la misma en dos momentos) midan **lo mismo**. Todas
las cifras del plan salen de aquí.

## Regla que lo gobierna todo: el build de MEDICIÓN

```
npm run profile:desktop:native
```

Deja el ejecutable en `target-desktop-native/debug/LibreTracks.exe` (y el
instalador correspondiente en `target-desktop-native/debug/bundle/`).

### Por qué ese build y no `build:desktop:native`

Lo que invalidó una medición anterior en este repo fue el **frontend** en modo
desarrollo: React dev, Vite/HMR y el propio HUD midiendo produjeron picos de
`worstFrameMs` de 90-200 ms y un p99 de IPC de ~120 ms que no existían en
producción (`docs/REDESIGN_transport_refs_to_stores.md`, «Nota metodológica»).

`profile` = `tauri build --debug`, es decir:

| Capa | Configuración | Efecto |
| --- | --- | --- |
| Frontend | bundle de **producción** | mata los artefactos documentados |
| Engine C++ | **Release** | el audio se comporta como en producción |
| Binario Rust | debug | **el HUD y DevTools existen** |

La última fila no es un capricho: `is_debug_build()` es
`cfg!(debug_assertions)`, y el PerfHud sólo se monta cuando eso es true. En un
build de release **el HUD no existe**, y además Tauri 2 sólo habilita DevTools
en debug (la feature `devtools` no está activada en `Cargo.toml`), así que
tampoco habría consola para `__lt_perf.plan()`. Un `build:desktop:native` no
puede medir nada de este plan.

### Lo que ese build deja pesimista

Los tiempos de **IPC del lado Rust** (`ipcByCommand`, `editCommitMs`) salen más
altos que en producción, porque el binario de Rust va en debug. Dos
consecuencias:

- **Compara siempre profile contra profile.** Un antes en profile y un después
  en release no se pueden comparar.
- **No uses los números absolutos de IPC para afirmar nada sobre producción**,
  sólo las diferencias relativas antes/después.

Las métricas de frontend — `renders` por gesto, `gridBuilds`, tiles, fps,
`worstFrameMs` — **no** se ven afectadas: no dependen del perfil de Rust.

Si algún día hace falta el número absoluto real, hay que decidir a propósito si
el HUD se desbloquea en builds de release. Es una decisión de producto, no de
este plan.

### Comprobación antes de anotar nada

Pulsa `Ctrl+Shift+F`. Si no aparece el recuadro arriba a la izquierda, **no
estás midiendo cero: no estás midiendo.** Revisa que arrancaste el binario de
`target-desktop-native/debug/` y no otro.

## Las dos sesiones de referencia

### S1 — sesión real de capturas

3 canciones, 57 marcas. Es la que representa el uso normal.

**Usa siempre una copia**, y mata el proceso que deja el puerto 3030 ocupado
antes de abrirla.

### S2 — setlist grande, generado

20 canciones × 25 pistas = 500 clips, 240 marcas, 80 min. Es la que hace
visibles las causas que escalan con el tamaño del proyecto (C4 y C6).

```
node scripts/generate-perf-session.mjs --out samples/perf-setlist
```

Escribe ~170 MB en `samples/perf-setlist/` (4 fuentes WAV reutilizadas por los
500 clips). Parámetros: `--songs`, `--tracks`, `--song-seconds`, `--markers`,
`--sources`.

**Ábrela una vez, cierra, y vuelve a abrirla antes de medir.** La primera
apertura genera los `.ltpeaks` y prepara las fuentes; medir eso mide el import,
no la UI.

## Los seis gestos

Cada uno **5 repeticiones**, primero con el transporte **parado** y luego
**reproduciendo**. Entre gesto y gesto: `__lt_perf.clear()` en la consola, para
que las medianas no arrastren el gesto anterior.

| # | Gesto | Qué causa aísla |
| --- | --- | --- |
| **G1** | Arrastrar la 2ª canción 8 compases a la derecha y soltar | C1 + C2 (síntoma 1) |
| **G2** | Arrastrar una marca de sección 4 compases | C1 |
| **G3** | Rueda de zoom de zoom 1 a zoom 16, en un movimiento continuo | C4 + C6 (síntoma 2) |
| **G4** | Rueda de zoom cruzando **un solo** paso de 1,5× | C4a aislada — el trabe puntual |
| **G5** | Pan horizontal de 10 s de timeline | C6 |
| **G6** | Arrastrar un clip, con y sin Ctrl (imán) | C1 (el caso del imán) |

### Cómo acertar con G4

Los pasos de caché de tile caen en `1,5^n` píxeles por segundo. Con
`BASE_PIXELS_PER_SECOND = 18`, los límites están en zoom ≈ 0,06 · 1,5^n. En la
práctica: haz zoom **un notch de rueda cada vez** y mira `tiles:` en el HUD. El
notch en el que el contador salta de golpe (decenas de tiles en un frame) es el
cruce. Ése es G4; repítelo 5 veces.

Si el contador **nunca** salta, dilo: la hipótesis C4a está muerta y el paso 04
pierde su justificación. Es un resultado válido y hay que anotarlo.

## Qué leer

Durante el gesto, el HUD muestra en directo:

```
tiles: 128 · 41.2 ms/s · peor 0.84 ms     ← C4: coste de rasterizar
tile cache: 312 · 305 MiB (pico 318)       ← C4d: el techo de 320 MiB
grid builds: 47 · 9600 entradas            ← C6: ¿sube con cada render?
region-move: 61 renders / 63 moves · 0 tiles   ← C1: OBJETIVO = 0 renders
commit region-move: 380 ms                 ← C2: lo que percibe el usuario
```

El color de la línea del gesto es el semáforo del paso 02: **verde = 0
renders**.

Después de las 5 repeticiones, en la consola de DevTools:

```js
__lt_perf.brief()       // ← LAS TRES TABLAS EN TEXTO, un par de KB. Esto es lo que se pega.
__lt_perf.plan()        // las mismas, como console.table (no se puede copiar)
__lt_perf.download()    // JSON completo (~100 KB; se corta al pegarlo en un chat)
__lt_perf.clear()       // reset entre gestos
```

**Usa `brief()` para compartir.** Las dos primeras mediciones reales se pegaron
con `download()` y se cortaron por longitud justo en las tablas, que es lo único
que responde a las preguntas del plan. El payload de `download()` ya pone los
resúmenes delante por si acaso, pero `brief()` es la vía buena.

`__lt_perf.plan()` imprime cuatro tablas:

1. **gestos** — medianas de `moves`, `RENDERS`, `tiles` por tipo de gesto.
2. **editCommitMs** — mediana y peor caso de soltar→ver, por tipo.
3. **IPC por comando** — ordenado por **coste total** (llamadas × media), no por
   coste unitario. Aquí se ve si `get_song_view` se llama tras cada edición.
4. **rejilla / tiles / caché** — los gauges de C4 y C6.

## Dónde va el resultado

`__lt_perf.download()` copia al portapapeles un JSON que ya incluye el contexto
de la máquina (user agent, DPR, viewport, núcleos, si es build de desarrollo).
Guárdalo como `docs/plans/ui-performance/baseline.json` y **commitéalo**.

Un `baseline.json` con `"isDevBuild": true` no vale. El propio fichero lo dice.

## Interpretación mínima

| Observación | Lectura |
| --- | --- |
| `region-move` con renders ≈ moves | C1 confirmada: un render por movimiento de puntero |
| `region-move` con 0 renders | C1 arreglada (o el gesto no se detectó — comprueba que `moves > 0`) |
| `commit region-move` de cientos de ms | C2 confirmada |
| `get_song_view` con tantas llamadas como ediciones | C2 confirmada por el otro lado |
| `grid builds` subiendo al ritmo de `renderCounts` | C6 confirmada |
| `tile cache` acercándose a 320 MiB | C4d confirmada |
| Un frame de G4 con `tiles` saltando decenas | C4a+C4b confirmadas: el trabe es la rasterización en el frame |
