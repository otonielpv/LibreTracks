---
title: Requisitos del sistema
description: Hardware mínimo y recomendado, sistemas operativos y configuración de audio en directo para usar LibreTracks.
---

LibreTracks es una app nativa ligera (Rust + Tauri), no un DAW de estudio pesado, así que funciona con soltura en equipos modestos. Las cifras de abajo son una guía práctica, no límites duros — el verdadero cuello de botella en directo es el pitch/warp en tiempo real, que escala con cuántas pistas transpones a la vez.

## Sistemas operativos

| Plataforma | Mínimo | Notas |
| --- | --- | --- |
| **Windows** | Windows 10 (64 bits) | Necesita el runtime **WebView2**, que viene preinstalado en Windows 10/11 actuales. |
| **macOS** | macOS 12 **Monterey** | Intel y Apple Silicon (app universal). |
| **Linux** | Ubuntu 22.04 / Fedora 36 o posterior | Requiere `webkit2gtk-4.1`, `gtk3` y ALSA. Se distribuye como `.deb`, `.rpm` y `.AppImage`. |

La AppImage usa WebKitGTK, GTK y Mesa del propio sistema, igual que los paquetes
`.deb` y `.rpm`. Esto evita mezclar controladores gráficos actuales con librerías
antiguas y mejora la compatibilidad con Bazzite, Arch y Fedora bajo Wayland.

> **¿Por qué macOS 12?** El motor de cambio de tono y warp (Bungee) y el reparto del audio entre núcleos necesitan funciones del sistema que llegaron con macOS 11 y 12. En versiones anteriores la app no arranca.

## iPhone y iPad

LibreTracks está en el **App Store** para iPhone y iPad con **iOS / iPadOS 15
o posterior**. Funciona en horizontal. Lo que cambia respecto al ordenador está
en [En el móvil y la tablet](/es/docs/interface/mobile/).

## Android

El soporte de Android es más reciente que las versiones de escritorio, y es en
los móviles donde primero se notan los límites — casi siempre en almacenamiento
y en paciencia, más que en memoria.
Lo que funciona distinto en el teléfono (guardar las sesiones en una tarjeta SD
o un pendrive, los gestos táctiles, la salida de audio) está en
[LibreTracks en el móvil](/es/docs/mobile/).

| | Mínimo | Cómodo | Notas |
| --- | --- | --- | --- |
| **Android** | 7.0 (API 24) | 10 o posterior | ARM de 64 bits (`arm64-v8a`); se instala desde Google Play |
| **RAM** | 2 GB | 3 GB+ | LibreTracks ajusta sus búferes al dispositivo |
| **Espacio libre** | 2x el tamaño de tu sesión | 3x | Importar descomprime la sesión y prepara su audio |

La reproducción va por streaming desde el almacenamiento, no cargando las
canciones en memoria, así que el número de pistas lo limita mucho más la
velocidad a la que el móvil lee y decodifica que la RAM que tenga. Un móvil de
2,5 GB mueve una sesión de 36 pistas; lo que no puede es importarla deprisa.

### Espacio durante la importación

Importar un `.ltset` necesita sitio para más que el propio archivo: el paquete
se descomprime y su audio se prepara para reproducirse. Cuenta con **el doble
del tamaño del paquete**, y deja un gigabyte de margen. Un set de 2 GB quiere
unos 5 GB libres.

LibreTracks rechaza una importación que claramente no cabe, en vez de llenar el
dispositivo y fallar a mitad.

### Cómo cargar antes una sesión grande

Importar un set grande en un móvil modesto tarda minutos, y eso es la velocidad
del almacenamiento, no un fallo. Para reducirlo, exporta desde el escritorio en
un formato más ligero:

- **Optimizado** lleva el audio ya preparado para reproducir, así que el móvil
  se salta la decodificación por completo: la sesión abre sin fase de
  preparación y no escribe nada en la caché de audio. El paquete pesa más al
  transferirlo, y no cambia cuántas pistas suenan a la vez; cambia cuánto
  esperas.
- **Ligero** deja el audio fuera, para cuando los archivos ya están en el
  dispositivo.
- **Dividir un set en canciones más cortas** mantiene pequeña cada importación,
  que es la opción más fiable en un móvil antiguo.

## Formatos de audio

El motor de audio incluye FFmpeg en **las tres plataformas**, así que los mismos formatos cargan en todas partes — entre ellos WAV, AIFF, FLAC, MP3 y AAC/M4A. No hay que instalar códecs aparte: en macOS las librerías de códecs viajan dentro del `.app`, y en Windows y Linux se distribuyen junto a la app.

## Hardware

| | Mínimo | Recomendado |
| --- | --- | --- |
| **CPU** | Doble núcleo de 64 bits moderno | Cuatro núcleos o más — necesario para varias pistas de pitch/warp a la vez |
| **RAM** | 4 GB | 8 GB o más |
| **Almacenamiento** | Espacio para tus audios y la caché | SSD. Además de tus audios (que se usan desde donde estén), cada sesión guarda junto a ella una caché de formas de onda y de audio preparado |
| **Pantalla** | 1280×800 | 1440×900 o mayor |

El pitch y el warp en tiempo real son la parte más exigente de la app. Una sola pista transpuesta es ligera; ejecutar muchas pistas transpuestas a la vez es lo que se beneficia de una CPU más rápida. En un cuatro núcleos moderno típico puedes mantener nueve o más voces de pitch simultáneas dentro del presupuesto de audio.

## Vídeo

Para proyectar [vídeo](/es/docs/tasks/video/) necesitas una **segunda
pantalla** (proyector, TV o monitor) conectada al ordenador; con una sola
pantalla el vídeo se puede ver en una ventana.

- **Windows y macOS**: el reproductor de vídeo (libmpv) viene dentro de la
  app.
- **Linux**: si en **Configuración → Vídeo** sale «Vídeo no disponible»,
  instala la librería de mpv de tu distribución (`libmpv2` en Debian/Ubuntu,
  `mpv-libs` en Fedora).
- La decodificación por hardware usa la tarjeta gráfica; un vídeo 1080p en
  H.264 va bien en cualquier equipo actual.
- En **móvil**, hace falta salida de vídeo por cable: USB‑C a HDMI
  (DisplayPort por USB‑C en Android) o el adaptador Lightning Digital AV.

## Remote y nube

- El [Remote](/es/docs/remote-control/) funciona en el **navegador** de
  cualquier móvil o tablet actual (Chrome, Safari, Firefox, Edge), sin
  instalar nada. Ordenador y dispositivo tienen que estar en la **misma red**.
- La [nube](/es/docs/integration-ecosystem/#la-nube-tu-google-drive) necesita
  una **cuenta de Google** (gratuita) y conexión a internet al subir o bajar.
  El espacio es el de tu Google Drive.

## Configuración de audio en directo

Para ensayar puedes usar la salida integrada, pero para **escenario se recomienda encarecidamente una interfaz de audio dedicada**:

- **Windows** — un driver **ASIO** da la latencia más baja y estable, y expone todos los canales de hardware (dos para una interfaz estéreo, ocho para una MOTU, treinta y dos para una X32 por USB).
- **macOS** — **Core Audio** con una interfaz compatible de clase o de fabricante.
- **Tamaño de buffer** — buffers más bajos reducen la latencia pero cuestan CPU. Busca el buffer más pequeño que funcione sin cortes en tu equipo.

El pitch shifting en tiempo real añade una latencia inherente (alrededor de ~108 ms con el motor actual), así que cuando el timing es crítico, prefiere material pre‑warpeado/pre‑transpuesto antes que transponer en directo siempre que puedas.

Consulta [Routing y metrónomo](/es/docs/audio-routing-metronome/) para saber cómo activar las salidas físicas y el flujo Aplicar/Descartar de canales.
