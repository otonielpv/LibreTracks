//! Cambio de tono preparado, para equipos de gama baja.
//!
//! Con warp, cada pista transpuesta es una voz Bungee en el hilo de audio:
//! ~1 % del presupuesto por pista en un PC y ~5 % en una tablet de gama baja
//! (Tab A7), así que 20 pistas lo saturan y se oyen cortes. Con este modo, el
//! tono y el ratio de warp de cada clip se renderizan una vez en segundo plano
//! a un WAV (con el mismo render offline que «Renderizar audio») y el motor lo
//! reproduce como una copia directa: el coste en el hilo de audio pasa a ser
//! el de una pista sin transponer.
//!
//! Cómo encaja:
//! - [`plan`] mira la sesión tal como la recibe el motor (rutas resueltas y
//!   línea de tiempo con warp aplicada) y devuelve, por clip, qué audio
//!   preparado le hace falta.
//! - [`apply`] cambia en esa sesión los clips cuyo audio ya está en disco: la
//!   fuente pasa a ser el WAV preparado, `source_start` pasa a 0 y el motor los
//!   recibe con `prerendered = true` (va por Direct, sin voz Bungee).
//! - Lo que aún no esté preparado sigue sonando con Bungee en directo, como
//!   siempre. [`PrerenderWorker`] lo prepara en hilos de baja prioridad.
//!
//! El WAV preparado cubre exactamente el tramo del clip: su muestra `i` es lo
//! que Bungee daría en el desplazamiento `i` de la línea de tiempo desde el
//! inicio del clip. Por eso su clave lleva el inicio en la fuente y la
//! duración, además de los semitonos y los dos BPM que dan el ratio.

use std::collections::{HashSet, VecDeque};
use std::hash::Hasher;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use libretracks_core::warp::effective_bpm_at;
use libretracks_core::{ChannelMode, Song};

/// Ajuste «Cambio de tono preparado». Lo fija `apply_settings`; los
/// constructores de la sesión del motor lo leen sin coger ningún lock.
static ENABLED: AtomicBool = AtomicBool::new(false);

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Versión del formato del audio preparado. Súbela si cambia cómo se
/// renderiza (otro Bungee, otra calidad) para no reutilizar ficheros viejos.
const FORMAT_VERSION: u32 = 1;

/// Margen de tolerancia, en segundos, para decidir que un clip cabe dentro de
/// su región. Los extremos salen de conversiones en coma flotante.
const REGION_EDGE_EPSILON: f64 = 1e-4;

/// `<raíz de la caché>/pitch-cache`, junto a `source-cache` y
/// `waveform-cache`, para que el tamaño y la purga de la caché lo incluyan.
pub fn cache_dir() -> Option<PathBuf> {
    let engine_dir = lt_audio_engine_v2::decoding_cache_dir();
    if engine_dir.is_empty() {
        return None;
    }
    Some(Path::new(&engine_dir).parent()?.join("pitch-cache"))
}

/// Lo que hay que renderizar para un clip.
#[derive(Debug, Clone, PartialEq)]
pub struct BakeSpec {
    /// Ruta resuelta del audio original.
    pub source_path: String,
    pub source_start_seconds: f64,
    /// Duración del clip en la línea de tiempo del motor.
    pub duration_seconds: f64,
    pub semitones: i32,
    /// BPM de la línea de tiempo al inicio de la región y BPM original del
    /// audio. El motor saca el ratio de warp dividiéndolos, y el render del
    /// audio preparado recibe los mismos dos números, así que el ratio es el
    /// mismo bit a bit.
    pub target_bpm: f64,
    pub source_bpm: f64,
    pub sample_rate: u32,
}

impl BakeSpec {
    #[cfg(test)]
    pub fn ratio(&self) -> f64 {
        self.target_bpm / self.source_bpm
    }

    /// Nombre del fichero en la caché. Lleva tamaño y fecha del original para
    /// no servir audio viejo si el fichero cambia en disco. `None` si el
    /// original no se puede leer.
    pub fn file_name(&self) -> Option<String> {
        let meta = std::fs::metadata(&self.source_path).ok()?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let canonical = format!(
            "v{FORMAT_VERSION}|{}|{}|{}|{:x}|{:x}|{}|{:x}|{:x}|{}",
            self.source_path,
            meta.len(),
            mtime,
            self.source_start_seconds.to_bits(),
            self.duration_seconds.to_bits(),
            self.semitones,
            self.target_bpm.to_bits(),
            self.source_bpm.to_bits(),
            self.sample_rate,
        );
        Some(format!("{:016x}.wav", fnv1a64(canonical.as_bytes())))
    }
}

/// FNV-1a de 64 bits: estable entre versiones de Rust (el `DefaultHasher` de
/// la biblioteca estándar no lo garantiza, y un cambio de hash dejaría
/// huérfana toda la caché).
fn fnv1a64(bytes: &[u8]) -> u64 {
    struct Fnv(u64);
    impl Hasher for Fnv {
        fn finish(&self) -> u64 {
            self.0
        }
        fn write(&mut self, bytes: &[u8]) {
            for byte in bytes {
                self.0 ^= u64::from(*byte);
                self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
    }
    let mut hasher = Fnv(0xcbf2_9ce4_8422_2325);
    hasher.write(bytes);
    hasher.finish()
}

/// El audio preparado que necesita un clip, y dónde va.
#[derive(Debug, Clone, PartialEq)]
pub struct ClipBake {
    pub clip_id: String,
    /// Región cuyo tono/warp lleva. Las de una región se aplican todas a la
    /// vez (ver [`substitute`]).
    pub region_id: String,
    pub spec: BakeSpec,
    pub path: PathBuf,
}

impl ClipBake {
    pub fn is_ready(&self) -> bool {
        self.path.is_file()
    }
}

/// Qué clips de `runtime_song` sonarían con Bungee y qué audio preparado los
/// sustituiría.
///
/// - `source_song`: la canción con las rutas ya resueltas, antes de aplicar
///   el warp a la línea de tiempo (de ahí sale el BPM de cada región).
/// - `runtime_song`: la misma después de `song_with_warped_timeline`, que es
///   lo que recibe el motor. Sus regiones van en el mismo orden.
///
/// Solo entran clips que caben enteros en una región con warp que no sea la
/// identidad (ratio 1 y 0 semitonos: esa ya va por Direct en el motor). Un
/// clip que cruza el borde de la región sigue en directo, porque fuera de la
/// región su audio no lleva tono.
pub fn plan(
    source_song: &Song,
    runtime_song: &Song,
    sample_rate: u32,
    dir: &Path,
) -> Vec<ClipBake> {
    let mut bakes = Vec::new();
    if sample_rate == 0 {
        return bakes;
    }
    for clip in &runtime_song.clips {
        let Some(track) = runtime_song.tracks.iter().find(|t| t.id == clip.track_id) else {
            continue;
        };
        let clip_start = clip.timeline_start_seconds;
        let clip_end = clip_start + clip.duration_seconds;
        if clip.duration_seconds <= 0.0 || clip.file_path.trim().is_empty() {
            continue;
        }
        let region = runtime_song
            .regions
            .iter()
            .zip(source_song.regions.iter())
            .find(|(runtime_region, _)| {
                clip_start >= runtime_region.start_seconds - REGION_EDGE_EPSILON
                    && clip_end <= runtime_region.end_seconds + REGION_EDGE_EPSILON
            });
        let Some((runtime_region, source_region)) = region else {
            continue;
        };
        let Some(source_bpm) = source_region.warp_source_bpm else {
            continue;
        };
        if !source_region.warp_enabled || !(source_bpm > 0.0) || !source_bpm.is_finite() {
            continue;
        }
        let target_bpm = effective_bpm_at(source_song, source_region.start_seconds);
        if !(target_bpm > 0.0) || !target_bpm.is_finite() {
            continue;
        }
        // Misma regla que resolve_effective_semitones en el motor: una pista
        // «no transponer» ignora los semitonos cuando la región tiene warp.
        let semitones = if track.transpose_enabled {
            source_region.transpose_semitones.clamp(-12, 12)
        } else {
            0
        };
        // Identidad exacta, como is_neutral_warp: el motor ya no usa Bungee.
        if semitones == 0 && target_bpm / source_bpm == 1.0 {
            continue;
        }
        let spec = BakeSpec {
            source_path: clip.file_path.clone(),
            source_start_seconds: clip.source_start_seconds,
            duration_seconds: clip.duration_seconds,
            semitones,
            target_bpm,
            source_bpm,
            sample_rate,
        };
        let Some(name) = spec.file_name() else {
            continue;
        };
        bakes.push(ClipBake {
            clip_id: clip.id.clone(),
            region_id: runtime_region.id.clone(),
            spec,
            path: dir.join(name),
        });
    }
    bakes
}

/// Sustituye en `runtime_song` los clips cuyo audio preparado ya existe,
/// pero solo en las regiones donde están TODOS: si no, unas pistas sonarían
/// en el tono nuevo y otras en el anterior. Devuelve sus ids: el motor tiene
/// que recibirlos con `prerendered = true`.
pub fn apply(runtime_song: &mut Song, bakes: &[ClipBake]) -> HashSet<String> {
    let incomplete: HashSet<&str> = bakes
        .iter()
        .filter(|b| !b.is_ready())
        .map(|b| b.region_id.as_str())
        .collect();
    let mut applied = HashSet::new();
    for bake in bakes {
        if incomplete.contains(bake.region_id.as_str()) || !bake.is_ready() {
            continue;
        }
        if let Some(clip) = runtime_song.clips.iter_mut().find(|c| c.id == bake.clip_id) {
            clip.file_path = bake.path.to_string_lossy().replace('\\', "/");
            clip.source_start_seconds = 0.0;
            applied.insert(clip.id.clone());
            // La fecha marca el último uso: el recorte de la caché borra
            // primero lo que lleva más tiempo sin sonar.
            let _ = std::fs::File::options()
                .write(true)
                .open(&bake.path)
                .and_then(|file| file.set_modified(std::time::SystemTime::now()));
        }
    }
    applied
}

/// Lo último que recibió el motor para un clip que sonaba sin Bungee: su
/// audio preparado o el original tal cual. Mientras se prepara el audio de un
/// tono o tempo nuevo, el clip sigue sonando así (el tono anterior) en lugar
/// de pasar a Bungee en directo, que es justo el pico de CPU que este modo
/// quiere evitar.
#[derive(Debug, Clone, PartialEq)]
pub struct SentClip {
    /// Ruta original y punto de inicio en ella: si cambian (otro audio, clip
    /// recortado por delante), lo enviado ya no vale como reserva.
    pub original_path: String,
    pub original_source_start_seconds: f64,
    /// Lo que se envió al motor.
    pub engine_path: String,
    pub engine_source_start_seconds: f64,
}

/// Lo que se ha enviado al motor por clip. Vive en el estado del controlador.
pub type SentClips = std::collections::HashMap<String, SentClip>;

/// True si el clip suena sin tono ni warp (camino Direct del motor): no toca
/// ninguna región transpuesta ni con un warp que cambie el tempo.
fn clip_plays_plain(
    source_song: &Song,
    runtime_song: &Song,
    clip: &libretracks_core::Clip,
) -> bool {
    let clip_start = clip.timeline_start_seconds;
    let clip_end = clip_start + clip.duration_seconds;
    !runtime_song
        .regions
        .iter()
        .zip(source_song.regions.iter())
        .any(|(runtime_region, source_region)| {
            let overlaps =
                clip_start < runtime_region.end_seconds && clip_end > runtime_region.start_seconds;
            if !overlaps {
                return false;
            }
            if source_region.transpose_semitones != 0 {
                return true;
            }
            source_region.warp_enabled
                && source_region.warp_source_bpm.is_some_and(|source_bpm| {
                    source_bpm > 0.0
                        && effective_bpm_at(source_song, source_region.start_seconds) / source_bpm
                            != 1.0
                })
        })
}

/// Plan + apply + reserva, para los constructores de la sesión del motor.
///
/// Cada clip de `runtime_song` acaba en uno de estos casos:
/// - su audio preparado está en disco → se sustituye;
/// - le falta, pero el motor lo tenía sonando sin Bungee con el mismo
///   original → se le reenvía lo mismo (el tono anterior) hasta que esté;
/// - le falta y no hay reserva (canción recién abierta con la caché vacía) →
///   sigue en directo con Bungee, como sin este modo.
///
/// Devuelve los ids que el motor tiene que recibir con `prerendered = true` y
/// los audios preparados que faltan. Con el ajuste apagado no toca nada y
/// olvida las reservas.
pub fn substitute(
    source_song: &Song,
    runtime_song: &mut Song,
    sample_rate: u32,
    sent: &mut SentClips,
) -> (HashSet<String>, Vec<ClipBake>) {
    if !is_enabled() {
        sent.clear();
        return (HashSet::new(), Vec::new());
    }
    let Some(dir) = cache_dir() else {
        sent.clear();
        return (HashSet::new(), Vec::new());
    };
    substitute_in(&dir, source_song, runtime_song, sample_rate, sent)
}

/// [`substitute`] con la carpeta de la caché dada (y sin mirar el ajuste).
fn substitute_in(
    dir: &Path,
    source_song: &Song,
    runtime_song: &mut Song,
    sample_rate: u32,
    sent: &mut SentClips,
) -> (HashSet<String>, Vec<ClipBake>) {
    let bakes = plan(source_song, runtime_song, sample_rate, dir);
    let originals: std::collections::HashMap<String, (String, f64)> = runtime_song
        .clips
        .iter()
        .map(|c| (c.id.clone(), (c.file_path.clone(), c.source_start_seconds)))
        .collect();
    let plain: HashSet<String> = runtime_song
        .clips
        .iter()
        .filter(|c| clip_plays_plain(source_song, runtime_song, c))
        .map(|c| c.id.clone())
        .collect();

    let mut applied = apply(runtime_song, &bakes);
    let mut missing = Vec::new();
    let mut next_sent = SentClips::new();

    for bake in bakes {
        let (original_path, original_start) = originals[&bake.clip_id].clone();
        if applied.contains(&bake.clip_id) {
            next_sent.insert(
                bake.clip_id.clone(),
                SentClip {
                    original_path,
                    original_source_start_seconds: original_start,
                    engine_path: bake.path.to_string_lossy().replace('\\', "/"),
                    engine_source_start_seconds: 0.0,
                },
            );
            continue;
        }
        let reserve = sent.get(&bake.clip_id).filter(|previous| {
            previous.original_path == original_path
                && previous.original_source_start_seconds == original_start
        });
        if let Some(previous) = reserve {
            if let Some(clip) = runtime_song.clips.iter_mut().find(|c| c.id == bake.clip_id) {
                clip.file_path = previous.engine_path.clone();
                clip.source_start_seconds = previous.engine_source_start_seconds;
                applied.insert(bake.clip_id.clone());
            }
            next_sent.insert(bake.clip_id.clone(), previous.clone());
        }
        missing.push(bake);
    }

    for clip_id in plain {
        let (path, start) = originals[&clip_id].clone();
        next_sent.insert(
            clip_id,
            SentClip {
                original_path: path.clone(),
                original_source_start_seconds: start,
                engine_path: path,
                engine_source_start_seconds: start,
            },
        );
    }

    *sent = next_sent;
    (applied, missing)
}

/// Marca `prerendered` en los clips del JSON de `LoadSession` (el modelo del
/// core no tiene ese campo: es solo del motor).
pub fn mark_prerendered_in_session_json(json: &mut serde_json::Value, ids: &HashSet<String>) {
    if ids.is_empty() {
        return;
    }
    let Some(clips) = json.get_mut("clips").and_then(|c| c.as_array_mut()) else {
        return;
    };
    for clip in clips {
        let is_prerendered = clip
            .get("id")
            .and_then(|id| id.as_str())
            .is_some_and(|id| ids.contains(id));
        if is_prerendered {
            if let Some(obj) = clip.as_object_mut() {
                obj.insert("prerendered".into(), serde_json::Value::Bool(true));
            }
        }
    }
}

/// La canción mínima que, renderizada offline, da el audio preparado de un
/// clip: una pista neutra, un clip desde el 0 de la línea de tiempo y una
/// región con el tono y los dos BPM del original. Parte de `template` solo
/// para heredar los campos que no importan.
fn bake_song(template: &Song, spec: &BakeSpec) -> Option<Song> {
    let mut track = template.tracks.first()?.clone();
    track.id = "bake-track".into();
    track.parent_track_id = None;
    track.volume = 1.0;
    track.pan = 0.0;
    track.muted = false;
    track.solo = false;
    track.transpose_enabled = true;
    // El modo de canal se aplica también sin apply_mixer, y en directo se
    // vuelve a aplicar sobre el audio preparado: aquí tiene que ser neutro.
    track.channel_mode = ChannelMode::Stereo;
    track.kind = libretracks_core::TrackKind::Audio;

    let mut clip = template.clips.first()?.clone();
    clip.id = "bake-clip".into();
    clip.track_id = track.id.clone();
    clip.file_path = spec.source_path.clone();
    clip.timeline_start_seconds = 0.0;
    clip.source_start_seconds = spec.source_start_seconds;
    clip.duration_seconds = spec.duration_seconds;
    clip.gain = 1.0;
    clip.fade_in_seconds = None;
    clip.fade_out_seconds = None;
    clip.fade_in_curve = None;
    clip.fade_out_curve = None;

    let mut region = template.regions.first()?.clone();
    region.id = "bake-region".into();
    region.start_seconds = 0.0;
    region.end_seconds = spec.duration_seconds;
    region.transpose_semitones = spec.semitones;
    region.warp_enabled = true;
    region.warp_source_bpm = Some(spec.source_bpm);
    region.master = Default::default();

    let mut song = template.clone();
    song.id = "bake-song".into();
    song.bpm = spec.target_bpm;
    song.duration_seconds = spec.duration_seconds;
    song.tempo_markers.clear();
    song.time_signature_markers.clear();
    song.section_markers.clear();
    song.midi_clips.clear();
    song.video_clips.clear();
    song.tracks = vec![track];
    song.clips = vec![clip];
    song.regions = vec![region];
    Some(song)
}

/// La petición al render offline que da el audio preparado de `bake`,
/// escrito en `output`: int16 estéreo a la SR del motor, sin mezcla.
fn bake_request(
    template: &Song,
    bake: &ClipBake,
    output: &Path,
) -> Result<lt_audio_engine_v2::RenderRequest, String> {
    let song = bake_song(template, &bake.spec).ok_or("song without track, clip or region")?;
    let project_json = serde_json::to_string(&song).map_err(|e| e.to_string())?;
    Ok(lt_audio_engine_v2::RenderRequest {
        project_json,
        sample_rate: bake.spec.sample_rate,
        start_seconds: 0.0,
        end_seconds: bake.spec.duration_seconds,
        outputs: vec![lt_audio_engine_v2::RenderOutput {
            path: output.to_string_lossy().into_owned(),
            track_ids: vec!["bake-track".into()],
            include_metronome: false,
            include_voice_guide: false,
            include_pad: false,
        }],
        format: lt_audio_engine_v2::RenderSampleFormat::Pcm16,
        channels: 2,
        normalize: false,
        normalize_peak_db: 0.0,
        apply_mixer: false,
        dither: false,
        measure_loudness: false,
        pans: None,
        metronome: None,
        voice_guide: None,
        automation: None,
    })
}

/// Renderiza un audio preparado. Escribe a un `.part` y lo renombra al final:
/// un fichero con el nombre definitivo está siempre completo, y [`plan`] puede
/// fiarse de que exista.
pub fn render_bake(
    template: &Song,
    bake: &ClipBake,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    let dir = bake.path.parent().ok_or("bake path without folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    // int16 estéreo: 4 bytes por frame.
    let needed = (bake.spec.duration_seconds * f64::from(bake.spec.sample_rate) * 4.0) as u64;
    libretracks_project::ensure_free_space(dir, needed, 512 * 1024 * 1024)
        .map_err(|e| e.to_string())?;

    let part = bake.path.with_extension("wav.part");
    let request = bake_request(template, bake, &part)?;
    let mut on_progress = |_fraction: f64| !cancelled();
    let result = lt_audio_engine_v2::render_offline(&request, &mut on_progress);
    match result {
        Ok(_) => std::fs::rename(&part, &bake.path).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            e.to_string()
        }),
        Err(error) => {
            let _ = std::fs::remove_file(&part);
            Err(match error {
                lt_audio_engine_v2::RenderError::Cancelled => "cancelled".into(),
                lt_audio_engine_v2::RenderError::Failed(e) => e.to_string(),
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Cola de trabajo
// ---------------------------------------------------------------------------

/// Progreso que ve el indicador «Preparando audio transpuesto…».
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PrerenderProgress {
    pub active: bool,
    pub done: u64,
    pub total: u64,
    pub failed: u64,
}

impl PrerenderProgress {
    pub fn percent(&self) -> f64 {
        if self.total == 0 {
            return 0.0;
        }
        (self.done as f64 / self.total as f64 * 100.0).clamp(0.0, 100.0)
    }
}

/// Tope de la carpeta `pitch-cache`. Una canción de 5 min con 20 pistas
/// ocupa ~1,1 GB por tono; con 8 GB caben varias canciones transpuestas de
/// una setlist sin llenar el disco de un móvil.
const CACHE_CAP_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Borra los `.wav` más antiguos (por fecha de modificación) de `dir` hasta
/// bajar de `cap`, sin tocar `keep`. Lo que no se pueda borrar (abierto por el
/// motor en Windows) se salta.
fn evict_oldest(dir: &Path, keep: &HashSet<PathBuf>, cap: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let meta = entry.metadata().ok()?;
            meta.is_file().then(|| {
                let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                (path, meta.len(), modified)
            })
        })
        .collect();
    let mut total: u64 = files.iter().map(|(_, len, _)| len).sum();
    if total <= cap {
        return;
    }
    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, len, _) in files {
        if total <= cap {
            break;
        }
        if keep.contains(&path) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

struct Job {
    template: Arc<Song>,
    bake: ClipBake,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
struct QueueState {
    pending: VecDeque<Job>,
    /// Cancelación de cada render en curso, por ruta.
    running: std::collections::HashMap<PathBuf, Arc<AtomicBool>>,
    /// Rutas cuyo render falló: no se reintentan en esta sesión de la app
    /// (disco lleno, fichero ilegible). Sin esto, cada refresco volvería a
    /// encolarlas y a fallar.
    failed: HashSet<PathBuf>,
    progress: PrerenderProgress,
    workers: usize,
    /// Todo el audio preparado que usa la sesión actual (listo o no): el
    /// recorte de la caché nunca lo borra.
    keep: HashSet<PathBuf>,
}

impl QueueState {
    fn is_queued(&self, path: &Path) -> bool {
        self.running.contains_key(path) || self.pending.iter().any(|j| j.bake.path == path)
    }
}

/// Prepara audio en hilos de baja prioridad. Uno por proceso ([`worker`]).
pub struct PrerenderWorker {
    state: Mutex<QueueState>,
    wake: Condvar,
}

static WORKER: std::sync::OnceLock<Arc<PrerenderWorker>> = std::sync::OnceLock::new();
type RefreshHook = Box<dyn Fn() + Send + Sync>;
static REFRESH_HOOK: std::sync::OnceLock<RefreshHook> = std::sync::OnceLock::new();

pub fn worker() -> &'static Arc<PrerenderWorker> {
    WORKER.get_or_init(|| {
        Arc::new(PrerenderWorker {
            state: Mutex::new(QueueState::default()),
            wake: Condvar::new(),
        })
    })
}

/// Lo que se llama cada vez que la cola se vacía: reenviar al motor la sesión
/// con el audio recién preparado. Lo instala el arranque de la app.
pub fn set_refresh_hook(hook: RefreshHook) {
    let _ = REFRESH_HOOK.set(hook);
}

impl PrerenderWorker {
    pub fn progress(&self) -> PrerenderProgress {
        self.state.lock().map(|s| s.progress).unwrap_or_default()
    }

    /// Descarta la cola y cancela lo que se esté renderizando (ajuste apagado).
    pub fn cancel_all(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.pending.clear();
        for cancel in state.running.values() {
            cancel.store(true, Ordering::Relaxed);
        }
        state.progress = PrerenderProgress::default();
    }

    /// Deja en la cola exactamente `needed`: encola lo que falte y descarta
    /// (o cancela, si ya se está renderizando) lo que ya no haga falta, p. ej.
    /// el tono anterior cuando se vuelve a cambiar antes de terminar.
    pub fn sync(&self, template: &Song, needed: Vec<ClipBake>) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.keep.extend(needed.iter().map(|b| b.path.clone()));
        let needed: Vec<ClipBake> = needed
            .into_iter()
            .filter(|b| !b.is_ready() && !state.failed.contains(&b.path))
            .collect();
        let wanted: HashSet<PathBuf> = needed.iter().map(|b| b.path.clone()).collect();

        let before = state.pending.len();
        state.pending.retain(|job| wanted.contains(&job.bake.path));
        let dropped = (before - state.pending.len()) as u64;
        for (path, cancel) in &state.running {
            if !wanted.contains(path) {
                cancel.store(true, Ordering::Relaxed);
            }
        }
        state.progress.total = state.progress.total.saturating_sub(dropped);

        let template = Arc::new(template.clone());
        let mut seen = HashSet::new();
        for bake in needed {
            if !seen.insert(bake.path.clone()) || state.is_queued(&bake.path) {
                continue;
            }
            state.pending.push_back(Job {
                template: Arc::clone(&template),
                bake,
                cancel: Arc::new(AtomicBool::new(false)),
            });
            state.progress.total += 1;
        }
        if state.pending.is_empty() && state.running.is_empty() {
            state.progress = PrerenderProgress::default();
            state.keep.clear();
            return;
        }
        state.progress.active = true;
        self.ensure_workers(&mut state);
        self.wake.notify_all();
    }

    fn ensure_workers(&self, state: &mut QueueState) {
        // La mitad de los núcleos como mucho: en Android y Linux no se puede
        // bajar la prioridad del hilo (ver platform::thread_priority), y en un
        // móvil de gama baja el audio y la interfaz necesitan el resto.
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(2);
        let wanted = (cores / 2).clamp(1, 4);
        while state.workers < wanted {
            state.workers += 1;
            let spawned = std::thread::Builder::new()
                .name("lt-pitch-prerender".into())
                .spawn(|| worker_loop(worker()));
            if spawned.is_err() {
                state.workers -= 1;
                break;
            }
        }
    }
}

fn worker_loop(worker: &PrerenderWorker) {
    crate::platform::thread_priority::lower_current_thread_priority();
    loop {
        let job = {
            let Ok(mut state) = worker.state.lock() else {
                return;
            };
            loop {
                if let Some(job) = state.pending.pop_front() {
                    state
                        .running
                        .insert(job.bake.path.clone(), Arc::clone(&job.cancel));
                    break job;
                }
                state = match worker.wake.wait(state) {
                    Ok(state) => state,
                    Err(_) => return,
                };
            }
        };

        let cancel = Arc::clone(&job.cancel);
        let result = render_bake(&job.template, &job.bake, &|| cancel.load(Ordering::Relaxed));
        let cancelled = job.cancel.load(Ordering::Relaxed);
        if let Err(error) = &result {
            if !cancelled {
                eprintln!(
                    "[pitch-prerender] {} failed: {error}",
                    job.bake.spec.source_path
                );
            }
        }

        let drained = {
            let Ok(mut state) = worker.state.lock() else {
                return;
            };
            state.running.remove(&job.bake.path);
            if cancelled {
                state.progress.total = state.progress.total.saturating_sub(1);
            } else {
                state.progress.done += 1;
                if result.is_err() {
                    state.progress.failed += 1;
                    state.failed.insert(job.bake.path.clone());
                }
            }
            let drained = state.pending.is_empty() && state.running.is_empty();
            if drained {
                state.progress = PrerenderProgress::default();
            }
            drained.then(|| std::mem::take(&mut state.keep))
        };
        if let Some(keep) = drained {
            if let Some(dir) = job.bake.path.parent() {
                evict_oldest(dir, &keep, CACHE_CAP_BYTES);
            }
            if let Some(hook) = REFRESH_HOOK.get() {
                hook();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song_json(warp: bool, transpose: i32, source_bpm: f64, track_transpose: bool) -> Song {
        serde_json::from_value(serde_json::json!({
            "id": "s", "title": "S", "artist": null, "key": null,
            "bpm": 120.0, "timeSignature": "4/4", "durationSeconds": 20.0,
            "tempoMarkers": [], "timeSignatureMarkers": [],
            "regions": [{
                "id": "r", "name": "R", "startSeconds": 0.0, "endSeconds": 20.0,
                "transposeSemitones": transpose, "warpEnabled": warp,
                "warpSourceBpm": source_bpm
            }],
            "tracks": [{
                "id": "t", "name": "T", "kind": "audio", "parentTrackId": null,
                "volume": 0.5, "pan": 0.3, "muted": false, "solo": false,
                "transposeEnabled": track_transpose, "audioTo": "master"
            }],
            "clips": [{
                "id": "c", "trackId": "t", "filePath": "",
                "timelineStartSeconds": 2.0, "sourceStartSeconds": 1.0,
                "durationSeconds": 10.0, "gain": 0.8,
                "fadeInSeconds": 0.5, "fadeOutSeconds": null
            }],
            "sectionMarkers": []
        }))
        .expect("test song")
    }

    fn with_real_file(mut song: Song, dir: &Path) -> Song {
        let file = dir.join("a.wav");
        std::fs::write(&file, b"RIFF").unwrap();
        song.clips[0].file_path = file.to_string_lossy().into_owned();
        song
    }

    #[test]
    fn plans_only_transposed_or_stretched_warp_clips() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");

        let transposed = with_real_file(song_json(true, 3, 120.0, true), dir.path());
        let bakes = plan(&transposed, &transposed, 48_000, &cache);
        assert_eq!(bakes.len(), 1);
        assert_eq!(bakes[0].spec.semitones, 3);
        assert_eq!(bakes[0].spec.ratio(), 1.0);
        assert_eq!(bakes[0].spec.source_start_seconds, 1.0);

        // Warp neutro: el motor ya va por Direct.
        let neutral = with_real_file(song_json(true, 0, 120.0, true), dir.path());
        assert!(plan(&neutral, &neutral, 48_000, &cache).is_empty());

        // Sin warp, el tono va por varispeed: barato, no se prepara.
        let varispeed = with_real_file(song_json(false, 3, 120.0, true), dir.path());
        assert!(plan(&varispeed, &varispeed, 48_000, &cache).is_empty());

        // Solo cambio de tempo: sí necesita Bungee.
        let stretched = with_real_file(song_json(true, 0, 100.0, true), dir.path());
        let bakes = plan(&stretched, &stretched, 48_000, &cache);
        assert_eq!(bakes.len(), 1);
        assert_eq!(bakes[0].spec.ratio(), 1.2);
    }

    #[test]
    fn never_transpose_track_bakes_zero_semitones_or_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let same_tempo = with_real_file(song_json(true, 3, 120.0, false), dir.path());
        assert!(plan(&same_tempo, &same_tempo, 48_000, &cache).is_empty());

        let other_tempo = with_real_file(song_json(true, 3, 100.0, false), dir.path());
        let bakes = plan(&other_tempo, &other_tempo, 48_000, &cache);
        assert_eq!(bakes.len(), 1);
        assert_eq!(bakes[0].spec.semitones, 0);
    }

    #[test]
    fn clip_crossing_the_region_edge_stays_live() {
        let dir = tempfile::tempdir().unwrap();
        let mut song = with_real_file(song_json(true, 3, 120.0, true), dir.path());
        song.regions[0].end_seconds = 8.0;
        assert!(plan(&song, &song, 48_000, &dir.path().join("cache")).is_empty());
    }

    #[test]
    fn key_changes_with_every_input_that_changes_the_audio() {
        let dir = tempfile::tempdir().unwrap();
        let song = with_real_file(song_json(true, 3, 120.0, true), dir.path());
        let base = plan(&song, &song, 48_000, dir.path())[0].spec.clone();
        let name = base.file_name().unwrap();
        let variants = [
            BakeSpec {
                semitones: 4,
                ..base.clone()
            },
            BakeSpec {
                source_bpm: 110.0,
                ..base.clone()
            },
            BakeSpec {
                target_bpm: 121.0,
                ..base.clone()
            },
            BakeSpec {
                source_start_seconds: 1.5,
                ..base.clone()
            },
            BakeSpec {
                duration_seconds: 9.0,
                ..base.clone()
            },
            BakeSpec {
                sample_rate: 44_100,
                ..base.clone()
            },
        ];
        for variant in variants {
            assert_ne!(variant.file_name().unwrap(), name, "{variant:?}");
        }
        assert_eq!(base.file_name().unwrap(), name, "estable");
    }

    #[test]
    fn apply_swaps_only_ready_clips_and_marks_the_json() {
        let dir = tempfile::tempdir().unwrap();
        let song = with_real_file(song_json(true, 3, 120.0, true), dir.path());
        let mut runtime = song.clone();
        let bakes = plan(&song, &runtime, 48_000, dir.path());

        assert!(apply(&mut runtime, &bakes).is_empty(), "nada en disco aún");
        assert_eq!(runtime.clips[0].source_start_seconds, 1.0);

        std::fs::write(&bakes[0].path, b"x").unwrap();
        let applied = apply(&mut runtime, &bakes);
        assert!(applied.contains("c"));
        assert_eq!(runtime.clips[0].source_start_seconds, 0.0);
        assert_eq!(
            runtime.clips[0].file_path,
            bakes[0].path.to_string_lossy().replace('\\', "/")
        );
        // Fundidos, ganancia y posición siguen siendo los del clip original.
        assert_eq!(runtime.clips[0].timeline_start_seconds, 2.0);
        assert_eq!(runtime.clips[0].gain, 0.8);
        assert_eq!(runtime.clips[0].fade_in_seconds, Some(0.5));

        let mut json = serde_json::to_value(&runtime).unwrap();
        mark_prerendered_in_session_json(&mut json, &applied);
        assert_eq!(
            json["clips"][0]["prerendered"],
            serde_json::Value::Bool(true)
        );
    }

    /// Dos pistas en la misma región, para la atomicidad por región.
    fn two_track_song(dir: &Path, transpose: i32) -> Song {
        let mut song = with_real_file(song_json(true, transpose, 120.0, true), dir);
        let mut track = song.tracks[0].clone();
        track.id = "t2".into();
        song.tracks.push(track);
        let mut clip = song.clips[0].clone();
        clip.id = "c2".into();
        clip.track_id = "t2".into();
        let other = dir.join("b.wav");
        std::fs::write(&other, b"RIFF2").unwrap();
        clip.file_path = other.to_string_lossy().into_owned();
        song.clips.push(clip);
        song
    }

    fn run(dir: &Path, song: &Song, sent: &mut SentClips) -> (Song, HashSet<String>, usize) {
        let mut runtime = song.clone();
        let (applied, missing) = substitute_in(dir, song, &mut runtime, 48_000, sent);
        (runtime, applied, missing.len())
    }

    #[test]
    fn while_preparing_the_previous_sound_keeps_playing() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let mut sent = SentClips::new();

        // Tono 0: el clip suena tal cual y queda como reserva.
        let plain = two_track_song(dir.path(), 0);
        let (_, applied, missing) = run(&cache, &plain, &mut sent);
        assert!(applied.is_empty());
        assert_eq!(missing, 0);
        assert_eq!(sent.len(), 2);

        // +3 sin nada preparado: sigue el original, marcado como preparado
        // (Direct, sin tono), no Bungee en directo.
        let up = two_track_song(dir.path(), 3);
        let (runtime, applied, missing) = run(&cache, &up, &mut sent);
        assert_eq!(missing, 2);
        assert!(applied.contains("c") && applied.contains("c2"));
        assert_eq!(runtime.clips[0].file_path, up.clips[0].file_path);
        assert_eq!(runtime.clips[0].source_start_seconds, 1.0);

        // Solo una pista lista: la región aún no cambia (nada de mezclar tonos).
        let bakes = plan(&up, &up, 48_000, &cache);
        std::fs::write(&bakes[0].path, b"x").unwrap();
        let (runtime, _, _) = run(&cache, &up, &mut sent);
        assert_eq!(runtime.clips[0].file_path, up.clips[0].file_path);

        // Las dos listas: cambian a la vez.
        std::fs::write(&bakes[1].path, b"x").unwrap();
        let (runtime, applied, missing) = run(&cache, &up, &mut sent);
        assert_eq!(missing, 0);
        assert_eq!(applied.len(), 2);
        assert_eq!(runtime.clips[0].source_start_seconds, 0.0);
        assert!(runtime.clips[0].file_path.ends_with(".wav"));
        assert_ne!(runtime.clips[0].file_path, up.clips[0].file_path);

        // +5 sin preparar: la reserva es ahora el audio de +3.
        let up5 = two_track_song(dir.path(), 5);
        let (runtime, applied, _) = run(&cache, &up5, &mut sent);
        assert_eq!(applied.len(), 2);
        assert_eq!(
            runtime.clips[0].file_path,
            bakes[0].path.to_string_lossy().replace('\\', "/")
        );
    }

    #[test]
    fn a_trimmed_clip_does_not_reuse_the_old_reserve() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let mut sent = SentClips::new();
        run(&cache, &two_track_song(dir.path(), 0), &mut sent);

        let mut trimmed = two_track_song(dir.path(), 3);
        trimmed.clips[0].source_start_seconds = 2.0;
        let (_, applied, _) = run(&cache, &trimmed, &mut sent);
        assert!(
            !applied.contains("c"),
            "otro tramo del original: en directo"
        );
        assert!(applied.contains("c2"));
    }

    /// Pasos por cero ascendentes de un canal: un seno de f Hz da ~f por
    /// segundo.
    fn rising_zero_crossings(samples: &[i16]) -> usize {
        samples.windows(2).filter(|w| w[0] < 0 && w[1] >= 0).count()
    }

    /// El render de verdad, con el motor enlazado: un seno de 440 Hz preparado
    /// a +12 semitonos tiene que salir a ~880 Hz, con la duración del clip en
    /// la línea de tiempo y sin el `.part` por medio.
    #[test]
    #[cfg_attr(feature = "no-link", ignore = "requires the real engine")]
    fn render_bake_shifts_pitch_and_keeps_timeline_length() {
        let dir = tempfile::tempdir().unwrap();
        let sr = 48_000u32;
        let source = dir.path().join("sine.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: sr,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&source, spec).unwrap();
        for i in 0..(sr * 6) {
            let v = (f64::from(i) * 440.0 * std::f64::consts::TAU / f64::from(sr)).sin();
            let s = (v * 12_000.0) as i16;
            writer.write_sample(s).unwrap();
            writer.write_sample(s).unwrap();
        }
        writer.finalize().unwrap();

        let mut song = song_json(true, 12, 120.0, true);
        song.clips[0].file_path = source.to_string_lossy().replace('\\', "/");
        song.clips[0].source_start_seconds = 0.5;
        song.clips[0].duration_seconds = 4.0;
        let cache = dir.path().join("cache");
        let bakes = plan(&song, &song, sr, &cache);
        assert_eq!(bakes.len(), 1);

        render_bake(&song, &bakes[0], &|| false).expect("render");
        assert!(bakes[0].is_ready());
        assert!(!bakes[0].path.with_extension("wav.part").exists());

        let mut reader = hound::WavReader::open(&bakes[0].path).unwrap();
        assert_eq!(reader.spec().sample_rate, sr);
        assert_eq!(reader.spec().channels, 2);
        let left: Vec<i16> = reader
            .samples::<i16>()
            .step_by(2)
            .map(|s| s.unwrap())
            .collect();
        let expected = (4.0 * f64::from(sr)) as usize;
        assert!(
            left.len().abs_diff(expected) <= 2,
            "duración {} frames, esperaba {expected}",
            left.len()
        );
        // Un segundo del medio, lejos de los bordes del render.
        let middle = &left[sr as usize..2 * sr as usize];
        let crossings = rising_zero_crossings(middle);
        assert!(
            (860..=900).contains(&crossings),
            "{crossings} Hz aprox., esperaba ~880"
        );
    }

    #[test]
    fn eviction_drops_oldest_files_but_never_the_ones_in_use() {
        let dir = tempfile::tempdir().unwrap();
        let path = |name: &str| dir.path().join(name);
        for (i, name) in ["old.wav", "kept.wav", "mid.wav", "new.wav"]
            .iter()
            .enumerate()
        {
            std::fs::write(path(name), vec![0u8; 100]).unwrap();
            let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000 + i as u64);
            std::fs::File::options()
                .write(true)
                .open(path(name))
                .unwrap()
                .set_modified(when)
                .unwrap();
        }
        let keep: HashSet<PathBuf> = [path("kept.wav")].into_iter().collect();
        evict_oldest(dir.path(), &keep, 200);
        assert!(!path("old.wav").exists());
        assert!(path("kept.wav").exists(), "en uso: nunca se borra");
        assert!(!path("mid.wav").exists());
        assert!(path("new.wav").exists());
    }

    #[test]
    fn bake_song_is_neutral_except_pitch_and_tempo() {
        let dir = tempfile::tempdir().unwrap();
        let mut song = with_real_file(song_json(true, 3, 100.0, true), dir.path());
        song.tracks[0].channel_mode = ChannelMode::Left;
        let spec = plan(&song, &song, 48_000, dir.path())[0].spec.clone();
        let bake = bake_song(&song, &spec).unwrap();
        assert_eq!(bake.tracks.len(), 1);
        assert_eq!(bake.tracks[0].channel_mode, ChannelMode::Stereo);
        assert_eq!(bake.clips[0].timeline_start_seconds, 0.0);
        assert_eq!(bake.clips[0].source_start_seconds, 1.0);
        assert_eq!(bake.clips[0].gain, 1.0);
        assert_eq!(bake.clips[0].fade_in_seconds, None);
        assert_eq!(bake.regions[0].transpose_semitones, 3);
        assert_eq!(bake.regions[0].warp_source_bpm, Some(100.0));
        assert_eq!(bake.bpm, 120.0);
        assert!(bake.tempo_markers.is_empty());
    }
}
