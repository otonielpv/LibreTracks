//! Which OAuth client this build identifies as, and where Google sends the
//! answer.
//!
//! # Why there are four clients and not one
//!
//! Google will not let a single OAuth client cover the five platforms.
//!
//! - **Desktop** gets its own client and answers on the loopback interface.
//! - **iOS** and **Android** must use platform client types, because Google
//!   deprecated the loopback redirect for both. A single cross-platform client
//!   was the obvious simplification and it is not available.
//! - **Android needs one client per signing certificate**, since Google
//!   identifies an Android app by package name *plus* SHA-1 fingerprint and a
//!   client holds exactly one pair. Debug builds and Play builds are signed by
//!   different keys, so they are different clients.
//!
//! # The Play signing trap
//!
//! LibreTracks uses Play App Signing: the upload keystore signs what is sent to
//! Google, and Google strips that signature and re-signs with a key it holds.
//! Apps people actually install therefore carry *Google's* certificate, not the
//! upload key's. ANDROID_PLAY_CLIENT_ID is registered against the SHA-1 read
//! from the Play Console's app signing key, which is the only fingerprint that
//! matches a real install. Registering the upload key here instead produces a
//! build that authenticates perfectly on the developer's machine and fails for
//! every user, and only after publishing.
//!
//! # Three different identifiers
//!
//! They are deliberately not the same and it is easy to reach for the wrong one:
//!
//! | Where | Value |
//! |---|---|
//! | tauri.conf.json identifier / Kotlin namespace | com.libretracks.desktop |
//! | Android applicationId (what Google matches) | com.libretracks.app |
//! | iOS CFBundleIdentifier | com.libretracks.ios |

/// Client IDs are public by design for native apps: they identify the app, they
/// do not authenticate it. PKCE is what makes the flow safe, which is why these
/// can sit in an AGPL repository without weakening anything.
pub const DESKTOP_CLIENT_ID: &str =
    "809304051758-to5i3gqe6bteafscvnhi2phom0p3a4d7.apps.googleusercontent.com";

pub const IOS_CLIENT_ID: &str =
    "809304051758-ekp6mq7miacmd1qtjej20tqv2grhs68d.apps.googleusercontent.com";

/// Registered against the debug keystore's SHA-1. Used by every locally built
/// debug APK, including ones sideloaded onto a test phone.
pub const ANDROID_DEBUG_CLIENT_ID: &str =
    "809304051758-k6cr7mg3eqf1dentv3ggffuvcfadt9pf.apps.googleusercontent.com";

/// Registered against the **Play App Signing** certificate's SHA-1. This is the
/// client every real user authenticates with. See the module note.
pub const ANDROID_PLAY_CLIENT_ID: &str =
    "809304051758-o6bh7njdsj1d0596u1n0skpqasn4pr8q.apps.googleusercontent.com";

/// Client secret for the **desktop** client, injected at build time.
///
/// # Why this is not in the source
///
/// Not because it is a real secret. RFC 8252 and Google both state that an
/// installed app cannot keep one: it ships inside the binary either way and
/// anyone can read it out with `strings`. PKCE is what actually secures this
/// flow. Two practical reasons keep it out of the repository anyway:
///
/// - **Secret scanners.** The `GOCSPX-` prefix is a recognised pattern and
///   Google is a scanning partner, so a push would raise an alert and may get
///   the credential revoked automatically. A self-inflicted outage for no gain.
/// - **Forks.** LibreTracks is AGPL, so anyone may rebuild it. Baked-in
///   credentials would make a fork run against this project quota and show this
///   project name on the consent screen. Making it a build input means a fork
///   naturally registers its own client, which is the correct outcome.
///
/// # Setting it
///
/// `LIBRETRACKS_GOOGLE_CLIENT_SECRET` in the environment at compile time
/// (locally, and as a CI secret for release builds). Absent, the value is
/// `None` and the build still succeeds: cloud sign-in reports that it is not
/// configured rather than failing at the last step of an OAuth round trip.
///
/// It is required, despite the documentation. Google lists `client_secret` as
/// optional for desktop clients, but the token endpoint answers a bare exchange
/// with `400 invalid_request: client_secret is missing.` — confirmed against
/// the live endpoint on 2026-09-02 with the prototype. A build without it
/// completes the consent screen and then fails at the very last step, so treat
/// a missing value as "cloud not configured" up front rather than letting a
/// user walk into that.
///
/// Android and iOS client types are issued no secret at all.
pub const CLIENT_SECRET: Option<&str> = {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        None
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        option_env!("LIBRETRACKS_GOOGLE_CLIENT_SECRET")
    }
};

/// # Android necesita un interruptor en la consola de Google
///
/// Google desactiva por defecto los esquemas URI propios en los clientes de
/// Android nuevos, por riesgo de suplantacion: cualquier app del dispositivo
/// puede declarar el mismo esquema. Sin activarlo, el consentimiento devuelve
/// `400 invalid_request` antes incluso de mostrarse.
///
/// Hay que activar **"Habilitar esquema URI personalizado"** en Configuracion
/// avanzada de CADA cliente de Android — el de depuracion y el de Play. Si solo
/// se hace en el de depuracion, funciona en la maquina del desarrollador y falla
/// para todos los usuarios, y no se descubre hasta publicar.
///
/// La alternativa oficial es el SDK de Google Identity Services para Android
/// (no los App Links, que no valen para esto). Se descarto a proposito el
/// 2026-09-02: no cambia nada para el usuario, y partiria en dos el flujo de
/// OAuth que hoy comparten escritorio, iOS y Android. Revisar si Google anuncia
/// fecha de cierre del interruptor.
///
/// iOS no esta afectado: ahi el esquema propio sigue siendo lo correcto.

/// How Google returns the authorization response to this build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RedirectUri {
    /// Desktop: a throwaway HTTP listener on 127.0.0.1. The port is chosen at
    /// run time and registered nowhere. Google accepts any port for a desktop
    /// client, which is what makes this work without a fixed reservation.
    Loopback,
    /// Mobile: a private URI scheme derived from the client ID. Must also be
    /// declared in the Android manifest and the iOS Info.plist, or the browser
    /// completes the sign-in and then has nowhere to hand it back to.
    CustomScheme(String),
}

/// The OAuth client this build must present.
///
/// Android resolves at compile time through `debug_assertions` rather than by
/// inspecting the running app's signature: a debug build is signed by the debug
/// key by definition, so the build profile already carries the answer.
pub const fn client_id() -> &'static str {
    #[cfg(target_os = "ios")]
    {
        IOS_CLIENT_ID
    }
    #[cfg(target_os = "android")]
    {
        if cfg!(debug_assertions) {
            ANDROID_DEBUG_CLIENT_ID
        } else {
            ANDROID_PLAY_CLIENT_ID
        }
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        DESKTOP_CLIENT_ID
    }
}

/// The redirect this build listens on.
pub fn redirect_uri() -> RedirectUri {
    if cfg!(any(target_os = "ios", target_os = "android")) {
        RedirectUri::CustomScheme(reversed_client_scheme(client_id()))
    } else {
        RedirectUri::Loopback
    }
}

/// Turn `<id>.apps.googleusercontent.com` into the reversed scheme Google
/// expects from a mobile client: `com.googleusercontent.apps.<id>`.
///
/// Derived rather than hardcoded so the scheme cannot drift away from the
/// client ID it belongs to. A mismatch fails only at the last step of a
/// sign-in, which is an expensive place to discover a typo.
pub fn reversed_client_scheme(client_id: &str) -> String {
    const SUFFIX: &str = ".apps.googleusercontent.com";
    let id = client_id.strip_suffix(SUFFIX).unwrap_or(client_id);
    format!("com.googleusercontent.apps.{id}")
}

/// Full redirect URI string to send in the authorization request.
///
/// `port` is used only on desktop, where it is the loopback listener's port.
pub fn redirect_uri_string(redirect: &RedirectUri, port: u16) -> String {
    match redirect {
        RedirectUri::Loopback => format!("http://127.0.0.1:{port}"),
        RedirectUri::CustomScheme(scheme) => format!("{scheme}:/oauth2redirect"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_client_id_is_well_formed() {
        for id in [
            DESKTOP_CLIENT_ID,
            IOS_CLIENT_ID,
            ANDROID_DEBUG_CLIENT_ID,
            ANDROID_PLAY_CLIENT_ID,
        ] {
            assert!(
                id.ends_with(".apps.googleusercontent.com"),
                "not a Google client ID: {id}"
            );
        }
    }

    /// A copy-paste slip between the four would send a build to the wrong
    /// client, and on Android that means the release build authenticating as
    /// the debug one, which works right up until it reaches a user.
    #[test]
    fn the_four_clients_are_distinct() {
        let ids = [
            DESKTOP_CLIENT_ID,
            IOS_CLIENT_ID,
            ANDROID_DEBUG_CLIENT_ID,
            ANDROID_PLAY_CLIENT_ID,
        ];
        for (i, a) in ids.iter().enumerate() {
            for b in &ids[i + 1..] {
                assert_ne!(a, b, "duplicated client ID");
            }
        }
    }

    #[test]
    fn scheme_is_the_reversed_client_id() {
        assert_eq!(
            reversed_client_scheme(IOS_CLIENT_ID),
            "com.googleusercontent.apps.809304051758-ekp6mq7miacmd1qtjej20tqv2grhs68d"
        );
    }

    #[test]
    fn scheme_derivation_tolerates_a_bare_id() {
        let bare = "809304051758-abc";
        assert_eq!(
            reversed_client_scheme(bare),
            "com.googleusercontent.apps.809304051758-abc"
        );
    }

    #[test]
    fn loopback_uri_carries_the_runtime_port() {
        assert_eq!(
            redirect_uri_string(&RedirectUri::Loopback, 51763),
            "http://127.0.0.1:51763"
        );
    }

    #[test]
    fn custom_scheme_uri_ignores_the_port() {
        let redirect = RedirectUri::CustomScheme("com.googleusercontent.apps.x".into());
        assert_eq!(
            redirect_uri_string(&redirect, 51763),
            "com.googleusercontent.apps.x:/oauth2redirect"
        );
    }

    /// Mobile client types are issued no secret, so a value there means the
    /// wrong branch was taken. Desktop may legitimately be None in a clean
    /// build with no environment variable set, and must degrade to "cloud not
    /// configured" rather than to a broken sign-in.
    #[test]
    fn only_desktop_can_carry_a_client_secret() {
        if cfg!(any(target_os = "ios", target_os = "android")) {
            assert!(CLIENT_SECRET.is_none());
        } else if let Some(secret) = CLIENT_SECRET {
            assert!(
                secret.starts_with("GOCSPX-"),
                "does not look like a Google client secret"
            );
        }
    }

    #[test]
    fn desktop_builds_use_the_desktop_client_and_loopback() {
        assert_eq!(client_id(), DESKTOP_CLIENT_ID);
        assert_eq!(redirect_uri(), RedirectUri::Loopback);
    }
}
