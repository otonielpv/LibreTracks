//! "Abrir con" del sistema operativo: el fichero con el que arranca la app.
//!
//! Las cuatro extensiones de LibreTracks (`.ltsession`, `.ltset`, `.ltpkg` y
//! `.lttemplate`) estan asociadas a la aplicacion en `tauri.conf.json`, pero el
//! sistema solo nos entrega el fichero: en Windows y Linux como argumento de
//! arranque, en macOS como `RunEvent::Opened`. Este modulo lo recoge, lo
//! clasifica y lo deja donde la interfaz pueda recogerlo.
//!
//! El reparto tiene dos caminos porque el fichero puede llegar antes o despues
//! de que exista interfaz:
//!
//! - Arranque en frio: el argumento esta listo mucho antes que el WebView, asi
//!   que se guarda en [`PendingOpenWith`] y la interfaz lo reclama al montar
//!   con [`take_pending_open_with_file`].
//! - Con la app ya abierta (una segunda instancia reenviada por
//!   `tauri-plugin-single-instance`, o un `Opened` de macOS mientras corre): la
//!   interfaz ya escucha, asi que va por el evento [`OPEN_WITH_FILE_EVENT`].
//!
//! El interruptor entre ambos caminos es la propia reclamacion de la interfaz,
//! no un temporizador: hasta que no ha pedido el pendiente no sabemos que haya
//! nadie escuchando el evento, y emitirlo antes lo perderia sin rastro.

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Evento con el que se reparte un fichero que llega con la interfaz ya viva.
pub const OPEN_WITH_FILE_EVENT: &str = "app:open-with-file";

/// Que tipo de fichero nuestro es, ya resuelto en Rust.
///
/// La clasificacion vive aqui y no en la interfaz para que la lista de
/// extensiones que reconocemos exista una sola vez: el mismo mapa filtra los
/// argumentos de arranque y le dice al frontend que flujo lanzar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenWithKind {
    /// `.ltsession` — se abre tal cual.
    Session,
    /// `.ltset` — sesion entera comprimida; hay que importarla a algun sitio.
    Set,
    /// `.ltpkg` — una cancion; necesita una sesion abierta donde entrar.
    SongPackage,
    /// `.lttemplate` — crea una sesion nueva con esa estructura.
    Template,
}

impl OpenWithKind {
    fn from_extension(extension: &str) -> Option<Self> {
        // Sin distinguir mayusculas: Windows conserva el nombre tal cual lo
        // escribio quien exporto el fichero, y un "CANCION.LTPKG" es el mismo
        // tipo de fichero.
        if extension.eq_ignore_ascii_case("ltsession") {
            Some(Self::Session)
        } else if extension.eq_ignore_ascii_case("ltset") {
            Some(Self::Set)
        } else if extension.eq_ignore_ascii_case("ltpkg") {
            Some(Self::SongPackage)
        } else if extension.eq_ignore_ascii_case("lttemplate") {
            Some(Self::Template)
        } else {
            None
        }
    }
}

/// Un fichero de LibreTracks que el sistema nos ha pasado para abrir.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWithFile {
    pub path: String,
    pub kind: OpenWithKind,
}

/// Clasifica una ruta, o `None` si no es uno de nuestros tipos.
///
/// No comprueba que el fichero exista: eso lo verifica cada flujo de apertura,
/// que ya sabe dar el error con el nombre del fichero. Aqui solo decidimos si
/// nos incumbe.
pub fn classify(path: &Path) -> Option<OpenWithFile> {
    let kind = path
        .extension()
        .and_then(|extension| extension.to_str())
        .and_then(OpenWithKind::from_extension)?;
    Some(OpenWithFile {
        path: path.to_string_lossy().into_owned(),
        kind,
    })
}

/// Busca el fichero a abrir entre los argumentos de la linea de ordenes.
///
/// Se salta el primero (la propia ruta del ejecutable) y cualquier cosa que
/// empiece por `-`: el WebView y las herramientas de desarrollo meten sus
/// propias banderas, y macOS anade un `-psn_0_…` al abrir desde el Finder.
/// Devuelve el primero que reconozcamos, porque abrir varias sesiones a la vez
/// no significa nada: la app tiene una sola sesion cargada.
pub fn file_from_args<I, S>(args: I) -> Option<OpenWithFile>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .filter(|argument| !argument.as_ref().starts_with('-'))
        .find_map(|argument| classify(Path::new(argument.as_ref())))
}

#[derive(Default)]
struct PendingState {
    file: Option<OpenWithFile>,
    /// No es "ya se ha entregado algo", sino "la interfaz ya esta viva": se
    /// levanta con la primera llamada a [`take_pending_open_with_file`], aunque
    /// no hubiera nada pendiente.
    claimed: bool,
}

/// El fichero del arranque esperando a que la interfaz lo reclame.
#[derive(Default)]
pub struct PendingOpenWith {
    state: Mutex<PendingState>,
}

impl PendingOpenWith {
    /// Aparca el fichero para que la interfaz lo recoja al montar, o lo
    /// devuelve si ya no hace falta porque la interfaz esta viva.
    ///
    /// La comprobacion y el aparcado van bajo el MISMO cerrojo a proposito.
    /// Separados dejan una rendija — mirar "¿hay interfaz?", que la interfaz
    /// reclame justo entonces, y aparcar despues en un hueco que ya nadie
    /// volvera a mirar — por la que el fichero desaparece sin error. Es
    /// estrecha pero real: en macOS el `Opened` llega por el hilo principal
    /// mientras la reclamacion viene del threadpool.
    ///
    /// Si ya habia otro aparcado, gana el ultimo. Solo pasa si el sistema
    /// entrega dos ficheros antes de que exista el WebView (macOS puede mandar
    /// varios `Opened` seguidos), y abrir el ultimo es lo mismo que hace la app
    /// cuando abres dos sesiones seguidas a mano.
    fn park_unless_claimed(&self, file: OpenWithFile) -> Option<OpenWithFile> {
        let Ok(mut state) = self.state.lock() else {
            // Cerrojo envenenado: mejor intentar el evento que tragarse el
            // fichero en un hueco que ya no se puede leer.
            return Some(file);
        };
        if state.claimed {
            return Some(file);
        }
        state.file = Some(file);
        None
    }

    fn take(&self) -> Option<OpenWithFile> {
        let Ok(mut state) = self.state.lock() else {
            return None;
        };
        state.claimed = true;
        state.file.take()
    }
}

/// Reparte un fichero por el camino que corresponda segun haya interfaz o no.
///
/// Es el unico punto por el que entran los tres origenes (argumentos del
/// arranque, segunda instancia y `Opened` de macOS), para que la decision de
/// "aparcar o emitir" no se duplique en tres sitios con tres criterios.
pub fn deliver(app: &AppHandle, file: OpenWithFile) {
    let pending = app.state::<PendingOpenWith>();
    let Some(file) = pending.park_unless_claimed(file) else {
        return;
    };
    if let Err(error) = app.emit(OPEN_WITH_FILE_EVENT, file) {
        eprintln!("[libretracks-open-with] no se pudo repartir el fichero: {error}");
    }
}

/// Elige el fichero de entre las URLs de un `RunEvent::Opened` de macOS.
///
/// El Finder manda URLs `file://`, y puede mandar varias de golpe si el usuario
/// selecciona un puñado y pulsa Intro. Como en los argumentos de arranque, nos
/// quedamos con la primera que reconozcamos: la app carga una sesion.
///
/// Separado de [`deliver_opened_urls`] y SIN `cfg` a proposito. El evento que
/// lo alimenta solo existe en macOS, pero el cuerpo no depende del sistema, y
/// dejarlo detras de un `#[cfg(target_os = "macos")]` significaria que ningun
/// `cargo check` ni ningun test de Windows/Linux lo mira: se rompe en silencio
/// hasta que alguien compila para Mac.
pub fn file_from_opened_urls(urls: &[tauri::Url]) -> Option<OpenWithFile> {
    urls.iter()
        .filter_map(|url| url.to_file_path().ok())
        .find_map(|path| classify(&path))
}

/// Reparte el fichero de un `RunEvent::Opened` de macOS.
///
/// Solo escritorio, por el mismo motivo que [`focus_main_window`], a quien
/// llama: en movil no compilaria. Su unico llamante esta bajo
/// `cfg(target_os = "macos")`, de ahi el `allow(dead_code)` en el resto de
/// escritorios.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn deliver_opened_urls(app: &AppHandle, urls: &[tauri::Url]) {
    let Some(file) = file_from_opened_urls(urls) else {
        return;
    };
    focus_main_window(app);
    deliver(app, file);
}

/// Trae la ventana principal al frente.
///
/// Al abrir un fichero con la app ya arrancada el sistema no la enfoca por
/// nosotros (la segunda instancia muere antes de tener ventana), asi que sin
/// esto el usuario hace doble click y no ve pasar nada: la sesion se carga
/// detras de la ventana que tuviera delante.
///
/// Solo escritorio. `unminimize`, `show` y `set_focus` no existen en la
/// `WebviewWindow` de movil, asi que en Android e iOS esto ni siquiera
/// compila; y alli no hay ventanas que enfocar ni instancia unica que
/// reenvie nada. Su unico llamante vive bajo el mismo `cfg`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn focus_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// El fichero con el que se abrio la app, si lo hubo.
///
/// Devuelve `None` en el arranque normal. Vaciar el hueco al leerlo es
/// deliberado: una recarga del WebView (o el `StrictMode` de desarrollo, que
/// monta dos veces) no debe reabrir la sesion por segunda vez.
#[tauri::command(async)]
pub fn take_pending_open_with_file(
    pending: State<'_, PendingOpenWith>,
) -> Option<OpenWithFile> {
    pending.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_associated_extension_is_recognised() {
        let cases = [
            ("C:/musica/Directo.ltsession", OpenWithKind::Session),
            ("C:/musica/Directo.ltset", OpenWithKind::Set),
            ("C:/musica/Cancion.ltpkg", OpenWithKind::SongPackage),
            ("C:/musica/Banda.lttemplate", OpenWithKind::Template),
        ];
        for (path, expected) in cases {
            assert_eq!(
                classify(Path::new(path)).map(|file| file.kind),
                Some(expected),
                "no se reconocio {path}"
            );
        }
    }

    #[test]
    fn extension_case_does_not_matter() {
        assert_eq!(
            classify(Path::new("D:/Sesiones/DIRECTO.LTSESSION")).map(|file| file.kind),
            Some(OpenWithKind::Session)
        );
    }

    #[test]
    fn other_files_are_not_ours() {
        for path in ["pista.wav", "notas.txt", "sesion", "proyecto.als"] {
            assert_eq!(classify(Path::new(path)), None, "{path} no deberia colar");
        }
    }

    #[test]
    fn the_executable_path_is_never_the_file_to_open() {
        // El caso que motiva el `skip(1)`: si alguien renombra el ejecutable
        // con una extension nuestra, argv[0] no puede convertirse en la sesion
        // que se abre.
        assert_eq!(file_from_args(["LibreTracks.ltsession"]), None);
    }

    #[test]
    fn the_file_is_picked_out_of_the_launch_arguments() {
        let file = file_from_args([
            "C:/Program Files/LibreTracks/LibreTracks.exe",
            "D:/Sesiones/Domingo.ltsession",
        ]);
        assert_eq!(
            file,
            Some(OpenWithFile {
                path: "D:/Sesiones/Domingo.ltsession".to_string(),
                kind: OpenWithKind::Session,
            })
        );
    }

    #[test]
    fn flags_are_skipped() {
        // `-psn_0_…` es lo que anade macOS al lanzar desde el Finder, y las
        // banderas de WebKit aparecen en desarrollo.
        let file = file_from_args([
            "/Applications/LibreTracks.app/Contents/MacOS/LibreTracks",
            "-psn_0_774321",
            "--disable-gpu",
            "/Users/ana/Directo.ltset",
        ]);
        assert_eq!(file.map(|file| file.kind), Some(OpenWithKind::Set));
    }

    #[test]
    fn only_the_first_recognised_file_is_used() {
        // Seleccionar varias sesiones y pulsar Intro las manda todas de golpe.
        // La app carga una sesion, no cuatro.
        let file = file_from_args([
            "LibreTracks.exe",
            "D:/a.ltsession",
            "D:/b.ltsession",
        ]);
        assert_eq!(file.map(|file| file.path), Some("D:/a.ltsession".to_string()));
    }

    #[test]
    fn a_launch_without_a_file_yields_nothing() {
        assert_eq!(file_from_args(["LibreTracks.exe"]), None);
        assert_eq!(file_from_args(Vec::<String>::new()), None);
    }

    #[test]
    fn a_finder_url_becomes_the_file_to_open() {
        // `from_file_path` produce la misma forma `file://` que manda el Finder,
        // y va y vuelve en cualquier sistema, asi que el test corre igual en el
        // Windows del que se desarrolla que en el Mac donde de verdad ocurre.
        let session = std::env::temp_dir().join("Domingo.ltsession");
        let url = tauri::Url::from_file_path(&session).expect("ruta absoluta");

        let file = file_from_opened_urls(&[url]).expect("deberia reconocerse");
        assert_eq!(file.kind, OpenWithKind::Session);
        assert_eq!(file.path, session.to_string_lossy());
    }

    #[test]
    fn urls_that_are_not_ours_are_ignored() {
        let audio = tauri::Url::from_file_path(std::env::temp_dir().join("pista.wav"))
            .expect("ruta absoluta");
        let set = tauri::Url::from_file_path(std::env::temp_dir().join("Directo.ltset"))
            .expect("ruta absoluta");

        assert_eq!(file_from_opened_urls(&[]), None);
        assert_eq!(file_from_opened_urls(&[audio.clone()]), None);
        // Y con mezcla, se salta la que no nos toca en vez de rendirse.
        assert_eq!(
            file_from_opened_urls(&[audio, set]).map(|file| file.kind),
            Some(OpenWithKind::Set)
        );
    }

    fn session(path: &str) -> OpenWithFile {
        OpenWithFile {
            path: path.to_string(),
            kind: OpenWithKind::Session,
        }
    }

    #[test]
    fn a_parked_file_is_handed_over_once() {
        let pending = PendingOpenWith::default();

        assert_eq!(
            pending.park_unless_claimed(session("D:/Domingo.ltsession")),
            None,
            "sin interfaz aun, el fichero se aparca en vez de emitirse"
        );
        assert_eq!(pending.take(), Some(session("D:/Domingo.ltsession")));
        // Una recarga del WebView vuelve a pedirlo y no debe reabrir nada.
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn once_the_frontend_has_asked_the_file_is_returned_to_be_emitted() {
        let pending = PendingOpenWith::default();
        // Reclamar sin nada pendiente igualmente prueba que hay interfaz.
        assert_eq!(pending.take(), None);

        assert_eq!(
            pending.park_unless_claimed(session("D:/Domingo.ltsession")),
            Some(session("D:/Domingo.ltsession")),
            "con interfaz viva hay que emitirlo, no aparcarlo"
        );
    }

    #[test]
    fn a_file_is_never_parked_into_a_slot_nobody_will_read() {
        // La rendija que cierra el cerrojo compartido: en macOS el `Opened`
        // llega por el hilo principal y la reclamacion por el threadpool, asi
        // que "¿hay interfaz?" y "aparcar" tienen que ser un solo paso. Si se
        // aparta despues de reclamar, ese fichero no lo lee nadie nunca.
        let pending = PendingOpenWith::default();
        assert_eq!(pending.take(), None);

        let _ = pending.park_unless_claimed(session("D:/Domingo.ltsession"));

        assert_eq!(
            pending.take(),
            None,
            "el hueco tiene que seguir vacio: quien reparte ya se llevo el fichero al evento"
        );
    }

    #[test]
    fn the_last_file_wins_while_there_is_no_frontend() {
        let pending = PendingOpenWith::default();
        let _ = pending.park_unless_claimed(session("D:/Primera.ltsession"));
        let _ = pending.park_unless_claimed(session("D:/Segunda.ltsession"));

        assert_eq!(pending.take(), Some(session("D:/Segunda.ltsession")));
    }
}
