---
title: Requisitos del sistema
description: Hardware mínimo y recomendado, sistemas operativos y configuración de audio en directo para usar LibreTracks.
---

LibreTracks es una app nativa ligera (Rust + Tauri), no un DAW de estudio pesado, así que funciona con soltura en equipos modestos. Las cifras de abajo son una guía práctica, no límites duros — el verdadero cuello de botella en directo es el pitch/warp en tiempo real, que escala con cuántas pistas transpones a la vez.

## Sistemas operativos

| Plataforma | Mínimo | Notas |
| --- | --- | --- |
| **Windows** | Windows 10 (64 bits) | Necesita el runtime **WebView2**, que viene preinstalado en Windows 10/11 actuales. |
| **macOS** | macOS 11 **Big Sur** | Intel y Apple Silicon. Mantén el sistema actualizado — la interfaz usa el WebView del sistema y un WebKit antiguo puede renderizar partes de la UI de forma incorrecta. |
| **Linux** | Ubuntu 22.04 / Fedora 36 o posterior | Requiere `webkit2gtk-4.1`, `gtk3` y ALSA. Se distribuye como `.deb`, `.rpm` y `.AppImage`. |

> **¿Por qué macOS 11+?** La UI de escritorio corre dentro del WebView del sistema operativo, y el motor de audio enlaza frameworks que se resuelven correctamente a partir de Big Sur. Las versiones anteriores de macOS traen un WebKit demasiado antiguo para renderizar CSS moderno (dejando la interfaz en negro o descuadrada) y carecen de símbolos que la app necesita al arrancar.

## Hardware

| | Mínimo | Recomendado |
| --- | --- | --- |
| **CPU** | Doble núcleo de 64 bits moderno | Cuatro núcleos o más — necesario para varias pistas de pitch/warp a la vez |
| **RAM** | 4 GB | 8 GB o más |
| **Almacenamiento** | SSD con espacio para tus sesiones y audio | SSD; las sesiones guardan el audio + cachés de picos junto al proyecto |
| **Pantalla** | 1280×800 | 1440×900 o mayor |

El pitch y el warp en tiempo real son la parte más exigente de la app. Una sola pista transpuesta es ligera; ejecutar muchas pistas transpuestas a la vez es lo que se beneficia de una CPU más rápida. En un cuatro núcleos moderno típico puedes mantener nueve o más voces de pitch simultáneas dentro del presupuesto de audio.

## Configuración de audio en directo

Para ensayar puedes usar la salida integrada, pero para **escenario se recomienda encarecidamente una interfaz de audio dedicada**:

- **Windows** — un driver **ASIO** da la latencia más baja y estable, y expone todos los canales de hardware (dos para una interfaz estéreo, ocho para una MOTU, treinta y dos para una X32 por USB).
- **macOS** — **Core Audio** con una interfaz compatible de clase o de fabricante.
- **Tamaño de buffer** — buffers más bajos reducen la latencia pero cuestan CPU. Busca el buffer más pequeño que funcione sin cortes en tu equipo.

El pitch shifting en tiempo real añade una latencia inherente (alrededor de ~108 ms con el motor actual), así que cuando el timing es crítico, prefiere material pre‑warpeado/pre‑transpuesto antes que transponer en directo siempre que puedas.

Consulta [Routing y metrónomo](/es/docs/audio-routing-metronome/) para saber cómo activar las salidas físicas y el flujo Aplicar/Descartar de canales.
