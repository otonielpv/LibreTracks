# Port iOS

## Estado actual

El motor C++ completo (Bungee + FFmpeg + libsndfile + voz guía + pads) se
enlaza estáticamente en el IPA de `arm64`, con backend de audio propio sobre
RemoteIO y **sin JUCE**. La CI rechaza el IPA si detecta el stub silencioso
`no-link` o si JUCE vuelve a entrar.

Hay dos builds, y comparten todo menos la firma:

| | `ios-smoke.yml` | `ios-release.yml` |
| --- | --- | --- |
| Sale | IPA sin firmar | IPA firmado para la tienda |
| Se instala | AltStore, con el Apple ID del probador | TestFlight |
| Credenciales | ninguna (corre en forks) | certificado + perfil + clave de API |

Lo común vive en `.github/actions/ios-native-deps` (motor y dependencias
nativas), `.github/actions/ios-xcode-project` (proyecto Xcode, icono y
manifiesto de privacidad) y `scripts/verify-ios-ipa.sh` (comprobaciones del
IPA). Esa separación es deliberada: si los dos workflows montaran el bundle por
su cuenta, el IPA que se prueba dejaría de ser el IPA que se publica en cuanto
uno de los dos se tocara.

El proceso de publicación —certificados, App ID, perfil, secretos y subida— está
en [APPLE_SIGNING.md](./APPLE_SIGNING.md).

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

## Icono de la app

Los iconos de iOS **no** salen de `tauri icon`. Ese comando parte de
`icons/icon.png`, que es el icono de escritorio: lleva un marco de 32 px y la
esquina ya redondeada, y genera PNG con canal alfa. Apple pide justo lo
contrario —arte a sangre, cuadrado y opaco, porque la máscara la pone iOS— y
un icono con alfa tumba la subida a App Store Connect (*"can't be transparent
nor contain an alpha channel"*). Con el marco dentro, además, la pantalla de
inicio mostraba una baldosa blanca con el logo pequeño flotando en medio, que
es lo que se veía en el iPhone y parecía otro icono distinto.

El arte de iOS vive aparte, en `icons/icon-ios.svg`, y se rasteriza con
`node scripts/make-ios-icons.mjs` (los 18 tamaños, a `icons/ios/`). Solo hay
que ejecutarlo cuando cambia el dibujo.

Meterlos en el `.app` es otra cosa. `tauri ios init` **no** lee `icons/ios`: el
proyecto nace con los iconos de relleno de la plantilla de cargo-mobile2, y
quien escribe en `Assets.xcassets/AppIcon.appiconset` es `tauri icon`, que el
workflow no ejecuta. Como el proyecto se genera en cada build, el IPA salía
siempre con el icono de la plantilla. De eso se encarga ahora un paso de la CI,
justo detrás de `ios init`:

```bash
node scripts/ios-app-icon.mjs
```

Copia por **tamaño**, leyendo el `Contents.json` recién generado, así que no
depende de cómo llame la plantilla a sus ficheros; y **falla el job** si el
catálogo se queda sin icono, para que no vuelva a colarse en silencio.

El test `src/shared/iosAppIcon.test.ts` cubre las dos mitades: que los 18 PNG
siguen siendo cuadrados y sin alfa (si alguien vuelve a pasar `tauri icon` por
encima, falla) y que la copia al catálogo hace lo que dice.

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

### Qué está verificado y qué no

El audio de iOS se puede ejercitar sin iPhone, hasta cierto punto. Lo hace
`.github/workflows/ios-audio-probe.yml`, a mano, en dos pasos:

1. **La sonda** (`tests/ios/remoteio_probe.m`) responde primero a la pregunta
   de la que depende todo lo demás: si un runner —una VM sin tarjeta de
   sonido— entrega callbacks de RemoteIO. Los entrega: ruta "Speaker", 48 kHz,
   2 canales, callbacks en tiempo real. Sin ese dato, cualquier test de audio
   montado encima estaría midiendo el vacío.
2. **El self-test** (`tests/ios/device_manager_selftest.mm`) compila
   `audio_device_manager_ios.mm` y `ios_audio_session.mm` tal cual —con las
   flags que les da CMake— y los ejercita dentro del simulador.

Queda **verificado**:

- que RemoteIO abre por el camino del engine y negocia tasa y buffer;
- que las muestras que escribe el motor llegan a los buffers del hardware
  (señal, no solo fontanería);
- que el mapa de canales físicos se publica antes del primer callback;
- el **camino de recuperación de la llamada entrante**: la notificación sube la
  generación de ruta, el monitor desmonta el stream y pasa el reloj a la bomba
  de reserva —el transporte no se para—, y la siguiente `open_device` (la que
  emite el watchdog de Rust cada 2 s) recupera el hardware. Es el mismo camino
  que usa enchufar una interfaz USB en caliente.

Sigue **sin verificar**, y necesita un iPhone de verdad:

1. Que la interfaz USB aparece con su nombre y **todas** sus salidas. El
   simulador tiene una salida estéreo y punto, así que la negociación de ancho
   de canales no se puede probar.
2. Desconectar y reconectar en caliente el aparato físico.
3. Una llamada entrante real. Todo lo que va *después* de la notificación es
   código de producción probado; quien la postea en el test es el test.
4. Latencia y underruns, que en una VM no significan nada.

## Manifiesto de privacidad (App Store)

`apps/desktop/src-tauri/PrivacyInfo.xcprivacy` tiene que acabar en la **raíz**
del bundle, y `bundle.resources` no puede ponerlo ahí: el `project.yml` de
Tauri declara `assets` como referencia de carpeta, así que todo lo que Tauri
copia acaba bajo `.app/assets/`. Lo añade como recurso del target el paso
`scripts/ios-add-privacy-manifest.rb`, entre `ios init` y `ios build`; copiarlo
al `.app` después invalidaría la firma. `verify-ios-ipa.sh` comprueba en cada
build que llegó a la raíz — sin él, App Store Connect rechaza la subida
(**ITMS-91053**).

Lo declarado, con el código que lo respalda:

| Declaración | Por qué |
| --- | --- |
| `DiskSpace` (E174.1) | `statvfs` en `source_manager.cpp`: la caché de PCM se dimensiona como un porcentaje del espacio libre |
| `FileTimestamp` (C617.1, 0A2A.1) | la caché de ondas se indexa por ruta + tamaño + mtime; los dos motivos porque hay ficheros del contenedor **y** ficheros que el usuario abre desde Archivos |
| `SystemBootTime` (35F9.1) | `std::chrono::steady_clock` es `mach_absolute_time` en Apple: medidores de callback, monitor de stalls y reloj de fallback |
| `ProductInteraction` | las estadísticas opt-in de `docs/TELEMETRY.md` |

**Si Apple reclama alguna API más**, el correo de ITMS-91053 nombra la
categoría exacta: se añade otro bloque a `NSPrivacyAccessedAPITypes` con el
motivo que corresponda. El candidato más probable es `UserDefaults` (CA92.1),
que usaría WKWebView por debajo; no está declarado porque no hay ninguna
llamada nuestra, y declarar APIs que no se usan tampoco es correcto.

El DMG de macOS no necesita este fichero: solo se exige en la App Store.

## Qué se excluye todavía

- Servidor remote: en móvil la aplicación es el dispositivo de control.
- MIDI: todavía no hay integración CoreMIDI.

## Validación del hito

1. Abrir una sesión real con audio desde Archivos.
2. Confirmar reproducción, pausa, seek y medidores con el altavoz del iPhone.
3. Conectar una interfaz USB y confirmar su nombre, canales y reproducción.
4. Cambiar a auriculares/Bluetooth/AirPlay y confirmar que la ruta se recupera.
5. Revisar underruns y consumo exclusivamente con build `Release`.
