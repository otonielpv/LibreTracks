# La vista DAW en móvil y tablet

LibreTracks nació como un port directo de la app de escritorio. La vista DAW
funciona bien con ratón y pantalla ancha, pero en un teléfono deja de tener
sentido: los gestos no responden como esperas, la estructura de la canción no
se ve, y **toda la gramática de edición vive detrás del clic derecho**, que en
táctil es un menú invisible para quien no conoce ya la aplicación.

El objetivo no es hacer accesible lo que hay. Es **que alguien que abre la app
por primera vez en un móvil pueda montar una canción de cero**. Si ese recorrido
es sencillo, editar una canción que traes del PC sale gratis.

## Estado

| | |
|---|---|
| **Punto de montaje** | La vista **DAW**. Compacta es para quien no quiere marcas: añadir audios y tocar. La DAW se nutre de las marcas. |
| **Usuario objetivo** | El que monta de cero en el móvil. El que edita algo ya montado es un caso derivado. |
| **Orientación** | Android fija `sensorLandscape` (`AndroidManifest.xml`). iOS sin verificar: `gen/apple` no está generado en este checkout. |

## Los dos planes

- **[PLAN-A-daw-tactil.md](PLAN-A-daw-tactil.md) — elegido.** Mantiene los
  carriles y hace táctil la vista DAW: estado vacío que propone el primer paso,
  acciones visibles al seleccionar, ajustes de directo agrupados pero
  accesibles, cabeceras de pista finas.

- **[PLAN-B-estructura-y-lista.md](PLAN-B-estructura-y-lista.md) — aparcado.**
  Sustituye los carriles por una onda de la canción arriba y las pistas como
  lista abajo. Aparcado, no descartado: se retoma si el Plan A no convence tras
  probarlo con usuarios. Tiene un requisito bloqueante (una onda sumada que hoy
  no existe) descrito en su propio documento.

## Lo ya entregado (base de ambos planes)

Estos tres commits arreglan problemas reales y sirven para cualquiera de los dos
caminos:

- `e227d1b0` — **El snap ajustaba a una rejilla que no se dibuja.** Es la causa
  del síntoma "dejas pulsado en un sitio y la marca aparece en otra":
  `snapToTimelineGrid` ignoraba la escala y ajustaba siempre al beat, mientras
  la rejilla sólo dibuja beats si miden ≥16 px. Unificado en
  `timelineGridResolution`.
- `3616ef27` — **Un dedo navega en ambos ejes; tocar selecciona; arrastrar lo ya
  seleccionado lo mueve.** Sustituye al modo navegar/editar. Editar es
  deliberado sin que haya modos que recordar.
- `c130ef77` — Barra de acciones de la selección y botón de marca en el cabezal.
  Es la semilla del paso 2 del Plan A, no la solución.

Y un cuarto, sin commitear al escribir esto: los menús contextuales del timeline
se pintan como hoja inferior en móvil (`is-mobile-sheet`), igual que ya hacía
`LibrarySidebarPanel`. El menú de tipos de marca tiene 35 entradas y anclado al
dedo se salía de la pantalla.

## Qué NO resuelve ninguno de los dos planes

La **fluidez real de los gestos** sigue sin medirse. El emulador con ratón no
la demuestra, y menos por traducción ARM. Hasta que no se pruebe en un
dispositivo modesto no se puede afirmar que el problema original esté resuelto.
Ver la batería de pruebas en `../mobile-authoring-research.md`.
