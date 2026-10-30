//! Paso 01 del plan cloud-providers: probar OneDrive y Dropbox (y Drive)
//! contra las cuentas reales antes de fiarse de los tests offline.
//!
//! # Antes de nada: las credenciales
//!
//! Los client id entran en compilación, así que hay que exportarlos ANTES de
//! `cargo run` (build.rs recompila al cambiarlos):
//!
//! ```text
//! LIBRETRACKS_ONEDRIVE_CLIENT_ID=<Application (client) ID de Azure>
//! LIBRETRACKS_DROPBOX_APP_KEY=<App key de la consola de Dropbox>
//! ```
//!
//! # Órdenes
//!
//! ```text
//! cargo run -p libretracks-cloud --example provider_spike -- onedrive list
//! cargo run -p libretracks-cloud --example provider_spike -- onedrive upload
//! cargo run -p libretracks-cloud --example provider_spike -- onedrive big 1024
//! cargo run -p libretracks-cloud --example provider_spike -- onedrive refresh
//! cargo run -p libretracks-cloud --example provider_spike -- onedrive reset
//! ```
//!
//! (`dropbox` o `google-drive` en lugar de `onedrive`.)
//!
//! - `list`: cuota de la CUENTA y lo que hay en Songs/ y Sessions/.
//! - `upload`: sube un `.ltset` diminuto.
//! - `big N`: genera N MiB pseudoaleatorios y los sube por trozos; para el
//!   corte a mitad, desconecta la wifi durante la subida y vuelve a
//!   conectarla: debe reanudar, no empezar de cero. Después bájalo con
//!   `fetch <id>` y compara el SHA-256 que imprimen las dos órdenes.
//! - `fetch ID`: descarga un archivo e imprime su SHA-256.
//! - `refresh`: caduca el access token a mano y pide otro. En OneDrive el
//!   refresh token guardado DEBE cambiar (rotación); en Dropbox, no.
//! - `reset`: borra el token local. La siguiente orden autoriza desde cero,
//!   que es lo que hace un dispositivo nuevo: `list` tras `reset` debe ver lo
//!   subido antes.
//!
//! El token va a un JSON en la carpeta temporal, NO al llavero. Vale para un
//! diagnóstico de usar y tirar y es justo lo que la app nunca debe hacer.

use std::error::Error;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

use sha2::{Digest, Sha256};

use libretracks_cloud::redirect::RedirectParams;
use libretracks_cloud::token::{exchange_code, StoredToken, TokenManager, TokenStore};
use libretracks_cloud::{AccessTokens, CloudError, CloudProvider, CloudStorage, RemoteFolder};

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

fn token_path(provider: CloudProvider) -> PathBuf {
    std::env::temp_dir().join(format!("libretracks-spike-{}.json", provider.key()))
}

fn store(provider: CloudProvider) -> Box<FileTokenStore> {
    Box::new(FileTokenStore {
        path: token_path(provider),
    })
}

/// Same launcher as drive_spike: `rundll32` on Windows because `cmd /C start`
/// chops an OAuth URL at the first `&`.
fn open_in_browser(url: &str) {
    println!("\nURL de autorizacion:\n{url}\n");
    let result = if cfg!(target_os = "windows") {
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

async fn sign_in(provider: CloudProvider) -> Result<(), Box<dyn Error>> {
    if !provider.is_configured() {
        return Err(format!(
            "{} no esta configurado en esta compilacion: exporta su client id y recompila",
            provider.display_name()
        )
        .into());
    }
    let oauth = provider.oauth();
    let listener = provider.bind_loopback().await?;
    let session = provider.begin_sign_in(listener.port())?;
    println!("Escuchando en 127.0.0.1:{}", listener.port());
    println!("Redirect enviada: {}", session.redirect_uri());
    open_in_browser(&oauth.authorization_url(&session));

    let RedirectParams { code, state } = listener.wait_for_redirect().await?;
    session.verify_state(&state)?;
    let token = exchange_code(oauth.as_ref(), &session, &code).await?;
    store(provider).save(&token)?;
    println!("Sesion iniciada; token en {}", token_path(provider).display());
    Ok(())
}

fn manager(provider: CloudProvider) -> Result<TokenManager, CloudError> {
    TokenManager::new(provider.oauth(), store(provider))
}

fn human(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1_048_576.0)
}

fn sha256_of(path: &PathBuf) -> Result<String, Box<dyn Error>> {
    let mut hasher = Sha256::new();
    let mut file = fs::File::open(path)?;
    std::io::copy(&mut file, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn print_progress(done: u64, total: u64) {
    if total > 0 {
        print!("\r  {}% ({} de {})   ", done * 100 / total, human(done), human(total));
        let _ = std::io::stdout().flush();
    }
}

async fn upload(
    storage: &dyn CloudStorage,
    path: &PathBuf,
    name: &str,
) -> Result<(), Box<dyn Error>> {
    println!("SHA-256 local: {}", sha256_of(path)?);
    let started = std::time::Instant::now();
    let uploaded = storage
        .upload(RemoteFolder::Sessions, path, name, &print_progress, &|| false)
        .await?;
    println!(
        "\nSubido como {} (id {}) en {:.1} s",
        uploaded.name,
        uploaded.id,
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let provider = args
        .next()
        .and_then(|key| CloudProvider::from_key(&key))
        .ok_or("primer argumento: google-drive | onedrive | dropbox")?;
    let command = args.next().unwrap_or_else(|| "list".to_string());
    let extra = args.next();

    if command == "reset" {
        store(provider).clear()?;
        println!("Token local borrado: la proxima orden autoriza desde cero.");
        return Ok(());
    }

    if store(provider).load()?.is_none() {
        sign_in(provider).await?;
    }

    if command == "refresh" {
        let before = store(provider).load()?.ok_or("sin token")?;
        let mut expired = before.clone();
        expired.expires_at_unix = 0;
        store(provider).save(&expired)?;
        manager(provider)?.access_token().await?;
        let after = store(provider).load()?.ok_or("el refresco borro el token")?;
        println!(
            "Refresco correcto. Refresh token {}.",
            if after.refresh_token != before.refresh_token {
                "ROTADO (esperado en OneDrive)"
            } else {
                "sin cambios (esperado en Drive y Dropbox)"
            }
        );
        return Ok(());
    }

    let storage = provider.storage(Box::new(manager(provider)?))?;
    match storage.quota().await {
        Ok(quota) => match quota.limit_bytes {
            Some(limit) => println!(
                "\nCuenta: {} usados de {} ({} libres)",
                human(quota.used_bytes),
                human(limit),
                human(quota.free_bytes().unwrap_or(0))
            ),
            None => println!("\nCuenta sin limite ({} usados)", human(quota.used_bytes)),
        },
        // Pending verification for OneDrive: whether /me/drive answers with
        // only Files.ReadWrite.AppFolder granted.
        Err(e) => println!("\nNo se pudo leer la cuota: {e}"),
    }

    match command.as_str() {
        "upload" => {
            let path = std::env::temp_dir().join("spike-prueba.ltset");
            fs::write(&path, "paquete de prueba de LibreTracks\n")?;
            upload(storage.as_ref(), &path, "spike-prueba.ltset").await?;
        }
        "big" => {
            let mib: u64 = extra.as_deref().unwrap_or("1024").parse()?;
            let path = std::env::temp_dir().join(format!("spike-{mib}MiB.ltset"));
            if !path.exists() {
                println!("Generando {mib} MiB...");
                let mut out = std::io::BufWriter::new(fs::File::create(&path)?);
                let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
                let mut block = vec![0u8; 1024 * 1024];
                for _ in 0..mib {
                    for chunk in block.chunks_mut(8) {
                        x ^= x << 13;
                        x ^= x >> 7;
                        x ^= x << 17;
                        chunk.copy_from_slice(&x.to_le_bytes()[..chunk.len()]);
                    }
                    out.write_all(&block)?;
                }
            }
            upload(storage.as_ref(), &path, &format!("spike-{mib}MiB.ltset")).await?;
        }
        "fetch" => {
            let id = extra.ok_or("fetch necesita el id del archivo")?;
            let dest = std::env::temp_dir().join("spike-descargado.ltset");
            storage.download(&id, &dest, &print_progress, &|| false).await?;
            println!("\nSHA-256 descargado: {}", sha256_of(&dest)?);
        }
        _ => {}
    }

    for folder in [RemoteFolder::Songs, RemoteFolder::Sessions] {
        let files = storage.list(folder).await?;
        println!("\n{} — {} archivo(s)", folder.folder_name(), files.len());
        for file in &files {
            println!(
                "  {}  ({})  id={}  {}",
                file.name,
                human(file.size_bytes),
                file.id,
                file.modified.as_deref().unwrap_or("")
            );
        }
    }
    Ok(())
}
