# Port iOS (IPA de pruebas con AltStore)

## Estado actual

El smoke build para iPhone real (`arm64`) ya valida el WebView, el sandbox, la
interfaz y el selector de carpetas. El siguiente hito, actualmente en
integración, enlaza el motor C++ estático con JUCE/CoreAudio y activa una
`AVAudioSession` de reproducción. La CI rechaza el IPA si detecta el stub
silencioso `no-link`.

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

## Alcance inicial del audio

- Motor C++ estático para `aarch64-apple-ios`, sin dylibs externas.
- JUCE usa el dispositivo CoreAudio que iOS mantiene como ruta del sistema.
- `AVAudioSession` se configura para playback a 48 kHz y baja latencia cuando
  la ruta lo permite.
- WAV/AIFF se decodifican con libsndfile; MP3 y FLAC con los decodificadores
  `dr_libs` incluidos en el repo.
- La lista de dispositivos muestra el nombre y los canales de la ruta física
  activa (altavoz, auriculares, USB, Bluetooth, AirPlay o HDMI).

### Limitación de rutas impuesta por iOS

iOS no publica una lista de salidas arbitrariamente abribles como CoreAudio en
macOS. `AVAudioSession.currentRoute` describe los puertos de salida activos y
sus canales. AirPlay y otras rutas remotas se seleccionan mediante el selector
nativo del sistema; al conectar una interfaz USB, iOS cambia la ruta y
LibreTracks la refleja con su nombre real. Algunos accesorios USB permiten
seleccionar sus fuentes internas mediante `outputDataSources`, pero no existe
una API general para forzar cualquier salida conectada.

## Qué se excluye todavía

- Servidor remote: en móvil la aplicación es el dispositivo de control.
- MIDI: todavía no hay integración CoreMIDI.
- Bungee: pitch y warp se mantienen en passthrough hasta disponer de una
  biblioteca compatible con iOS arm64.

## Validación del hito

1. Abrir una sesión real con audio desde Archivos.
2. Confirmar reproducción, pausa, seek y medidores con el altavoz del iPhone.
3. Conectar una interfaz USB y confirmar su nombre, canales y reproducción.
4. Cambiar a auriculares/Bluetooth/AirPlay y confirmar que la ruta se recupera.
5. Revisar underruns y consumo exclusivamente con build `Release`.
