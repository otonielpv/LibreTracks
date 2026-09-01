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
- Backend de dispositivo propio sobre **AudioUnit RemoteIO**
  (`src/devices/audio_device_manager_ios.mm`), sin JUCE.
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

## Por qué iOS no usa JUCE

En escritorio, JUCE aporta ASIO, WASAPI, DirectSound, ALSA, JACK y CoreAudio, y
ahí se queda. En iOS no aportaba nada de eso: **iOS no publica una lista de
salidas abribles**, así que el nombre de la ruta, el tipo de puerto, los canales
de una interfaz USB, los cambios de ruta y las interrupciones ya salían de
`ios_audio_session.mm` (AVFoundation puro). Lo único que quedaba de JUCE era
crear el AudioUnit RemoteIO y bombear el callback: unas 200 líneas.

El motivo para escribirlas nosotros es de licencia. LibreTracks usa JUCE bajo su
opción **AGPLv3**, incompatible con los términos de distribución de la App
Store; sin JUCE en el binario, ese bloqueante desaparece del port de iOS. El
escritorio no cambia: distribuir el DMG fuera de la tienda con JUCE-AGPLv3 es
perfectamente legal (ver [APPLE_SIGNING.md](./APPLE_SIGNING.md)).

Lo que el backend nuevo mantiene idéntico al de escritorio:

- El mismo contrato `AudioDeviceManager` (`open_device` abre **y** arranca).
- El **pump de fallback**: si el dispositivo muere o entra una llamada, un hilo
  sigue llamando al render con la última configuración conocida, así que el
  transporte no se para y el motor no pierde la posición.
- El **monitor de stalls**, que además vigila `ios_audio_route_generation()`:
  enchufar una interfaz USB no congela los callbacks (iOS migra la ruta sin
  avisar), así que sin esa comprobación una interfaz de 4 u 8 salidas seguiría
  comportándose como estéreo hasta reiniciar la app.

La CI lo protege por dos vías: `LT_ENGINE_USE_JUCE:BOOL=OFF` verificado en el
`CMakeCache.txt`, y la cadena `coreaudio-ios` buscada dentro del ejecutable del
IPA (si el backend no se enlazara, el motor caería al stub mudo).

### Pendiente de validar en hardware

El backend RemoteIO no se ha probado todavía en un iPhone físico. Hay que
comprobar, con build **Release** y la interfaz USB conectada:

1. Reproducción, pausa, seek y medidores por el altavoz.
2. Que la interfaz USB aparece con su nombre y **todas** sus salidas.
3. Desconectar y reconectar en caliente: la ruta se recupera sola.
4. Una llamada entrante: el transporte sigue y el audio vuelve al colgar.

## Qué se excluye todavía

- Servidor remote: en móvil la aplicación es el dispositivo de control.
- MIDI: todavía no hay integración CoreMIDI.

## Validación del hito

1. Abrir una sesión real con audio desde Archivos.
2. Confirmar reproducción, pausa, seek y medidores con el altavoz del iPhone.
3. Conectar una interfaz USB y confirmar su nombre, canales y reproducción.
4. Cambiar a auriculares/Bluetooth/AirPlay y confirmar que la ruta se recupera.
5. Revisar underruns y consumo exclusivamente con build `Release`.
