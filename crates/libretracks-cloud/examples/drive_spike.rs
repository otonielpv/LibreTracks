//! Validates the one assumption the whole cloud feature rests on.
//!
//! # The question
//!
//! With the `drive.file` scope, an app sees only the files it created. The
//! feature needs a *second device* to see what the first one uploaded, so the
//! grant has to belong to the OAuth client and the user, not to an
//! installation. Everything else is ordinary work; if this is wrong, there is
//! no feature.
//!
//! # How this answers it without two machines
//!
//! A second device, to Google, is the same client ID and the same account with
//! no local token: it authorises from scratch. So:
//!
//! ```text
//! cargo run -p libretracks-cloud --example drive_spike -- upload
//! cargo run -p libretracks-cloud --example drive_spike -- reset
//! cargo run -p libretracks-cloud --example drive_spike -- list
//! ```
//!
//! `reset` throws away the local token, so `list` has to sign in again — which
//! is exactly what a phone does the first time. If that listing shows the file
//! `upload` created, the assumption holds.
//!
//! The token is kept in a plain JSON file next to the target directory, NOT in
//! a keychain. That is deliberate for a throwaway diagnostic and is precisely
//! what the shipped app must never do.

use std::error::Error;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

use libretracks_cloud::google::drive::DriveClient;
use libretracks_cloud::google::oauth::AuthSession;
use libretracks_cloud::loopback::LoopbackListener;
use libretracks_cloud::token::{exchange_code, StoredToken, TokenManager, TokenStore};
use libretracks_cloud::{CloudError, CloudStorage, RemoteFolder};

/// Token storage for the spike only: a JSON file, no encryption, easy to delete.
struct FileTokenStore {
    path: PathBuf,
}

impl TokenStore for FileTokenStore {
    fn load(&self) -> Result<Option<StoredToken>, CloudError> {
        match fs::read_to_string(&self.path) {
            Ok(raw) => Ok(serde_json::from_str(&raw).ok()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(CloudError::Io(e)),
        }
    }

    fn save(&self, token: &StoredToken) -> Result<(), CloudError> {
        let raw = serde_json::to_string_pretty(token)
            .map_err(|e| CloudError::Network(e.to_string()))?;
        fs::write(&self.path, raw).map_err(CloudError::Io)
    }

    fn clear(&self) -> Result<(), CloudError> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(CloudError::Io(e)),
        }
    }
}

fn token_path() -> PathBuf {
    std::env::temp_dir().join("libretracks-drive-spike-token.json")
}

/// Open the authorization URL in the default browser.
///
/// Note what is NOT used on Windows: `cmd /C start`. An OAuth URL is mostly
/// `&`-separated parameters and `cmd` treats `&` as a command separator, so it
/// chops the URL at the first one and hands Google a request with nothing but
/// `client_id` — which comes back as "Required parameter is missing:
/// response_type". `explorer.exe` takes the URL as a single argument with no
/// shell in the way.
///
/// The real app has no such problem: it opens URLs through
/// `tauri-plugin-opener`, which is already a dependency.
fn open_in_browser(url: &str) {
    // Printed unconditionally: if the launch silently opens nothing, or opens
    // the wrong browser profile, the URL is right there to paste.
    println!("\nURL de autorizacion:\n{url}\n");

    let result = if cfg!(target_os = "windows") {
        // Not `explorer.exe` either: handed a URL it will sometimes decide to
        // open a File Explorer window instead of the default browser.
        // `url.dll,FileProtocolHandler` is the documented URL handler and does
        // what ShellExecute would.
        Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(url).spawn()
    } else {
        Command::new("xdg-open").arg(url).spawn()
    };
    if result.is_err() {
        println!("No he podido abrir el navegador: pega la URL de arriba a mano.");
    }
}

/// Full sign-in: browser, redirect, code exchange.
async fn sign_in(store: &FileTokenStore) -> Result<(), Box<dyn Error>> {
    let listener = LoopbackListener::bind().await?;
    let session = AuthSession::begin(listener.port())?;

    println!("Escuchando en 127.0.0.1:{}", listener.port());
    println!("Abriendo el navegador para autorizar...");
    open_in_browser(&session.authorization_url());

    let params = listener.wait_for_redirect().await?;
    // Never skip this. Anything on the machine can reach the loopback socket;
    // only the flow that started this sign-in knows the state value.
    session.verify_state(&params.state)?;

    let token = exchange_code(&session, &params.code).await?;
    store.save(&token)?;
    println!("Sesion iniciada y token guardado en {}", token_path().display());
    Ok(())
}

async fn client(store_path: PathBuf) -> Result<DriveClient, Box<dyn Error>> {
    let store = FileTokenStore { path: store_path };
    if store.load()?.is_none() {
        sign_in(&store).await?;
    }
    let manager = TokenManager::new(Box::new(FileTokenStore { path: token_path() }))?;
    Ok(DriveClient::new(Box::new(manager))?)
}

fn human(bytes: u64) -> String {
    const MB: f64 = 1_048_576.0;
    format!("{:.1} MB", bytes as f64 / MB)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let command = std::env::args().nth(1).unwrap_or_else(|| "list".to_string());

    if command == "reset" {
        FileTokenStore { path: token_path() }.clear()?;
        println!("Token local borrado. La proxima orden se autorizara desde cero,");
        println!("que es exactamente lo que hace un segundo dispositivo.");
        return Ok(());
    }

    let drive = client(token_path()).await?;

    let quota = drive.quota().await?;
    match quota.limit_bytes {
        Some(limit) => println!(
            "\nCuenta: {} usados de {} ({} libres)",
            human(quota.used_bytes),
            human(limit),
            human(quota.free_bytes().unwrap_or(0))
        ),
        None => println!("\nCuenta sin limite de cuota ({} usados)", human(quota.used_bytes)),
    }

    if command == "upload" {
        // Named .ltset so RemoteFolder::for_path files it under Sessions, the
        // same routing the real upload path uses.
        let temp = std::env::temp_dir().join("spike-prueba.ltset");
        let mut f = fs::File::create(&temp)?;
        writeln!(f, "paquete de prueba de LibreTracks")?;
        drop(f);

        let folder = RemoteFolder::for_path(&temp).expect("un .ltset se enruta a Sessions");
        println!("Subiendo {} a LibreTracks/{}...", temp.display(), folder.folder_name());

        let uploaded = drive
            .upload(folder, &temp, "spike-prueba.ltset", &|done, total| {
                if total > 0 {
                    print!("\r  {}%   ", done * 100 / total);
                    let _ = std::io::stdout().flush();
                }
            })
            .await?;
        println!("\nSubido con id {}", uploaded.id);
    }

    for folder in [RemoteFolder::Songs, RemoteFolder::Sessions] {
        let files = drive.list(folder).await?;
        println!("\nLibreTracks/{} — {} archivo(s)", folder.folder_name(), files.len());
        for file in &files {
            println!(
                "  {}  ({}) {}",
                file.name,
                human(file.size_bytes),
                file.modified.as_deref().unwrap_or("")
            );
        }
    }

    println!("\nSi acabas de hacer `reset` y aqui sale el archivo de la subida");
    println!("anterior, la suposicion se confirma y la funcion es viable.");
    Ok(())
}
