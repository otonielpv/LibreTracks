# Firma y notarización del DMG (macOS)

Cómo pasar de "LibreTracks está dañado y no se puede abrir" a un DMG que
cualquiera instala con doble clic. Cubre **solo distribución fuera de la App
Store**, que es donde vive LibreTracks en macOS.

## Por qué hace falta

Desde macOS Catalina, una app descargada de internet que no esté **firmada con
un certificado Developer ID y notarizada por Apple** se bloquea. El mensaje no
invita a continuar: en Sequoia y posteriores ni siquiera hay un "Abrir de todos
modos" en el diálogo, hay que ir a Ajustes del Sistema. Mucha gente lo lee como
"la descarga está rota" y se va.

Firmar y notarizar son dos cosas distintas y hacen falta **las dos**:

- **Firmar** demuestra quién construyó el binario y que nadie lo ha tocado
  desde entonces.
- **Notarizar** es enviar el resultado a Apple, que lo analiza y devuelve un
  "ticket". El *staple* pega ese ticket dentro del DMG para que el Mac del
  usuario no necesite conexión a internet para comprobarlo.

Una build firmada pero sin notarizar sigue bloqueada. Por eso la CI falla
duro si están unos secretos y faltan otros (ver más abajo).

## Lo que hay que conseguir una vez

### 1. Cuenta

Apple Developer Program, 99 USD/año. La modalidad **individual** basta para
firmar y notarizar; publica tu nombre legal como desarrollador. La de
organización exige un número D-U-N-S y solo compensa si quieres que aparezca un
nombre de empresa.

### 2. Certificado *Developer ID Application*

Desde un Mac:

1. **Acceso a Llaveros** → menú *Acceso a Llaveros* → *Asistente de
   certificados* → *Solicitar un certificado a una autoridad de certificación*.
   Guarda la petición (`.certSigningRequest`) en disco.
2. [developer.apple.com/account](https://developer.apple.com/account) →
   *Certificates, IDs & Profiles* → *Certificates* → **+** → tipo
   **Developer ID Application** → sube el `.certSigningRequest` → descarga el
   `.cer` y ábrelo con doble clic para instalarlo en el llavero.
3. Exporta el par certificado + clave privada: **Acceso a Llaveros** → *Mis
   certificados* → clic derecho sobre `Developer ID Application: …` →
   *Exportar* → formato `.p12` con una contraseña fuerte.

   Tiene que salir de *Mis certificados*: es la vista que incluye la clave
   privada. Un `.p12` exportado desde *Certificados* no sirve para firmar.

Apunta el nombre EXACTO de la identidad, que es lo que va en el secreto:

```bash
security find-identity -v -p codesigning
# 1) A1B2C3… "Developer ID Application: Tu Nombre (TEAMID1234)"
```

Guarda el `.p12` y su contraseña en tu gestor de contraseñas. Perderlos
significa emitir otro certificado (hay un límite por cuenta) y, aunque las
sesiones guardadas sobreviven, cambiar de identidad rompe la continuidad de los
*security-scoped bookmarks* de [entitlements.plist](../apps/desktop/src-tauri/entitlements.plist).

### 3. Clave de API de App Store Connect (para notarizar)

Más robusta que el par Apple ID + contraseña específica: no caduca sola ni se
rompe al cambiar la contraseña de la cuenta.

1. [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → *Usuarios y
   acceso* → *Integraciones* → *Claves de API* → genera una clave. El rol
   *Developer* es suficiente para notarizar.
2. Descarga el `AuthKey_XXXXXXXXXX.p8`. **Solo se puede descargar una vez.**
3. Apunta el **Key ID** (el `XXXXXXXXXX` del nombre) y el **Issuer ID** (el
   UUID que aparece encima de la tabla).

## Secretos del repositorio

En *Settings → Secrets and variables → Actions*:

| Secreto | Valor |
| --- | --- |
| `APPLE_CERTIFICATE` | `base64 -i DeveloperID.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | La contraseña del `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Tu Nombre (TEAMID1234)` |
| `APPLE_API_KEY_BASE64` | `base64 -i AuthKey_XXXXXXXXXX.p8 \| pbcopy` |
| `APPLE_API_KEY` | El Key ID (`XXXXXXXXXX`) |
| `APPLE_API_ISSUER` | El Issuer ID (UUID) |

Mientras no exista `APPLE_CERTIFICATE`, la release sigue saliendo **sin firmar**
con un aviso en el log: los forks y este repositorio siguen compilando igual. En
cuanto `APPLE_CERTIFICATE` está puesto, los otros cinco son obligatorios y el
job falla si falta alguno — un DMG firmado a medias no lo puede abrir nadie, así
que es preferible parar la release.

## Qué hace la CI

En [.github/workflows/release.yml](../.github/workflows/release.yml), job
`build-release-assets`:

1. **Prepare macOS signing identity** — crea un llavero temporal, importa el
   certificado, comprueba que `APPLE_SIGNING_IDENTITY` coincide de verdad con lo
   importado (el fallo más habitual es un nombre mal copiado) y materializa el
   `.p8` en disco, que es la única forma en que `notarytool` lo lee.
2. **Build Tauri bundles (signed + notarized macOS)** — el bundler firma la app
   con *hardened runtime* y notariza el `.app`.
3. **Notarize and staple macOS DMG** — el DMG se ensambla después de todo eso y
   el bundler no lo *staplea*; se hace aquí, tras el guardarraíl de dylibs, para
   no gastar un envío a Apple en un bundle que ya sabemos roto.
4. **Verify macOS signature and notarization** — `codesign --verify --deep`,
   comprobación del hardened runtime, veredicto real de Gatekeeper
   (`spctl` debe decir `source=Notarized Developer ID`) y `stapler validate`.
5. **Remove temporary signing keychain** — corre siempre, también si algo falló.

## Probarlo en local antes de gastar una release

Desde un Mac con el certificado ya en el llavero:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Tu Nombre (TEAMID1234)"
export APPLE_API_ISSUER="<issuer-uuid>"
export APPLE_API_KEY="XXXXXXXXXX"
export APPLE_API_KEY_PATH="$HOME/private_keys/AuthKey_XXXXXXXXXX.p8"

npm --prefix apps/desktop run tauri build -- --target universal-apple-darwin
```

Y las mismas comprobaciones que hace la CI, sobre el `.app` resultante:

```bash
APP=target-desktop-native/universal-apple-darwin/release/bundle/macos/LibreTracks.app
codesign --verify --deep --strict --verbose=2 "$APP"
codesign --display --verbose=2 "$APP" | grep flags     # debe incluir runtime
spctl --assess --type exec --verbose=4 "$APP"          # Notarized Developer ID
xcrun stapler validate "$APP"
```

## Si la notarización falla

`notarytool` devuelve un identificador de envío; el detalle está en el log:

```bash
xcrun notarytool log <submission-id> \
  --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER"
```

Lo que se puede esperar en este proyecto concreto:

- **Un binario anidado sin firmar.** El `.app` lleva el motor, `bungee.framework`
  y cuatro dylibs de FFmpeg (`bundle.macOS.frameworks` en
  [tauri.conf.json](../apps/desktop/src-tauri/tauri.conf.json)). `bungee.framework`
  tiene estructura `Versions/` con enlaces simbólicos y hay que firmarlo de
  dentro afuera; el log de notarización nombra el fichero exacto.
- **Rutas absolutas de la máquina de build en una dylib.** Eso ya lo caza antes
  el paso *Validate macOS .app bundle dylib wiring*; se arregla en
  [scripts/macos-bundle-ffmpeg.sh](../scripts/macos-bundle-ffmpeg.sh).
- **La app arranca en CI pero muere en un Mac ajeno por *library validation*.**
  Todas las dylibs se firman con la misma identidad, así que no debería pasar.
  Si pasara, la salida correcta es firmar lo que falte, y solo como último
  recurso añadir `com.apple.security.cs.disable-library-validation` a
  [entitlements.plist](../apps/desktop/src-tauri/entitlements.plist).
- **Permisos que hoy no se piden.** LibreTracks solo abre salidas de audio. El
  día que se abra una entrada harán falta `NSMicrophoneUsageDescription` y
  `com.apple.security.device.audio-input`, o macOS mata la captura sin avisar.

## Mantenimiento

- El certificado *Developer ID Application* caduca a los **5 años**. Renuévalo
  antes: las builds ya notarizadas siguen funcionando (el ticket es lo que
  vale), pero sin certificado válido no se firman nuevas.
- La clave de API no caduca; revócala y genera otra si se filtra.
- Cuando la firma esté activa, borra la nota de Gatekeeper de la página de
  descargas: está marcada como temporal en
  [GithubReleases.astro](../apps/website/src/components/GithubReleases.astro)
  (`gatekeeperTitle`) y su estilo `.platform-note` en
  [global.css](../apps/website/src/styles/global.css).

## Lo que este documento NO cubre

Publicar en la **App Store** (iOS o macOS) es otro camino: otros certificados,
otro proceso de revisión y un conflicto de licencias por resolver antes
— LibreTracks es AGPL-3.0 y enlaza JUCE bajo la opción AGPLv3, que choca con los
términos de distribución de la App Store. Nada de eso afecta al DMG: distribuir
fuera de la tienda es plenamente compatible con la AGPL.
