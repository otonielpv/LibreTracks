# Port iOS (IPA de pruebas con AltStore)

## Estado actual

El primer hito es un **smoke build** para iPhone real (`arm64`): arranca la
aplicación Tauri, permite validar el WebView, el sandbox y la interfaz, pero usa
el stub `no-link` del motor de audio. No debe confundirse con un port de audio
terminado.

La CI está aislada de releases en `.github/workflows/ios-smoke.yml` y solo se
ejecuta manualmente. No usa certificados, perfiles de aprovisionamiento ni
secretos de Apple. El IPA resultante se firma posteriormente con el Apple ID
del probador al instalarlo mediante AltStore.

## Generar el IPA

1. Abrir **Actions** en GitHub.
2. Seleccionar **iOS Smoke (unsigned IPA)**.
3. Pulsar **Run workflow** sobre la rama que contiene el port.
4. Al terminar, descargar el artefacto `LibreTracks-iOS-unsigned-<número>`.
5. Descomprimir el artefacto de GitHub una vez; dentro está el `.ipa` que se
   entrega directamente a AltStore.

El workflow valida que el paquete contiene `Payload/*.app`, que el bundle id es
`com.libretracks.ios`, que el mínimo es iOS 15 y que el ejecutable incluye
`arm64`.

## Qué se excluye en este hito

- Motor C++ y reproducción de audio: `lt-audio-engine-v2/no-link` se activa
  únicamente al compilar para iOS.
- Servidor remote: en móvil la aplicación es el dispositivo de control.
- MIDI: todavía no hay integración CoreMIDI.
- Diálogos `rfd`: no se compilan en iOS; los flujos de documentos se portarán a
  `tauri-plugin-dialog` y `tauri-plugin-fs`.

## Siguiente hito

Portar el motor como biblioteca estática para `aarch64-apple-ios`, empezando
con JUCE/CoreAudio y los decodificadores WAV/MP3/FLAC. Una vez enlazado y
probado en el iPhone se retirará la activación iOS de `no-link`; Bungee y los
formatos que requieran otro decodificador se incorporarán después.
