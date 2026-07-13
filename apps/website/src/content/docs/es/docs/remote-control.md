---
title: Remote Personalizable
description: Conexión desde móvil o tablet, layouts por dispositivo, widgets y edición táctil de la superficie Remote.
---

El **Remote** es una superficie web local que controla el mismo transporte, mezcla y configuración de directo que LibreTracks Desktop. El navegador no reproduce audio: todos los cambios se envían al equipo principal, donde los resuelve el motor de la sesión.

## Conectar Un Dispositivo

1. Abre `Remote` en LibreTracks Desktop.
2. Conecta el ordenador y el móvil o tablet a la misma red local.
3. Escanea el código QR o abre una de las direcciones que muestra Desktop.
4. Mantén LibreTracks y el servidor Remote abiertos durante el ensayo o show.

Si el dispositivo no conecta, comprueba que la red permite comunicación entre clientes y que el firewall del ordenador no está bloqueando LibreTracks.

![Panel de conexión Remote](/screenshots/Remote.png)

## Layouts Adaptados Al Dispositivo

La primera apertura utiliza un layout diferente para teléfono, tablet o pantalla grande. El nivel de interfaz inicial es **1**; los botones `-` y `+` cambian el tamaño visual sin modificar las posiciones guardadas.

El layout predeterminado contiene tres pestañas:

- **Controles**: información de reproducción, transporte, timeline, Vamp/saltos/transición y marcas.
- **Mixer**: mezclador completo con filtro de canción, master de canción y faders.
- **Herramientas**: configuración de metrónomo, guía de voz y Pads ambientales.

Los presets móviles reducen la altura del timeline y del transporte, dejan las marcas visibles antes de necesitar scroll y apilan las herramientas para que sigan siendo táctiles. En tablet se aprovecha el ancho disponible con paneles y columnas más compactos.

## Editar El Layout

Pulsa **Editar layout** para abrir una cuadrícula absoluta de 24 columnas al estilo Mixing Station. La superficie de edición representa el área real donde quedarán los widgets.

- Arrastra un widget por su cabecera para moverlo.
- Arrastra el tirador de la esquina inferior derecha para cambiar ancho y alto.
- Al arrastrar un widget nuevo desde el panel se muestra el rectángulo completo que ocupará antes de soltarlo. En móvil y tablet se usa Pointer Events, así que el gesto es un arrastre táctil real.
- Pulsa **Quitar** en la cabecera de edición para eliminar una instancia.
- Usa **Ocultar widgets** cuando el panel de componentes tape el tirador de algo colocado debajo.
- Añade, renombra o elimina pestañas para separar controles por función.

El panel de widgets está organizado en **Información**, **Transporte**, **Control en directo**, **Canciones**, **Mezclador** y **Herramientas**.

Al terminar:

- **Listo** conserva y aplica la geometría editada.
- **Cancelar** restaura todo lo que había al entrar en edición.
- **Exportar** descarga el layout como JSON para llevarlo a otro navegador o dispositivo.
- **Importar** valida y carga un layout exportado, incluidos layouts antiguos compatibles.
- **Restaurar layout** vuelve al preset adecuado para el dispositivo actual.

El layout se guarda en el almacenamiento local de ese navegador. Exporta una copia si quieres reutilizarlo en otro móvil o si vas a borrar los datos del navegador.

## Widgets Disponibles

Puedes usar widgets completos o dividir una sección en controles independientes:

- Lecturas completas o individuales de tiempo, compás/beat, BPM, compás musical y canción.
- Transporte completo o botones separados de reproducir, pausa, detener, click y guía.
- Timeline centrado, panel de control completo o paneles separados de Vamp, salto, transición y canción/transposición.
- Rejilla de marcas, siguiente sección/canción, tonalidad y contadores de progreso.
- Mixer completo o widgets separados de filtro de canción, master y faders.
- Vista compacta de canciones y clips, con selector **Activa/Todas**. Cuando hay ancho, las canciones se distribuyen en varias columnas.
- Pads ambientales, configuración del metrónomo y configuración de la guía de voz.

Los widgets ajustan contenido, tipografía, columnas y scroll interno a su rectángulo. Una caja pequeña no intenta comprimir todas las marcas o todos los controles hasta hacerlos ilegibles: las zonas largas usan scroll propio.

## Herramientas De Directo

Desde el Remote se puede cambiar:

- **Metrónomo**: estado, volumen, salida, acento, sonidos y tonos de acento/pulso, subdivisión y su nivel.
- **Guía de voz**: estado, volumen, salida, idioma, compases de antelación y cuenta de entrada.
- **Pads**: estado, pack instalado, tonalidad, volumen y routing.

Los packs se instalan y administran desde Desktop; el Remote muestra los packs completos disponibles en el equipo principal. Consulta [Pads de ambiente](/es/docs/ambient-pads/) para el comportamiento de reproducción y automatización.

## Recomendaciones Para El Show

- Diseña y prueba el layout con la misma orientación y nivel de interfaz que usarás en directo.
- Evita depender de scroll de página para los controles esenciales; deja scroll interno para marcas, faders o herramientas secundarias.
- Exporta el layout definitivo antes del show.
- Mantén el equipo Desktop conectado por cable a la red cuando sea posible y usa una Wi-Fi dedicada o estable para el dispositivo Remote.
