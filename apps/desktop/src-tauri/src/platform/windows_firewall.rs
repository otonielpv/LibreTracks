//! El cortafuegos de Windows y LibreTracks Remote.
//!
//! Para que el movil llegue al servidor del Remote (escucha en `0.0.0.0:3030`)
//! hace falta una regla de ENTRADA que permita este ejecutable en el perfil de
//! red que Windows tenga activo. Nada de eso lo resuelve el instalador:
//!
//! - `installMode` es `currentUser`, asi que la plantilla NSIS emite
//!   `RequestExecutionLevel user` y el instalador NO se eleva. Su `netsh` falla
//!   con "La operacion solicitada requiere elevacion" y la regla no se crea.
//! - Lo unico que existe es la regla que crea el aviso de Windows la PRIMERA
//!   vez que la app escucha. Ese aviso trae unas casillas de perfil y solo sale
//!   una vez por programa: quien las marque mal se queda con una regla que, por
//!   ejemplo, solo cubre `Public`, y en el wifi de casa (que Windows clasifica
//!   como `Private`) el Remote deja de funcionar sin volver a preguntar nunca.
//!
//! De ahi los dos comandos de este modulo: mirar si la regla cubre de verdad la
//! red conectada, y —si no— crearla bien con una unica elevacion.
//!
//! ## Por que PowerShell y no `netsh` a secas
//!
//! Para CONSULTAR hay que leer la respuesta, y la de `netsh` viene traducida al
//! idioma del sistema ("Nombre de regla:", "Perfiles:"). Los cmdlets
//! `Get-NetFirewallRule` / `Get-NetConnectionProfile` devuelven valores de
//! enumeracion en ingles pase lo que pase, asi que el analisis no depende del
//! idioma de quien instala. Para ESCRIBIR si se usa `netsh`, que no necesita
//! leerse.
//!
//! ## Por que casi todo esta fuera del `cfg`
//!
//! Solo el lanzamiento del proceso es de Windows. La construccion de los
//! guiones y el analisis de su salida —donde estan los errores de verdad— viven
//! fuera del `#[cfg(windows)]` para que `cargo check` y los tests de macOS y
//! Linux los compilen y los ejerciten.

use serde::Serialize;

/// Nombre de la regla que crea [`build_allow_script`].
///
/// El mismo que usaba el hook del instalador, para que una instalacion elevada
/// (o una futura `perMachine`) y este arreglo no dejen dos reglas distintas
/// diciendo lo mismo.
pub const RULE_NAME: &str = "LibreTracks Remote";

/// Como esta el cortafuegos respecto al Remote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FirewallStatus {
    /// Fuera de Windows no hay nada que mirar ni que ofrecer.
    pub supported: bool,
    /// Hemos podido averiguarlo. Si es `false` la interfaz ofrece el arreglo
    /// igualmente: no saber no es motivo para esconder el boton.
    pub known: bool,
    /// Hay regla de entrada activa para este ejecutable en TODOS los perfiles
    /// de las redes conectadas ahora mismo.
    pub covered: bool,
    /// Perfiles de las redes conectadas ("Private", "Public", "Domain").
    pub active_profiles: Vec<String>,
    /// Perfiles que cubren las reglas que ya existen.
    pub allowed_profiles: Vec<String>,
}

impl FirewallStatus {
    /// La respuesta fuera de Windows: no aplica y no se pregunta.
    pub fn unsupported() -> Self {
        Self {
            supported: false,
            known: true,
            covered: true,
            ..Default::default()
        }
    }

    /// Windows, pero la consulta no salio adelante.
    ///
    /// `covered: false` a proposito: ante la duda la interfaz enseña el
    /// arreglo. Equivocarse hacia "te ofrezco un boton que no necesitabas"
    /// cuesta un clic; hacia el otro lado cuesta un Remote que no conecta y
    /// ninguna pista de por que.
    pub fn unknown() -> Self {
        Self {
            supported: true,
            known: false,
            covered: false,
            ..Default::default()
        }
    }
}

/// Normaliza un perfil de red al vocabulario de las reglas.
///
/// `Get-NetConnectionProfile` llama `DomainAuthenticated` a lo que las reglas
/// llaman `Domain`; sin traducirlo, un portatil en el dominio de una empresa
/// pareceria siempre descubierto.
fn normalize_profile(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = if trimmed.eq_ignore_ascii_case("domainauthenticated") {
        "Domain"
    } else if trimmed.eq_ignore_ascii_case("domain") {
        "Domain"
    } else if trimmed.eq_ignore_ascii_case("private") {
        "Private"
    } else if trimmed.eq_ignore_ascii_case("public") {
        "Public"
    } else if trimmed.eq_ignore_ascii_case("any") {
        "Any"
    } else {
        // `NotApplicable`, `NotConfigured` y cualquier cosa que Microsoft
        // añada: no sabemos que es, no lo contamos como cubierto.
        return None;
    };
    Some(normalized.to_string())
}

fn parse_list(line: &str) -> Vec<String> {
    line.split(',')
        .filter_map(normalize_profile)
        .fold(Vec::new(), |mut unique, profile| {
            if !unique.contains(&profile) {
                unique.push(profile);
            }
            unique
        })
}

/// Interpreta la salida del guion de consulta.
///
/// Formato, dos lineas: `ALLOWED=Public,Private` y `ACTIVE=Public`. Se eligio
/// texto plano y no JSON porque `ConvertTo-Json` de PowerShell 5.1 desenvuelve
/// las listas de un solo elemento, y "una sola red conectada" es justo el caso
/// normal: el JSON llegaria unas veces como lista y otras como cadena.
pub fn parse_status(output: &str) -> FirewallStatus {
    let mut allowed: Option<Vec<String>> = None;
    let mut active: Option<Vec<String>> = None;

    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("ALLOWED=") {
            allowed = Some(parse_list(rest));
        } else if let Some(rest) = line.strip_prefix("ACTIVE=") {
            active = Some(parse_list(rest));
        }
    }

    // Sin las DOS marcas no hemos hablado con el guion, sino con un error
    // suelto o una salida a medias. No inventamos un veredicto.
    let (Some(allowed_profiles), Some(active_profiles)) = (allowed, active) else {
        return FirewallStatus::unknown();
    };

    FirewallStatus {
        supported: true,
        known: true,
        covered: is_covered(&active_profiles, &allowed_profiles),
        active_profiles,
        allowed_profiles,
    }
}

/// Si las reglas existentes cubren todas las redes conectadas.
///
/// Sin ninguna red conectada damos por cubierto: no hay nadie a quien dejar
/// fuera, y avisar de un problema de conectividad cuando no hay red seria
/// ruido.
fn is_covered(active: &[String], allowed: &[String]) -> bool {
    if active.is_empty() {
        return true;
    }
    if allowed.iter().any(|profile| profile == "Any") {
        return true;
    }
    active.iter().all(|profile| allowed.contains(profile))
}

/// Escapa una ruta para meterla en una cadena entre comillas simples de
/// PowerShell, donde la comilla simple se duplica.
fn quote_for_powershell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Guion que responde que perfiles cubre la regla y en cuales estamos.
///
/// Cruza por el filtro de aplicacion (`Get-NetFirewallApplicationFilter -All`)
/// y no rule a rule: una consulta en bloque en vez de una llamada COM por cada
/// regla del sistema, que en un equipo con cientos tarda segundos.
pub fn build_status_script(executable: &str) -> String {
    let exe = quote_for_powershell(executable);
    format!(
        r#"$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$exe = {exe}
$allowed = @()
$filters = @(Get-NetFirewallApplicationFilter -All | Where-Object {{ $_.Program -and ($_.Program -ieq $exe) }})
foreach ($rule in @($filters | Get-NetFirewallRule)) {{
  if ($rule.Direction -eq 'Inbound' -and "$($rule.Enabled)" -eq 'True' -and $rule.Action -eq 'Allow') {{
    $allowed += ($rule.Profile.ToString() -split '\s*,\s*')
  }}
}}
$active = @(Get-NetConnectionProfile | ForEach-Object {{ $_.NetworkCategory.ToString() }})
Write-Output ("ALLOWED=" + (($allowed | Sort-Object -Unique) -join ','))
Write-Output ("ACTIVE=" + (($active | Sort-Object -Unique) -join ','))"#
    )
}

/// Guion que corre YA ELEVADO y deja una sola regla correcta.
///
/// Borra primero cualquier regla de este ejecutable. Es lo que limpia la regla
/// a medias del aviso de Windows —la que solo cubre `Public`— en vez de dejarla
/// al lado de la buena: cuatro reglas para el mismo programa no las descifra
/// nadie, y una regla mas restrictiva conviviendo con la nuestra invita a creer
/// que manda ella.
///
/// `profile=any` (Domain+Private+Public) porque el problema que arregla esto es
/// precisamente que Windows clasifique el wifi al reves de lo que el usuario
/// espera. Limitarlo a Private nos devolveria al mismo sitio en cuanto una red
/// domestica saliera como Public.
pub fn build_allow_script(executable: &str) -> String {
    let exe = quote_for_powershell(executable);
    format!(
        r#"$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$exe = {exe}
netsh advfirewall firewall delete rule name=all dir=in program="$exe" | Out-Null
netsh advfirewall firewall add rule name="{RULE_NAME}" dir=in action=allow program="$exe" enable=yes profile=any description="Permite conectar la app LibreTracks Remote desde el movil en la red local."
if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}"#
    )
}

/// Envuelve el guion elevado en el que pide la elevacion.
///
/// Va por `-EncodedCommand` (base64 UTF-16LE) para no anidar tres niveles de
/// comillas entre Rust, la PowerShell que lanzamos y la PowerShell elevada: el
/// base64 no lleva comillas ni espacios, asi que se incrusta sin escapar nada.
///
/// `-Wait` para saber cuando ha terminado y poder volver a consultar el estado,
/// y `-Verb RunAs` es lo que saca el UAC. Si el usuario lo cancela, PowerShell
/// lanza un error y salimos con codigo distinto de cero: cancelar no es exito.
pub fn build_elevation_script(encoded_inner: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'\n\
         $p = Start-Process -FilePath 'powershell' -Verb RunAs -Wait -WindowStyle Hidden \
         -PassThru -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','{encoded_inner}'\n\
         exit $p.ExitCode"
    )
}

/// Codifica un guion como espera `-EncodedCommand`: UTF-16LE en base64.
pub fn encode_powershell_command(script: &str) -> String {
    use base64::Engine as _;
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

#[cfg(windows)]
fn run_powershell(script: &str) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    /// Sin esto parpadea una consola negra por cada consulta.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &encode_powershell_command(script),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("no se pudo consultar el cortafuegos: {error}"))
}

/// Como esta el cortafuegos para este ejecutable.
#[cfg(windows)]
pub fn status() -> FirewallStatus {
    let Ok(executable) = std::env::current_exe() else {
        return FirewallStatus::unknown();
    };
    let script = build_status_script(&executable.to_string_lossy());
    match run_powershell(&script) {
        Ok(output) => parse_status(&String::from_utf8_lossy(&output.stdout)),
        Err(_) => FirewallStatus::unknown(),
    }
}

#[cfg(not(windows))]
pub fn status() -> FirewallStatus {
    FirewallStatus::unsupported()
}

/// Crea la regla, pidiendo elevacion una sola vez.
///
/// Devuelve el estado ya recomprobado, no un simple "ha ido bien": lo que le
/// importa a quien pulsa el boton es si ahora el movil va a conectar, y el
/// codigo de salida de `netsh` no responde a eso.
#[cfg(windows)]
pub fn allow() -> Result<FirewallStatus, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("no se pudo localizar el ejecutable: {error}"))?;
    let inner = encode_powershell_command(&build_allow_script(&executable.to_string_lossy()));
    let output = run_powershell(&build_elevation_script(&inner))?;

    if !output.status.success() {
        // El caso corriente aqui es que el usuario dijera que no al UAC. No es
        // un fallo del programa, asi que se cuenta como tal y no como error
        // rojo con volcado tecnico.
        return Err(
            "No se pudo cambiar el cortafuegos. Hay que aceptar el aviso de Windows \
             para permitir el acceso."
                .to_string(),
        );
    }

    Ok(status())
}

#[cfg(not(windows))]
pub fn allow() -> Result<FirewallStatus, String> {
    Err("El cortafuegos de Windows solo se configura en Windows.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rule_covering_the_connected_network_is_enough() {
        let status = parse_status("ALLOWED=Private\nACTIVE=Private\n");
        assert!(status.known);
        assert!(status.covered);
    }

    #[test]
    fn the_public_only_rule_does_not_cover_a_private_network() {
        // El fallo real: el aviso de Windows dejo una regla solo de `Public` y
        // en el wifi de casa (Private) el Remote no conecta, sin volver a
        // preguntar nunca.
        let status = parse_status("ALLOWED=Public\nACTIVE=Private\n");
        assert!(status.known);
        assert!(!status.covered);
        assert_eq!(status.active_profiles, ["Private"]);
        assert_eq!(status.allowed_profiles, ["Public"]);
    }

    #[test]
    fn any_covers_everything() {
        let status = parse_status("ALLOWED=Any\nACTIVE=Private,Public\n");
        assert!(status.covered);
    }

    #[test]
    fn every_connected_network_has_to_be_covered() {
        // Con dos redes a la vez (cable + wifi) no basta con acertar una.
        let status = parse_status("ALLOWED=Private\nACTIVE=Private,Public\n");
        assert!(!status.covered);
    }

    #[test]
    fn a_domain_network_is_not_reported_as_uncovered() {
        // Get-NetConnectionProfile dice `DomainAuthenticated` donde las reglas
        // dicen `Domain`; sin traducirlo, un portatil de empresa saldria
        // siempre descubierto.
        let status = parse_status("ALLOWED=Domain\nACTIVE=DomainAuthenticated\n");
        assert!(status.covered);
    }

    #[test]
    fn no_rule_at_all_is_not_covered() {
        let status = parse_status("ALLOWED=\nACTIVE=Private\n");
        assert!(status.known);
        assert!(!status.covered);
        assert!(status.allowed_profiles.is_empty());
    }

    #[test]
    fn no_connected_network_is_not_a_problem_to_report() {
        let status = parse_status("ALLOWED=\nACTIVE=\n");
        assert!(status.covered);
    }

    #[test]
    fn a_broken_query_is_unknown_and_still_offers_the_fix() {
        // Un error de PowerShell, un cmdlet ausente, una salida a medias: no
        // podemos afirmar que este cubierto.
        for output in ["", "Get-NetFirewallRule : no existe", "ALLOWED=Private"] {
            let status = parse_status(output);
            assert!(!status.known, "{output:?} no deberia dar un veredicto");
            assert!(!status.covered, "{output:?} deberia ofrecer el arreglo");
            assert!(status.supported);
        }
    }

    #[test]
    fn unrecognised_profiles_are_dropped_rather_than_trusted() {
        let status = parse_status("ALLOWED=NotConfigured\nACTIVE=Private\n");
        assert!(status.allowed_profiles.is_empty());
        assert!(!status.covered);
    }

    #[test]
    fn duplicate_profiles_are_listed_once() {
        let status = parse_status("ALLOWED=Private, Private ,Public\nACTIVE=Private\n");
        assert_eq!(status.allowed_profiles, ["Private", "Public"]);
    }

    #[test]
    fn the_scripts_carry_the_real_executable_path() {
        let script = build_status_script(r"C:\Users\ana\AppData\Local\LibreTracks\app.exe");
        assert!(script.contains(r"'C:\Users\ana\AppData\Local\LibreTracks\app.exe'"));

        let allow = build_allow_script(r"C:\Users\ana\app.exe");
        assert!(allow.contains("delete rule"), "hay que limpiar las viejas");
        assert!(allow.contains("profile=any"));
        assert!(allow.contains(RULE_NAME));
    }

    #[test]
    fn a_quote_in_the_path_cannot_break_out_of_the_script() {
        // Windows permite la comilla simple en un nombre de carpeta, y la ruta
        // se incrusta en el guion: sin duplicarla se cerraria la cadena y el
        // resto de la ruta se ejecutaria como codigo.
        let script = build_status_script(r"C:\Users\O'Brien\app.exe");
        assert!(script.contains(r"'C:\Users\O''Brien\app.exe'"));
    }

    #[test]
    fn the_command_is_encoded_as_utf16_base64() {
        // Lo que espera -EncodedCommand. Con UTF-8 PowerShell lee basura.
        assert_eq!(encode_powershell_command("hi"), "aABpAA==");
    }

    #[test]
    fn the_elevation_wrapper_waits_and_reports_the_inner_code() {
        let script = build_elevation_script("QUJD");
        assert!(script.contains("-Verb RunAs"), "sin esto no sale el UAC");
        assert!(script.contains("-Wait"));
        assert!(script.contains("exit $p.ExitCode"), "cancelar no es exito");
        assert!(script.contains("'QUJD'"));
    }

    #[test]
    fn outside_windows_there_is_nothing_to_offer() {
        let status = FirewallStatus::unsupported();
        assert!(!status.supported);
        assert!(status.covered, "no se avisa de un problema que no existe");
    }
}
