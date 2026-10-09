//! Partitura (PDF) de cada canción y sus puntos de sincronía por marca.
//!
//! Sibling `impl DesktopSession` block. Nada de esto toca el motor de audio: el
//! commit es `MixerOnly`, que sólo sustituye el modelo de Rust.
//!
//! El PDF se COPIA a `<sesión>/charts/` en vez de referenciarse como el audio.
//! Una partitura pesa cientos de KB, así que copiarla no cuesta espacio y evita
//! los permisos de `content://` (Android) y los bookmarks (iOS) que un fichero
//! referenciado necesitaría; además viaja sola en el `.ltset`.

use std::fs;
use std::path::{Path, PathBuf};

use libretracks_core::{looks_like_pdf, Song, SongChart, SongRegion};

use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;

use super::{AudioChangeImpact, DesktopSession};

/// Carpeta de la sesión donde se guardan las partituras.
pub(crate) const CHARTS_DIR: &str = "charts";

fn region_mut<'a>(song: &'a mut Song, region_id: &str) -> Result<&'a mut SongRegion, DesktopError> {
    song.regions
        .iter_mut()
        .find(|region| region.id == region_id)
        .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))
}

fn invalid(message: impl Into<String>) -> DesktopError {
    DesktopError::Io(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        message.into(),
    ))
}

/// Nombre de fichero seguro para `charts/`: sin separadores ni caracteres que
/// Windows/Android rechazan, y siempre con extensión `.pdf`.
pub(crate) fn chart_file_name(original: &str) -> String {
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
fn unique_chart_path(dir: &Path, file_name: &str) -> PathBuf {
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

pub(crate) fn resolve_chart_path(song_dir: &Path, file_path: &str) -> PathBuf {
    let path = Path::new(file_path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        song_dir.join(path)
    }
}

impl DesktopSession {
    fn require_song_dir(&self) -> Result<PathBuf, DesktopError> {
        self.song_dir.clone().ok_or(DesktopError::NoSongLoaded)
    }

    /// Copia un PDF a `charts/` y lo asigna a la canción. Sustituir la
    /// partitura borra los puntos: apuntaban a otro documento.
    pub fn set_song_region_chart_from_bytes(
        &mut self,
        region_id: &str,
        file_name: &str,
        bytes: &[u8],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        if bytes.len() > SongChart::MAX_BYTES {
            return Err(invalid(format!(
                "chart too large: {} bytes (max {})",
                bytes.len(),
                SongChart::MAX_BYTES
            )));
        }
        if !looks_like_pdf(bytes) {
            return Err(invalid("chart is not a PDF"));
        }
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        // Que la canción exista antes de escribir nada en disco.
        region_mut(&mut song, region_id)?;

        let song_dir = self.require_song_dir()?;
        let dir = song_dir.join(CHARTS_DIR);
        fs::create_dir_all(&dir)?;
        let target = unique_chart_path(&dir, &chart_file_name(file_name));
        libretracks_project::write_file_atomically(&target, bytes)?;
        let stored = format!(
            "{CHARTS_DIR}/{}",
            target
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
        );

        // El fichero anterior se queda en disco: deshacer puede devolverlo, y
        // una partitura huérfana pesa poco.
        region_mut(&mut song, region_id)?.chart = Some(SongChart {
            file_path: stored,
            anchors: Vec::new(),
        });
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;
        Ok(self.snapshot())
    }

    pub fn clear_song_region_chart(
        &mut self,
        region_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        region_mut(&mut song, region_id)?.chart = None;
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;
        Ok(self.snapshot())
    }

    /// Pone o mueve el punto donde empieza una sección. `marker_id` puede ser
    /// una repetición de un arreglo: se guarda en su marca original.
    pub fn set_song_chart_anchor(
        &mut self,
        region_id: &str,
        marker_id: &str,
        page: u32,
        y: f64,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let base_id = libretracks_core::chart_anchor_marker_id(marker_id);
        if !song.section_markers.iter().any(|marker| marker.id == base_id) {
            return Err(DesktopError::SectionNotFound(marker_id.to_string()));
        }
        let chart = region_mut(&mut song, region_id)?
            .chart
            .as_mut()
            .ok_or_else(|| invalid("song has no chart"))?;
        chart.set_anchor(marker_id, page, y);
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;
        Ok(self.snapshot())
    }

    pub fn remove_song_chart_anchor(
        &mut self,
        region_id: &str,
        marker_id: &str,
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        if let Some(chart) = region_mut(&mut song, region_id)?.chart.as_mut() {
            chart.remove_anchor(marker_id);
        }
        self.persist_song_update(song, audio, AudioChangeImpact::MixerOnly, true)?;
        Ok(self.snapshot())
    }

    /// Ruta del PDF de una canción, para leerlo FUERA del lock de sesión.
    pub fn song_region_chart_path(&self, region_id: &str) -> Result<PathBuf, DesktopError> {
        let song = self.engine.song().ok_or(DesktopError::NoSongLoaded)?;
        let region = song
            .regions
            .iter()
            .find(|region| region.id == region_id)
            .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
        let chart = region
            .chart
            .as_ref()
            .ok_or_else(|| invalid("song has no chart"))?;
        Ok(resolve_chart_path(&self.require_song_dir()?, &chart.file_path))
    }
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
        let dir = std::env::temp_dir().join(format!(
            "lt-charts-{}-{}",
            std::process::id(),
            super::super::timestamp_suffix()
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("Song.pdf"), b"%PDF-").unwrap();
        assert_eq!(unique_chart_path(&dir, "song.pdf"), dir.join("song (2).pdf"));
        fs::write(dir.join("song (2).pdf"), b"%PDF-").unwrap();
        assert_eq!(unique_chart_path(&dir, "song.pdf"), dir.join("song (3).pdf"));
        assert_eq!(unique_chart_path(&dir, "other.pdf"), dir.join("other.pdf"));
        let _ = fs::remove_dir_all(&dir);
    }
}
