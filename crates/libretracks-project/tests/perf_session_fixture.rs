//! Verifica que `scripts/generate-perf-session.mjs` produce una sesión que el
//! cargador real acepta.
//!
//! Sin este test, el generador podría escribir un JSON casi correcto (un campo
//! renombrado, un enum en snake_case) y el fallo sólo aparecería al intentar
//! abrir la sesión a mano — que es justo cuando uno se está preparando para
//! medir y no quiere depurar el arnés.
use std::process::Command;

use libretracks_project::load_song;

#[test]
fn el_generador_produce_una_sesion_que_carga() {
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .expect("repo root")
        .to_path_buf();
    let script = repo_root.join("scripts/generate-perf-session.mjs");
    assert!(script.exists(), "falta {}", script.display());

    let out_dir = std::env::temp_dir().join("lt-perf-session-fixture");
    let _ = std::fs::remove_dir_all(&out_dir);

    let status = Command::new("node")
        .arg(&script)
        .arg("--out")
        .arg(&out_dir)
        // Mínimo viable: dos canciones (para que haya orden de regiones), tres
        // pistas, fuentes de 2 s. Lo que se valida es la FORMA, no el tamaño.
        .args(["--songs", "2", "--tracks", "3", "--song-seconds", "2"])
        .args(["--markers", "3", "--sources", "2"])
        .current_dir(&repo_root)
        .status();

    let status = match status {
        Ok(status) => status,
        // El CI de Rust puro puede no tener node; no conviertas eso en un fallo
        // rojo que nadie sabe interpretar.
        Err(error) => {
            eprintln!("node no disponible ({error}); test omitido");
            return;
        }
    };
    assert!(status.success(), "el generador falló");

    let song = load_song(&out_dir).expect("la sesión generada debe cargar");

    assert_eq!(song.regions.len(), 2);
    assert_eq!(song.clips.len(), 6);
    assert_eq!(song.section_markers.len(), 6);
    // 3 pistas de audio + las 4 carpetas de agrupación.
    assert_eq!(song.tracks.len(), 7);
    // El escalonado por clip es lo que da a cada uno su propio namespace de
    // tile de waveform. Si dos clips comparten sourceStart, la sesión deja de
    // medir la presión de la caché (ver la cabecera del generador).
    let mut starts: Vec<String> = song
        .clips
        .iter()
        .map(|clip| format!("{:.6}", clip.source_start_seconds))
        .collect();
    starts.sort();
    starts.dedup();
    assert_eq!(
        starts.len(),
        song.clips.len(),
        "cada clip debe tener un sourceStartSeconds distinto"
    );

    let _ = std::fs::remove_dir_all(&out_dir);
}
