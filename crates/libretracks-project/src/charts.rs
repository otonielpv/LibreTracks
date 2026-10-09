//! Dónde y con qué nombre se guardan las partituras PDF de una sesión.
//!
//! Siempre bajo `<sesión>/charts/` con ruta relativa: así la sesión y sus
//! paquetes (`.ltset`, `.ltpkg`) las llevan consigo sin reescribir rutas.

use std::fs;
use std::path::{Path, PathBuf};

/// Carpeta de la sesión donde se guardan las partituras.
pub const CHARTS_DIR: &str = "charts";

/// Nombre de fichero seguro para `charts/`: sin separadores ni caracteres que
/// Windows/Android rechazan, y siempre con extensión `.pdf`.
pub fn chart_file_name(original: &str) -> String {
    let base = Path::new(original)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    let stem = if cleaned.is_empty() { "chart".to_string() } else { cleaned };
    format!("{stem}.pdf")
}

/// `name.pdf`, o `name (2).pdf`… si ya existe otro con ese nombre (sin
/// distinguir mayúsculas: Windows y macOS no lo hacen).
pub fn unique_chart_path(dir: &Path, file_name: &str) -> PathBuf {
    let taken = |candidate: &str| {
        fs::read_dir(dir)
            .map(|entries| {
                entries.flatten().any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .eq_ignore_ascii_case(candidate)
                })
            })
            .unwrap_or(false)
    };
    if !taken(file_name) {
        return dir.join(file_name);
    }
    let stem = file_name.trim_end_matches(".pdf");
    (2..)
        .map(|n| format!("{stem} ({n}).pdf"))
        .find(|candidate| !taken(candidate))
        .map(|candidate| dir.join(candidate))
        .expect("an unbounded range always yields a free name")
}

/// Escribe un PDF en `<song_dir>/charts/` con un nombre libre y devuelve la
/// ruta relativa que se guarda en la canción (`charts/<nombre>.pdf`).
pub fn store_chart_pdf(song_dir: &Path, file_name: &str, bytes: &[u8]) -> std::io::Result<String> {
    let dir = song_dir.join(CHARTS_DIR);
    fs::create_dir_all(&dir)?;
    let target = unique_chart_path(&dir, &chart_file_name(file_name));
    crate::write_file_atomically(&target, bytes)?;
    Ok(format!(
        "{CHARTS_DIR}/{}",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chart_file_names_are_safe_and_always_pdf() {
        assert_eq!(chart_file_name("Cuan grande es Él.pdf"), "Cuan grande es Él.pdf");
        assert_eq!(chart_file_name("dir/y:z?.PDF"), "y_z_.pdf");
        assert_eq!(chart_file_name("a/b/acordes"), "acordes.pdf");
        assert_eq!(chart_file_name("..."), "chart.pdf");
        assert_eq!(chart_file_name(""), "chart.pdf");
    }

    #[test]
    fn colliding_chart_names_get_a_counter_ignoring_case() {
        let dir = tempfile::tempdir().expect("dir");
        let dir = dir.path();
        fs::write(dir.join("Song.pdf"), b"%PDF-").unwrap();
        assert_eq!(unique_chart_path(dir, "song.pdf"), dir.join("song (2).pdf"));
        fs::write(dir.join("song (2).pdf"), b"%PDF-").unwrap();
        assert_eq!(unique_chart_path(dir, "song.pdf"), dir.join("song (3).pdf"));
        assert_eq!(unique_chart_path(dir, "other.pdf"), dir.join("other.pdf"));
    }

    #[test]
    fn storing_a_chart_returns_its_relative_path() {
        let dir = tempfile::tempdir().expect("dir");
        assert_eq!(store_chart_pdf(dir.path(), "a.pdf", b"%PDF-").unwrap(), "charts/a.pdf");
        assert_eq!(store_chart_pdf(dir.path(), "a.pdf", b"%PDF-").unwrap(), "charts/a (2).pdf");
        assert_eq!(fs::read(dir.path().join("charts/a (2).pdf")).unwrap(), b"%PDF-");
    }
}
