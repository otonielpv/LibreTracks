---
title: Pads De Ambiente
description: Instalación de packs, tonalidad, volumen, routing, transición continua y control mediante Remote y automatizaciones.
---

Los **Pads de ambiente** son camas de audio largas y sostenidas que pueden acompañar canciones, transiciones o momentos hablados. Funcionan como una voz global de directo, igual que el metrónomo y la guía: no son una pista del proyecto y su nivel no depende del master de la canción.

## Instalar Y Gestionar Packs

Abre **Pads** desde la barra superior de Desktop. Si todavía no hay contenido instalado, LibreTracks muestra el catálogo de packs disponibles.

1. Descarga el pack que quieras utilizar.
2. Espera a que termine su preparación; cada pack contiene audio para las 12 tonalidades.
3. Selecciona el pack y una tonalidad de C a B.
4. Activa el Pad y ajusta volumen y salida.

El apartado **Gestionar packs** permite descargar otros sonidos o eliminar los que ya no necesitas. Los packs no se incluyen dentro de las sesiones o exportaciones porque son recursos instalados para el usuario y pueden ocupar bastante espacio.

## Controles

- **Activar Pad**: inicia o silencia la voz ambiental con una rampa corta para evitar clicks.
- **Pack**: elige uno de los packs instalados completamente.
- **Tonalidad**: selecciona cualquiera de los 12 tonos cromáticos.
- **Volumen**: usa la misma escala musical en dB que el resto de faders de directo.
- **Salida**: envía el Pad a Master, Monitor o una salida física habilitada.

El Pad se mezcla aparte del master de canción. Esto permite bajar o cambiar de canción sin perder la cama ambiental, y enviarla a un bus diferente del playback si el montaje lo necesita.

## Cambios De Tono Y Pack Sin Cortes

LibreTracks prepara el nuevo audio fuera del hilo de reproducción mientras el Pad actual continúa sonando. Cuando está listo:

1. El nuevo Pad entra en la posición temporal equivalente del bucle, sin volver a reproducir el ataque inicial del archivo.
2. El Pad anterior y el nuevo se reproducen a la vez durante un crossfade corto de potencia constante.
3. Al terminar el cruce se libera el anterior.

El resultado se comporta como un cambio Legato: no existe el antiguo punto de silencio entre fade-out y fade-in. Si el archivo nuevo falta o no puede decodificarse, LibreTracks mantiene sonando el Pad anterior en lugar de cortar el ambiente.

## Control Desde Remote

El layout predeterminado del [Remote](/es/docs/remote-control/) incluye un widget de Pads en la pestaña **Herramientas**. Desde allí se puede activar, elegir pack y tonalidad, ajustar el volumen y cambiar el routing. El catálogo procede del equipo Desktop, por lo que la instalación o eliminación de packs se realiza allí.

También puedes colocar el widget en cualquier pestaña, redimensionarlo o crear una superficie dedicada únicamente a Pads y transiciones.

## Automatizar Pads

Añade una acción **Controlar Pads** dentro de una señal de [Automatización](/es/docs/automation/). La acción guarda el mismo estado que configurarías manualmente:

- Activado o desactivado.
- Pack instalado.
- Tonalidad.
- Volumen en la escala de fader/dB.
- Routing de salida.

Cuando la señal se dispara, el cambio de pack o tonalidad utiliza exactamente el mismo cargador, posición continua y crossfade que el control manual. Esto permite preparar modulaciones, cambiar de textura por sección o dejar listo el Pad de la siguiente canción sin una operación adicional durante el show.

## Preparación Para Directo

- Descarga y prueba todos los packs antes del show; no dependas de una descarga durante la actuación.
- Comprueba la salida del Pad por separado del click y de la guía.
- Ensaya las modulaciones y automatizaciones con el mismo pack y dispositivo de audio del directo.
- Mantén margen de nivel: durante el breve crossfade se solapan dos texturas.
