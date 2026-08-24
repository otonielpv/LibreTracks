---
title: Vista Live
description: "Vista Live de LibreTracks: las marcas de la canción como botones grandes, repertorio siempre visible, ajustes de salto y vamp a un toque, en PC, tablet y móvil."
---

La **Vista Live** es la tercera proyección del mismo proyecto, pensada para el momento de tocar. No edita nada: muestra en grande lo único que necesitas sobre el escenario — a dónde puedes saltar, qué está sonando ahora y qué viene después.

![Vista Live en escritorio](/screenshots/Live-View.png)

Cambia de vista con los tres botones de la barra (`view_timeline` para la vista DAW, `view_module` para la Vista Compacta y `stadium` para la Vista Live) o rotando entre ellas con `Tab`; `Shift+Tab` rota en sentido contrario.

## Zonas De La Vista Live

### Cabecera

Muestra la canción que está sonando con su tiempo transcurrido, su BPM efectivo y su tonalidad, de un vistazo y a tamaño legible desde lejos.

### Ajustes de directo

Los tres ajustes que se cambian sobre la marcha están siempre visibles, sin menús:

- `Salto de marca`: `Inmediato`, `Tras compases` (con su número) o `Siguiente marca`.
- `Salto de canción`: `Inmediato`, `Final de canción`, `Tras compases` o `Siguiente marca`, con la transición en `Limpio` o `Fade`.
- `Tipo de vamp`: repetir la `Sección` actual o un número de `Compases`, con el botón `VAMP` al lado para entrar y salir del bucle.

Son los mismos ajustes de [Control en vivo](/es/docs/live-control-flow/): cambiarlos aquí los cambia en toda la app.

### Marcas del directo

Cada marca de la canción seleccionada es un botón grande y numerado, con el color que le hayas dado en el timeline y el tiempo desde el inicio de la canción. Tocarlo programa el salto según el modo configurado. Además:

- La marca que está sonando se resalta como `Ahora` y lleva una barra de progreso propia.
- La siguiente muestra la cuenta atrás `Siguiente en m:ss`.
- Un salto ya programado se marca como `En cola`, y `Cancelar salto` lo anula mientras no se haya ejecutado.
- Las marcas de aviso aparecen como `Aviso` junto a la sección en la que caen, para leer la indicación sin buscarla.
- Con el vamp activo, la marca que se está repitiendo lleva su propia insignia `VAMP`.
- La lista se desplaza sola para mantener a la vista la marca que suena.

### Repertorio

La columna de repertorio muestra la canción actual con su progreso y el tiempo que queda, y debajo el resto de canciones de la sesión con su botón de play. Seleccionar una canción muestra sus marcas sin saltar a ella, así puedes preparar el siguiente tema mientras suena el actual.

## En Móvil Y Tablet

La Vista Live se adapta a la pantalla: en escritorio y tablet las marcas se reparten en tres columnas con el repertorio al lado, y en un móvil pasan a dos columnas con el repertorio abajo, siempre accesible.

![Vista Live en un móvil](/screenshots/Live-View-Phone.png)
