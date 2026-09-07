# Plan B — Estructura arriba, pistas como lista

**Estado: aparcado, no descartado.** Se retoma si el Plan A no convence tras
probarlo con usuarios reales. Este documento existe para que la idea no se
pierda y para dejar escrito qué la bloquea hoy.

## La tesis

En un móvil, **el lienzo de carriles sirve para lo que menos haces**.

Lo que realmente ocurre montando en LibreTracks:

| Tarea | Naturaleza | ¿Encaja en un lienzo de carriles? |
|---|---|---|
| Secciones, avisos, tempo, compás | Sobre el **tiempo de la canción** | No: es una sola línea temporal, no 16 |
| Volumen, mute/solo, salida, orden | Sobre una **lista de pistas** | No: una lista lo hace mejor |
| Mover clips libremente | Sobre un lienzo | Sí, pero es raro: los stems llegan alineados y se quedan |

Y la aritmética: al área de carriles le quedan ~650 px de alto tras cabeceras y
barras. Con 16 stems son ~40 px por pista, donde no se lee forma de onda ni se
apunta con el dedo. Alejar el zoom lo empeora. No es un fallo de maquetación:
son 16 cosas en una pantalla pequeña.

## La forma

```
┌───────────────────────────────────────────────────────────┐
│ ▸ ⏸ ■   Verso · 9.1.00 · 00:16.0             [Directo ▾]  │
├───────────────────────────────────────────────────────────┤
│ 1.1        5.1        9.1        13.1       17.1          │
│ ┃Intro      ┃Verso      ┃Estribillo                       │
│ ▁▂▃▅▇█▇▅▃▂▁▂▃▅▇█▇▅▃▂▁▂▃▅▇█▇▅▃▂▁▂▃▅▇█▇▅▃▂▁                 │  ← onda de la canción
├───────────────────────────────────────────────────────────┤
│ PISTAS (16)                                    [+ Audio]  │
│ ⠿ Batería    ────●───  M S   Salida 1-2               ▾   │
│ ⠿ Bajo       ──●─────  M S   Salida 1-2               ▾   │
│ ⠿ Click      ────●───  M S   Salida 3-4               ▾   │
├───────────────────────────────────────────────────────────┤
│  [+ Sección]   [+ Aviso]   [Tempo]   [Compás]             │
└───────────────────────────────────────────────────────────┘
```

- **Arriba, la estructura.** Una onda grande a ancho completo con las marcas
  encima. Es lo que hace falta para colocar una sección con precisión.
- **Abajo, las pistas como lista.** Nombre, fader, mute/solo, salida y asa de
  reordenar, todo a tamaño de dedo. Reordenar 16 pistas en una lista es
  trivial; en un lienzo es un suplicio.
- **Tocar una pista la expande** con sus controles finos y sus clips, para
  cuando de verdad haya que editar el clip.

## El requisito que lo bloquea

**No existe una onda sumada de la canción.** El cache es
`Record<string, WaveformSummaryDto>` **por archivo de audio**
(`hooks/useSongWaveforms.ts`).

Se descartó explícitamente usar **un stem como referencia**: sería engañoso,
porque la marca se coloca escuchando la mezcla, no el bajo. Una sección puede
empezar en un punto donde el stem elegido está en silencio.

Por tanto, retomar este plan exige antes:

1. **Calcular una onda de mezcla por canción**, sumando los stems con sus
   ganancias, y cachearla. Decidir dónde: en el motor C++ (que ya analiza picos,
   ver `analyze_file_peaks`) o en el frontend a partir de los `.ltpeaks`
   existentes.
2. **Invalidarla correctamente** cuando cambian volúmenes, mute/solo, se añaden
   o quitan clips, o cambia el warp/tono. Este es el punto delicado: una onda de
   mezcla obsoleta es peor que no tener onda, porque miente sobre dónde está la
   música.
3. Medir su coste. Ya hay antecedentes de congelaciones por análisis de picos
   (`analyze_file_peaks` medido en 6567 ms al añadir un multitrack).

## Por qué está aparcado y no descartado

El Plan A conserva el modelo mental de la DAW y es incremental: cada paso deja
la app mejor y ninguno es irreversible. Este plan es un rediseño de la vista, y
antes de pagarlo conviene comprobar si el Plan A ya resuelve el problema del
usuario del primer día.

Lo que haría reabrirlo:

- Que tras el Plan A un usuario nuevo **siga sin poder montar una canción** en
  un teléfono sin ayuda.
- Que colocar marcas con precisión siga siendo incómodo con los carriles, aun
  con cabeceras finas.
- Que aparezca la onda de mezcla por otro motivo (por ejemplo, para la vista
  Compacta), y el coste del requisito ya esté pagado.

## Compatibilidad con el Plan A

No son excluyentes. Los pasos 1, 2, 3, 4 y 6 del Plan A —estado vacío, barra de
la selección, marcas de primera clase, ajustes de directo agrupados, tempo y
compás— **valen igual en esta forma**. Lo único que este plan sustituye es el
paso 5: en vez de adelgazar las cabeceras de los carriles, cambia carriles por
lista.

Dicho de otro modo: hacer el Plan A no tira trabajo si luego se adopta el B.
