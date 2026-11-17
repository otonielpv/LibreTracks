//! Importar una muestra propia (plan drum-loops, paso 05, D11): se transcodifica
//! a WAV 16 bit en `loops/user/` y se limita su duración (10 s para un sonido
//! de loop, 30 s para un one shot). Las rutas con tildes o eñes funcionan: todo
//! va por `Path`, nunca por cadenas ANSI.

use std::path::{Path, PathBuf};

use libretracks_core::drum_loops::{SampleRef, SampleSource};
use serde::{Deserialize, Serialize};

pub const LOOP_SAMPLE_MAX_SECONDS: f64 = 10.0;
pub const ONE_SHOT_SAMPLE_MAX_SECONDS: f64 = 30.0;
const IMPORT_HEADROOM_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UserSampleKind {
    Loop,
    OneShot,
}

impl UserSampleKind {
    pub fn max_seconds(self) -> f64 {
        match self {
            Self::Loop => LOOP_SAMPLE_MAX_SECONDS,
            Self::OneShot => ONE_SHOT_SAMPLE_MAX_SECONDS,
        }
    }
}

/// Nombre de fichero seguro y legible a partir del original (conserva letras
/// con tilde; cambia lo demás por guiones).
fn safe_stem(source: &Path) -> String {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cleaned: String = stem
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "sample".into()
    } else {
        trimmed.chars().take(60).collect()
    }
}

fn unique_destination(user_dir: &Path, stem: &str) -> PathBuf {
    let first = user_dir.join(format!("{stem}.wav"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| user_dir.join(format!("{stem}-{n}.wav")))
        .find(|p| !p.exists())
        .expect("an unused name always exists")
}

/// Transcodifica `source` y devuelve su `SampleRef::User`. Una muestra más
/// larga que el límite de `kind` no se queda en la carpeta.
pub fn import_user_sample(source: &Path, user_dir: &Path, kind: UserSampleKind) -> Result<SampleRef, String> {
    std::fs::create_dir_all(user_dir).map_err(|e| e.to_string())?;
    let source_len = std::fs::metadata(source).map_err(|e| e.to_string())?.len();
    // Un comprimido crece al pasar a PCM: margen generoso.
    libretracks_project::ensure_free_space(user_dir, source_len.saturating_mul(4), IMPORT_HEADROOM_BYTES)
        .map_err(|e| e.to_string())?;
    let destination = unique_destination(user_dir, &safe_stem(source));
    if let Err(error) = crate::commands::pads::decode_to_wav16(source, &destination) {
        let _ = std::fs::remove_file(&destination);
        return Err(error);
    }
    let seconds = match hound::WavReader::open(&destination) {
        Ok(reader) => {
            let spec = reader.spec();
            f64::from(reader.duration()) / f64::from(spec.sample_rate.max(1))
        }
        Err(error) => {
            let _ = std::fs::remove_file(&destination);
            return Err(error.to_string());
        }
    };
    if seconds > kind.max_seconds() {
        let _ = std::fs::remove_file(&destination);
        return Err(format!(
            "sample too long: {seconds:.1} s, limit {:.0} s",
            kind.max_seconds()
        ));
    }
    let file = destination
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or("invalid destination name")?;
    Ok(SampleRef {
        source: SampleSource::User,
        file,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_tone(path: &Path, seconds: f64) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 8000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        for i in 0..(seconds * 8000.0) as u32 {
            let v = ((i as f64 * 0.05).sin() * 8000.0) as i16;
            writer.write_sample(v).unwrap();
        }
        writer.finalize().unwrap();
    }

    #[test]
    fn a_forty_second_loop_sound_is_rejected_and_a_two_second_one_is_imported() {
        let dir = tempfile::tempdir().unwrap();
        let source_dir = dir.path().join("Música de José");
        std::fs::create_dir_all(&source_dir).unwrap();
        let user = dir.path().join("loops").join("user");

        let long = source_dir.join("riser largo.wav");
        write_tone(&long, 40.0);
        let err = import_user_sample(&long, &user, UserSampleKind::Loop).unwrap_err();
        assert!(err.starts_with("sample too long"), "{err}");
        assert_eq!(std::fs::read_dir(&user).unwrap().count(), 0, "no se queda nada");
        // Como one shot (30 s) tampoco cabe.
        assert!(import_user_sample(&long, &user, UserSampleKind::OneShot).is_err());

        let short = source_dir.join("pandereta ñ.wav");
        write_tone(&short, 2.0);
        let sample = import_user_sample(&short, &user, UserSampleKind::Loop).unwrap();
        assert_eq!(sample.source, SampleSource::User);
        assert_eq!(sample.file, "pandereta-ñ.wav");
        let reader = hound::WavReader::open(user.join(&sample.file)).unwrap();
        assert_eq!(reader.spec().bits_per_sample, 16);
        assert_eq!(reader.spec().sample_format, hound::SampleFormat::Int);

        // Otra vez el mismo nombre: no pisa el anterior.
        let again = import_user_sample(&short, &user, UserSampleKind::OneShot).unwrap();
        assert_eq!(again.file, "pandereta-ñ-2.wav");
    }
}
