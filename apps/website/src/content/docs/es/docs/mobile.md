---
title: LibreTracks en el móvil
description: "Lo que cambia en LibreTracks para Android: dónde guardar las sesiones (memoria interna, tarjeta SD o pendrive OTG), importar audio sin copiarlo, gestos táctiles, botón atrás y salida de audio."
---

LibreTracks para Android es la misma aplicación que la de escritorio: mismo
motor de audio, mismo formato de sesión y las mismas vistas DAW, Compacta y
Live. Una sesión montada en el ordenador se abre tal cual en el móvil, y al
revés.

Lo que cambia es lo que en un teléfono tiene que funcionar de otra manera: el
almacenamiento, el dedo en vez del ratón y la salida de audio. Esta página
recoge esas diferencias. Los mínimos de hardware y de espacio están en
[Requisitos del sistema](/es/docs/system-requirements/#android).

## Pantalla de inicio

Al abrir la app ves **Tus sesiones**, la lista de sesiones guardadas en el
dispositivo. Desde ahí creas una sesión nueva, abres una existente o importas un
`.ltset` o un `.ltpkg`. El icono de la papelera borra una sesión del
dispositivo, con su audio y su caché. La sesión que tienes abierta no se puede
borrar.

La **Canción de demostración** abre una sesión de ejemplo con cuatro pistas que
viene dentro de la app, para probar el transporte, la mezcla y los saltos sin
tener que importar nada. Siempre abre la misma sesión: pulsarla varias veces no
crea copias.

## Dónde se guardan las sesiones

Si el móvil tiene una **tarjeta microSD**, o conectas un **pendrive o un disco
por USB (OTG)**, puedes guardar las sesiones ahí en lugar de en la memoria
interna. Se elige en `Configuración > General > Dónde guardar las sesiones`.

- La lista muestra cada volumen con el nombre que le da Android (por ejemplo
  «Tarjeta SD SanDisk» o «Unidad USB») y el espacio libre que le queda. Si
  el móvil solo tiene memoria interna, el ajuste no aparece.
- **Solo afecta a las sesiones nuevas.** Las que ya tienes se siguen abriendo
  desde donde están, y aparecen todas juntas en «Tus sesiones», estén en el
  volumen que estén.
- **La caché de audio va con las sesiones.** Es lo que más ocupa, así que
  cuando eliges la tarjeta, la caché también se guarda en ella y no llena la
  memoria interna.
- Si **quitas la tarjeta o el pendrive**, LibreTracks lo detecta en el momento:
  avisa en Ajustes y guarda las sesiones nuevas en la memoria interna hasta que
  vuelvas a conectarlo. Al montarlo de nuevo, la lista de volúmenes y «Tus
  sesiones» se actualizan solas, sin reiniciar la app.

LibreTracks guarda las sesiones en la carpeta propia de la app dentro de cada
volumen, así que no pide ningún permiso de almacenamiento.

:::caution[Pendrives y tarjetas]
Espera a que termine de guardar antes de quitar un pendrive. Si se desconecta a
mitad, la sesión se queda como en el último guardado completo y no se pierde,
pero los cambios que no se llegaron a guardar sí se pierden.
:::

## Importar audio sin copiarlo

Al importar audio a la biblioteca, lo normal en Android es copiarlo dentro de la
sesión. Con `Configuración > General > Importar sin copiar el audio a la sesión`
activado, la sesión **usa tus archivos originales** en vez de duplicarlos, como
en el escritorio. Así un multitrack ocupa en el teléfono lo que ocupan sus
archivos y nada más.

- Si mueves o borras un archivo original, la pista deja de sonar y el archivo
  aparece en **Archivos que faltan**, desde donde puedes volver a enlazarlo.
- Los archivos que están en la nube (Google Drive o «Recientes» del selector,
  por ejemplo) no se pueden leer directamente. Esos se siguen copiando
  aunque el ajuste esté activado.
- Borrar una pista o una sesión **nunca** borra tus archivos originales: solo
  se borra lo que está dentro de la carpeta de la sesión.

Al importar varios audios, cada uno aparece en la biblioteca en cuanto empieza a
copiarse, con su progreso, sin esperar a que termine el lote entero.

## Gestos en la línea de tiempo

En el ordenador se usa el ratón y el clic derecho. En el móvil funciona así:

| Gesto | Qué hace |
| --- | --- |
| **Un dedo** | Desplaza en cualquier dirección: izquierda y derecha avanzan o retroceden en el tiempo, arriba y abajo recorren las pistas. |
| **Pellizcar con dos dedos** | Solo hace zoom. |
| **Tocar** | Selecciona lo que hay debajo: un clip, una marca, una pista o una canción. Si tocas un hueco, se quita la selección. |
| **Arrastrar algo ya seleccionado** | Lo mueve. Primero lo tocas y después lo arrastras, así un gesto sin querer no mueve el audio. |
| **Mantener pulsado** | Abre el menú contextual en el punto exacto donde pusiste el dedo. |

No hay modos de navegar y editar que ir cambiando: todo depende de si lo que
arrastras estaba seleccionado.

### La barra de acciones

En el ordenador las acciones salen con el clic derecho. En el móvil salen en una
barra flotante encima del timeline. Cuando tocas algo, la barra enseña lo que
puedes hacer con ello, y sin nada seleccionado te ofrece crear una marca, una
canción o una pista. Si hay más acciones de las que caben, el botón de puntos
abre la lista entera. Con la flecha recoges la barra para ver más timeline.

Con **varias pistas seleccionadas**, la barra incluye un botón de mezcla que
cambia de una vez el volumen, el paneo, la salida y la transposición de todas.
El volumen y el paneo se mueven en relativo y conservan la mezcla que ya había
entre ellas.

### Pistas y carpetas

Arrastrar una pista en el móvil **solo cambia su orden**. Para meter pistas en
una carpeta, selecciónalas y elige **Mover a carpeta…** en su menú, a una
carpeta que ya exista o a una nueva. Para sacarlas, usa **Sacar de la carpeta**.
Así no hace falta acertar con el dedo en el centro de la fila de la carpeta.

## El botón atrás

El botón atrás de Android **cierra primero lo que tengas abierto**, como un
ajuste, un menú o un panel, en vez de salir de la app. Si no hay nada abierto
y se está reproduciendo, el primer toque avisa («Pulsa atrás otra vez para
salir») y hace falta un segundo toque para salir, así no cortas un ensayo sin
querer.

## Salida de audio

En `Configuración > Audio` eliges la salida. Si conectas una **interfaz de audio
por USB**, aparece ahí con sus canales, y se enruta igual que en el escritorio
(ver [Salidas de audio y metrónomo](/es/docs/audio-routing-metronome/)).
Android solo tiene un sistema de audio, así que no hay selector de backend como
ASIO o WASAPI.

- **Por defecto**, LibreTracks usa la salida de reproducción normal de
  Android. Por eso se oyen los ajustes de sonido del sistema, como Dolby
  Atmos, el ecualizador o el efecto envolvente, igual que en cualquier
  reproductor de música. Si no los quieres, apágalos en los ajustes de sonido
  de Android.
- **Baja latencia** usa la salida rápida de Android. Reduce el retardo, sobre
  todo con interfaces USB, pero no aplica los efectos del sistema y en móviles
  modestos puede dar cortes. Actívalo si tocas en directo sobre las pistas y
  notas el retardo.

## Caché de audio

Los audios que no son WAV (MP3, FLAC…) se decodifican una sola vez y se guardan
en la caché, para que la próxima vez carguen al instante. En el móvil la carpeta
de la caché no se puede cambiar: va siempre con el volumen donde guardas las
sesiones (ver arriba). Desde `Configuración` puedes ver cuánto ocupa, ponerle un
límite y vaciarla.

## Pasar sesiones del ordenador al móvil

Lo más cómodo es montar la sesión en el ordenador y llevarla al móvil:

- **Exportar la sesión como `.ltset`** y abrirla desde «Tus sesiones». En
  un móvil modesto, el modo **Optimizado** lleva el audio ya preparado y se
  salta la decodificación al abrir. Más detalles en
  [Requisitos del sistema](/es/docs/system-requirements/#cómo-cargar-antes-una-sesión-grande).
- **Por Google Drive**: al exportar o importar, LibreTracks pregunta si quieres
  usar el dispositivo o tu cuenta de Drive. Los archivos se guardan en tu
  propio Drive, no en ningún servidor de LibreTracks, y la app solo ve los
  archivos que ha creado ella.
