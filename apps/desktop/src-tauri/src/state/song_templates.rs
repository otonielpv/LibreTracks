//! Plantillas de canción: la estructura de pistas que una canción nueva trae
//! puesta, y que organiza los stems que se sueltan en ella.
//!
//! Una plantilla es un `.lttemplate` (una sesión sin contenido, ver
//! `strip_song_to_template`) o la de serie, que vive aquí en código. Lo que se
//! usa de ella son sus pistas: jerarquía, routing, colores y los alias con los
//! que `libretracks_core::track_matching` decide dónde va cada stem.
//!
//! Las pistas son de la sesión y una canción es una región, así que «aplicar
//! una plantilla a una canción» quiere decir garantizar que la sesión tenga las
//! pistas que la plantilla pide para ella. Dónde viven lo decide el ajuste
//! «Pistas de cada canción» (`SongImportTrackMode`):
//!
//! - `MergeIntoExisting` (compartidas): solo se crean las que falten, buscadas
//!   por nombre y tipo entre las pistas compartidas. A una que ya existe se le
//!   suman los alias de la plantilla que no tenga.
//! - `SongFolder`: una carpeta con el nombre de la canción y dentro una copia
//!   del árbol de la plantilla. Todo queda marcado con la canción.
//! - `KeepSeparate`: la copia del árbol, en la raíz, marcada con la canción.
//!
//! Ver docs/plans/song-templates/00-DISENO.md.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use libretracks_core::track_matching::match_stems;
use libretracks_core::{Song, SongRegion, Track, TrackKind};
use libretracks_project::{load_song_from_file, SongImportTrackMode};

use super::arrangement::auto_color_enabled;
use super::song_edit::{
    ensure_region_covers_clip_for_file, file_stem_for_auto_track, normalize_timeline_start_seconds,
    ui_locale,
};
use super::track_colors::auto_color_for_new_track;
use super::track_tree::insert_track;
use super::{strip_song_to_template, timestamp_suffix};
use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::infra::settings::AppSettings;

/// Referencia de la plantilla de serie en el ajuste `default_song_template`.
pub(crate) const BUILTIN_BAND_TEMPLATE: &str = "builtin:band";

/// Referencia explícita a «sin plantilla»: «Nueva canción» vacía aunque haya
/// una plantilla por defecto en Ajustes.
pub(crate) const NO_TEMPLATE: &str = "none";

/// La plantilla de serie: una banda de directo con los nombres con los que
/// vienen los multitracks comerciales (MultiTracks, Loop Community) y sus
/// equivalentes en español.
///
/// Click y Guía van a `master` a propósito: la salida de los cascos depende de
/// cada equipo, y una plantilla que diera por hecho la 3-4 sonaría por la PA de
/// alguien. El usuario cambia el routing y guarda su propia plantilla.
///
/// Las carpetas llevan color para que sus hijas lo hereden al crearse.
pub(crate) fn builtin_band_template(locale: Option<&str>) -> Vec<Track> {
    let spanish = locale == Some("es");
    let name = |es: &str, en: &str| if spanish { es } else { en }.to_string();
    let entries: [(&str, String, TrackKind, &str, &[&str]); 9] = [
        (
            "click",
            "Click".to_string(),
            TrackKind::Audio,
            "#9C73E6",
            &["click", "clic", "metronome", "metronomo", "met"],
        ),
        (
            "guide",
            name("Guía", "Guide"),
            TrackKind::Audio,
            "#C96FD6",
            &["guide", "guia", "cues", "cue", "voice guide"],
        ),
        (
            "drums",
            name("Batería", "Drums"),
            TrackKind::Folder,
            "#E35D5B",
            &[
                "drums",
                "drum",
                "bateria",
                "kick",
                "bombo",
                "snare",
                "caja",
                "hi hat",
                "toms",
                "tom",
                "overheads",
                "oh",
                "room",
                "cymbals",
                "perc",
                "percussion",
                "percusion",
                "loop",
                "loops",
            ],
        ),
        (
            "bass",
            name("Bajo", "Bass"),
            TrackKind::Folder,
            "#EE8A3C",
            &["bass", "bajo", "sub", "synth bass", "bass synth"],
        ),
        (
            "guitars",
            name("Guitarras", "Guitars"),
            TrackKind::Folder,
            "#E0A83A",
            &[
                "eg",
                "ag",
                "gtr",
                "guitar",
                "guitarra",
                "electric",
                "electrica",
                "acoustic",
                "acustica",
                "electric guitar",
                "acoustic guitar",
                "distor",
                "distorsion",
                "steel",
                "lap steel",
            ],
        ),
        (
            "keys",
            name("Teclados", "Keys"),
            TrackKind::Folder,
            "#57B66C",
            &[
                "keys",
                "teclas",
                "teclados",
                "teclado",
                "piano",
                "rhodes",
                "wurli",
                "organ",
                "organo",
                "b3",
                "electric piano",
                "acoustic piano",
            ],
        ),
        (
            "synths",
            name("Synth y pads", "Synths & pads"),
            TrackKind::Folder,
            "#4FB8E6",
            &[
                "synth",
                "synths",
                "sintetizador",
                "pad",
                "pads",
                "arp",
                "strings",
                "cuerdas",
                "orchestra",
                "orquesta",
                // Más palabras que «loop» (Batería, que va antes): sin esto el
                // empate se lo lleva la batería.
                "synth loop",
            ],
        ),
        (
            "vocals",
            name("Voces", "Vocals"),
            TrackKind::Folder,
            "#5C8CE6",
            &[
                "vox", "voz", "voces", "vocals", "vocal", "bgv", "bgvs", "coro", "coros", "choir",
                "chorus", "lead", "soprano", "alto", "tenor",
            ],
        ),
        (
            "fx",
            name("Efectos", "FX"),
            TrackKind::Folder,
            "#2FA98A",
            &[
                "fx", "sfx", "efectos", "sweep", "riser", "impact", "noise", "ambient",
            ],
        ),
    ];
    entries
        .into_iter()
        .map(|(id, name, kind, color, aliases)| Track {
            id: format!("builtin_{id}"),
            name,
            kind,
            parent_track_id: None,
            volume: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            transpose_enabled: true,
            audio_to: "master".to_string(),
            mono_downmix: false,
            color: Some(color.to_string()),
            auto_created: false,
            midi_port: None,
            midi_channel: 1,
            midi_enabled: true,
            collapsed: false,
            height_offset: None,
            match_aliases: aliases.iter().map(|alias| alias.to_string()).collect(),
            song_region_id: None,
        })
        .collect()
}

/// Las pistas de una plantilla, por su referencia: [`BUILTIN_BAND_TEMPLATE`] o
/// la ruta de un `.lttemplate`. Un fichero se limpia igual que al crear una
/// sesión desde él, por si se editó a mano.
pub(crate) fn load_template_tracks(
    reference: &str,
    locale: Option<&str>,
) -> Result<Vec<Track>, DesktopError> {
    if reference == BUILTIN_BAND_TEMPLATE {
        return Ok(builtin_band_template(locale));
    }
    let song = load_song_from_file(Path::new(reference))?;
    Ok(strip_song_to_template(song).tracks)
}

/// La plantilla para canciones nuevas que el usuario eligió en Ajustes, si
/// eligió una y se puede leer. Una ruta que ya no existe cuenta como «sin
/// plantilla»: nunca se cae a la de serie sin avisar (Ajustes lo enseña).
pub(crate) fn default_template_tracks(
    settings: &AppSettings,
    locale: Option<&str>,
) -> Option<Vec<Track>> {
    let reference = settings.default_song_template.as_deref()?.trim();
    if reference.is_empty() {
        return None;
    }
    match load_template_tracks(reference, locale) {
        Ok(tracks) => Some(tracks),
        Err(error) => {
            eprintln!("[song-templates] default template {reference:?} unreadable: {error}");
            None
        }
    }
}

/// Aplica a la canción `region_id` la plantilla `explicit` (la que el usuario
/// eligió al crearla) o, si no hay, la plantilla por defecto de Ajustes, con
/// el modo de pistas de Ajustes. Sin plantilla solo aplica la disposición.
pub(crate) fn apply_song_template(
    song: &mut Song,
    region_id: &str,
    explicit: Option<&str>,
    audio: &AudioController,
) -> Result<bool, DesktopError> {
    let settings = audio.current_settings().ok();
    let locale = ui_locale(audio);
    let template = match explicit.map(str::trim).filter(|r| !r.is_empty()) {
        Some(NO_TEMPLATE) => None,
        Some(reference) => Some(load_template_tracks(reference, locale.as_deref())?),
        None => settings
            .as_ref()
            .and_then(|settings| default_template_tracks(settings, locale.as_deref())),
    };
    let template = template.unwrap_or_default();
    let layout = settings
        .map(|settings| settings.track_layout())
        .unwrap_or_default();
    apply_template_to_region(
        song,
        &template,
        region_id,
        layout,
        auto_color_enabled(audio),
    )
}

/// La carpeta de una canción en el modo «carpeta por canción», si ya tiene.
pub(crate) fn song_folder_id(song: &Song, region_id: &str) -> Option<String> {
    song.tracks
        .iter()
        .find(|track| {
            track.kind == TrackKind::Folder
                && track.parent_track_id.is_none()
                && track.song_region_id.as_deref() == Some(region_id)
        })
        .map(|track| track.id.clone())
}

/// Ids nuevos y únicos en la sesión. `timestamp_suffix` va en milisegundos, así
/// que dos pistas creadas en el mismo lote necesitan además un contador.
pub(crate) struct TrackIdAllocator {
    used: HashSet<String>,
    stamp: u128,
    next: usize,
}

impl TrackIdAllocator {
    pub(crate) fn new(song: &Song) -> Self {
        Self {
            used: song.tracks.iter().map(|track| track.id.clone()).collect(),
            stamp: timestamp_suffix(),
            next: song.tracks.len(),
        }
    }

    pub(crate) fn allocate(&mut self) -> String {
        loop {
            let candidate = format!("track_{}_{}", self.stamp, self.next);
            self.next += 1;
            if self.used.insert(candidate.clone()) {
                return candidate;
            }
        }
    }
}

/// Aplica `template` a la canción `region_id` según `layout`. Devuelve si cambió
/// algo, para que quien llama sepa si hace falta reconstruir el motor.
///
/// Es idempotente: en los modos por canción no hace nada si la canción ya tiene
/// sus pistas, y en el compartido solo crea las que falten. Por eso se puede
/// llamar en cada drop sin acumular copias.
pub(crate) fn apply_template_to_region(
    song: &mut Song,
    template: &[Track],
    region_id: &str,
    layout: SongImportTrackMode,
    auto_color: bool,
) -> Result<bool, DesktopError> {
    let region_name = song
        .regions
        .iter()
        .find(|region| region.id == region_id)
        .map(|region| region.name.clone())
        .ok_or_else(|| DesktopError::AudioCommand(format!("song {region_id} not found")))?;
    let mut ids = TrackIdAllocator::new(song);
    // Id en la plantilla → id en la sesión, para colgar cada hija de su padre.
    let mut session_id_by_template_id: HashMap<String, String> = HashMap::new();

    match layout {
        SongImportTrackMode::MergeIntoExisting => {
            let mut changed = false;
            for template_track in template {
                let existing = song.tracks.iter_mut().find(|track| {
                    track.song_region_id.is_none()
                        && track.kind == template_track.kind
                        && track.name.trim().to_lowercase()
                            == template_track.name.trim().to_lowercase()
                });
                if let Some(existing) = existing {
                    changed |= merge_aliases(existing, &template_track.match_aliases);
                    session_id_by_template_id
                        .insert(template_track.id.clone(), existing.id.clone());
                    continue;
                }
                let parent = template_parent(template_track, &session_id_by_template_id);
                let track = copy_template_track(
                    song,
                    template_track,
                    ids.allocate(),
                    parent.clone(),
                    None,
                    template_track.audio_to.clone(),
                    auto_color,
                );
                session_id_by_template_id.insert(template_track.id.clone(), track.id.clone());
                insert_track(&mut song.tracks, track, None, parent.as_deref())?;
                changed = true;
            }
            Ok(changed)
        }
        SongImportTrackMode::SongFolder => {
            if song_folder_id(song, region_id).is_some() {
                return Ok(false);
            }
            let folder_id = ids.allocate();
            song.tracks
                .push(song_folder_track(folder_id.clone(), region_name, region_id));
            for template_track in template {
                let parent = template_parent(template_track, &session_id_by_template_id)
                    .or_else(|| Some(folder_id.clone()));
                // Lo que en la plantilla iba al master, dentro de la carpeta de
                // la canción suma a través de ella. Una salida concreta (los
                // cascos) se respeta.
                let audio_to = if template_track.parent_track_id.is_none()
                    && template_track
                        .audio_to
                        .trim()
                        .eq_ignore_ascii_case("master")
                {
                    "inherit".to_string()
                } else {
                    template_track.audio_to.clone()
                };
                let track = copy_template_track(
                    song,
                    template_track,
                    ids.allocate(),
                    parent.clone(),
                    Some(region_id.to_string()),
                    audio_to,
                    auto_color,
                );
                session_id_by_template_id.insert(template_track.id.clone(), track.id.clone());
                insert_track(&mut song.tracks, track, None, parent.as_deref())?;
            }
            Ok(true)
        }
        SongImportTrackMode::KeepSeparate => {
            if song
                .tracks
                .iter()
                .any(|track| track.song_region_id.as_deref() == Some(region_id))
            {
                return Ok(false);
            }
            for template_track in template {
                let parent = template_parent(template_track, &session_id_by_template_id);
                let track = copy_template_track(
                    song,
                    template_track,
                    ids.allocate(),
                    parent.clone(),
                    Some(region_id.to_string()),
                    template_track.audio_to.clone(),
                    auto_color,
                );
                session_id_by_template_id.insert(template_track.id.clone(), track.id.clone());
                insert_track(&mut song.tracks, track, None, parent.as_deref())?;
            }
            Ok(!template.is_empty())
        }
    }
}

/// La carpeta que agrupa las pistas de una canción en el modo «carpeta por
/// canción». Lleva el nombre de la canción y queda marcada con ella.
pub(crate) fn song_folder_track(id: String, name: String, region_id: &str) -> Track {
    Track {
        id,
        name,
        kind: TrackKind::Folder,
        parent_track_id: None,
        volume: 1.0,
        pan: 0.0,
        muted: false,
        solo: false,
        transpose_enabled: true,
        audio_to: "master".to_string(),
        mono_downmix: false,
        color: None,
        auto_created: false,
        midi_port: None,
        midi_channel: 1,
        midi_enabled: true,
        collapsed: false,
        height_offset: None,
        match_aliases: Vec::new(),
        song_region_id: Some(region_id.to_string()),
    }
}

fn template_parent(
    template_track: &Track,
    session_id_by_template_id: &HashMap<String, String>,
) -> Option<String> {
    template_track
        .parent_track_id
        .as_ref()
        .and_then(|parent| session_id_by_template_id.get(parent))
        .cloned()
}

fn copy_template_track(
    song: &Song,
    template_track: &Track,
    id: String,
    parent_track_id: Option<String>,
    song_region_id: Option<String>,
    audio_to: String,
    auto_color: bool,
) -> Track {
    let color = template_track
        .color
        .clone()
        .or_else(|| auto_color_for_new_track(&song.tracks, template_track.kind, auto_color));
    Track {
        id,
        parent_track_id,
        audio_to,
        color,
        // Una plantilla no trae clips: si estas pistas fueran auto-creadas, la
        // limpieza de pistas vacías se comería la estructura al momento.
        auto_created: false,
        song_region_id,
        ..template_track.clone()
    }
}

/// Suma a `track` los alias de `aliases` que no tenga ya (sin distinguir
/// mayúsculas). Devuelve si añadió alguno.
fn merge_aliases(track: &mut Track, aliases: &[String]) -> bool {
    let mut known: HashSet<String> = track
        .match_aliases
        .iter()
        .map(|alias| alias.trim().to_lowercase())
        .collect();
    let mut changed = false;
    for alias in aliases {
        if known.insert(alias.trim().to_lowercase()) {
            track.match_aliases.push(alias.clone());
            changed = true;
        }
    }
    changed
}

/// Los alias de `template` en las pistas compartidas con su mismo nombre y
/// tipo, sin crear ninguna. Es lo que hace el modo compartido con una pista
/// que ya existe.
fn merge_template_aliases(song: &mut Song, template: &[Track]) {
    for template_track in template {
        if let Some(existing) = song.tracks.iter_mut().find(|track| {
            track.song_region_id.is_none()
                && track.kind == template_track.kind
                && track.name.trim().to_lowercase() == template_track.name.trim().to_lowercase()
        }) {
            merge_aliases(existing, &template_track.match_aliases);
        }
    }
}

/// Un stem que se suelta: su fichero, dónde empieza (tiempo de fuente) y
/// cuánto dura.
pub(crate) struct StemDrop<'a> {
    pub file_path: &'a str,
    pub source_start_seconds: f64,
    pub duration_seconds: f64,
}

/// Dónde va a parar el clip de un stem.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum StemPlacement {
    /// La plantilla le encontró sitio: el clip va a esta pista.
    Matched { track_id: String },
    /// Ningún alias coincidió. Quien llama crea la pista como siempre, pero
    /// colgada de `parent_track_id` (la carpeta de la canción) y marcada con
    /// `song_region_id` cuando el modo de pistas es por canción.
    Unmatched {
        parent_track_id: Option<String>,
        song_region_id: Option<String>,
    },
}

/// Lo que el toast cuenta tras un drop organizado por la plantilla.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDropSummary {
    pub matched: usize,
    pub unmatched: usize,
}

impl TemplateDropSummary {
    pub(crate) fn of(placements: &[StemPlacement]) -> Self {
        let matched = placements
            .iter()
            .filter(|placement| matches!(placement, StemPlacement::Matched { .. }))
            .count();
        Self {
            matched,
            unmatched: placements.len() - matched,
        }
    }
}

/// Decide dónde va cada stem de un drop. `None` = la organización está
/// apagada (pistas compartidas, sin plantilla ni pistas con alias) y quien
/// llama sigue exactamente su camino de siempre.
///
/// `drops` son `(fichero, inicio en tiempo de fuente)`. Lee la duración de cada
/// audio para saber en qué canción cae y delega en [`organise_stem_drop_with`].
pub(crate) fn organise_stem_drop(
    song: &mut Song,
    song_dir: &Path,
    drops: &[(&str, f64)],
    new_tracks_auto_created: bool,
    audio: &AudioController,
) -> Result<Option<Vec<StemPlacement>>, DesktopError> {
    let settings = audio.current_settings().ok();
    let locale = ui_locale(audio);
    let template = settings
        .as_ref()
        .and_then(|settings| default_template_tracks(settings, locale.as_deref()));
    let layout = settings
        .map(|settings| settings.track_layout())
        .unwrap_or_default();
    if template.is_none()
        && layout == SongImportTrackMode::MergeIntoExisting
        && !song.tracks.iter().any(|t| !t.match_aliases.is_empty())
    {
        return Ok(None);
    }
    let mut stems = Vec::with_capacity(drops.len());
    for (file_path, source_start_seconds) in drops {
        let path = file_path.replace('\\', "/");
        let metadata = libretracks_project::read_audio_metadata(super::resolve_audio_file_path(
            song_dir, &path,
        ))?;
        stems.push(StemDrop {
            file_path,
            source_start_seconds: *source_start_seconds,
            duration_seconds: metadata.duration_seconds,
        });
    }
    organise_stem_drop_with(
        song,
        &stems,
        template.as_deref(),
        layout,
        auto_color_enabled(audio),
        new_tracks_auto_created,
        locale.as_deref(),
    )
    .map(Some)
}

/// El corazón de [`organise_stem_drop`], sin ajustes ni disco.
///
/// Primero da a cada stem su canción, creándola o alargándola igual que hará
/// su clip al colocarse. Luego, por canción: aplica la plantilla (idempotente),
/// busca los destinos (las pistas con alias de esa canción o, si no tiene, las
/// compartidas), juzga los nombres con `track_matching` y coloca:
/// - en una **pista** libre en esa canción, el stem va a ella; si ya tiene
///   audio en la canción, a una pista hermana con su color y su routing;
/// - en una **carpeta**, a una hija con el mismo nombre que esté libre en la
///   canción o, si no hay, a una hija nueva con el color de la carpeta.
pub(crate) fn organise_stem_drop_with(
    song: &mut Song,
    stems: &[StemDrop<'_>],
    template: Option<&[Track]>,
    layout: SongImportTrackMode,
    auto_color: bool,
    new_tracks_auto_created: bool,
    locale: Option<&str>,
) -> Result<Vec<StemPlacement>, DesktopError> {
    let mut region_of_stem = Vec::with_capacity(stems.len());
    for stem in stems {
        let start = normalize_timeline_start_seconds(stem.source_start_seconds);
        ensure_region_covers_clip_for_file(
            song,
            start,
            start + stem.duration_seconds,
            Some(stem.file_path),
            locale,
        )?;
        let region_id = song
            .regions
            .iter()
            .find(|region| start >= region.start_seconds && start < region.end_seconds)
            .map(|region| region.id.clone())
            .ok_or_else(|| DesktopError::AudioCommand("dropped stem has no song".into()))?;
        region_of_stem.push(region_id);
    }

    let mut region_order: Vec<String> = Vec::new();
    for region_id in &region_of_stem {
        if !region_order.contains(region_id) {
            region_order.push(region_id.clone());
        }
    }
    let mut placements: Vec<Option<StemPlacement>> = vec![None; stems.len()];
    let mut used: HashSet<String> = HashSet::new();
    let mut last_sibling: HashMap<String, String> = HashMap::new();
    let per_song = layout != SongImportTrackMode::MergeIntoExisting;
    // Shared tracks that already have aliases are the session's own layout
    // (a song created «from template…», or a session made from one): the
    // default template must not add its tracks next to them. It still lends
    // its aliases to the tracks it shares a name with.
    let session_has_layout = !per_song && !alias_targets(song, None).is_empty();
    for region_id in region_order {
        if session_has_layout {
            merge_template_aliases(song, template.unwrap_or_default());
        } else {
            apply_template_to_region(song, template.unwrap_or_default(), &region_id, layout, auto_color)?;
        }
        // Después de la plantilla: sus pistas ya tienen id y no se repiten.
        let mut ids = TrackIdAllocator::new(song);
        let indexes: Vec<usize> = (0..stems.len())
            .filter(|&index| region_of_stem[index] == region_id)
            .collect();
        let (region_name, region_span) = song
            .regions
            .iter()
            .find(|region| region.id == region_id)
            .map(|region| {
                (
                    region.name.clone(),
                    (region.start_seconds, region.end_seconds),
                )
            })
            .ok_or_else(|| DesktopError::AudioCommand("dropped stem has no song".into()))?;

        let own_targets = alias_targets(song, Some(&region_id));
        let targets = if own_targets.is_empty() {
            alias_targets(song, None)
        } else {
            own_targets
        };
        let names: Vec<String> = indexes
            .iter()
            .map(|&index| file_stem_for_auto_track(stems[index].file_path))
            .collect();
        let name_refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let alias_lists: Vec<&[String]> = targets
            .iter()
            .map(|(_, aliases)| aliases.as_slice())
            .collect();
        let matches = match_stems(&name_refs, Some(&region_name), &alias_lists);
        let lane_names = lane_names(&names);

        for (position, &index) in indexes.iter().enumerate() {
            let placement = matches[position].and_then(|target| {
                place_on_target(
                    song,
                    &targets[target].0,
                    &lane_names[position],
                    region_span,
                    &mut ids,
                    &mut used,
                    &mut last_sibling,
                    auto_color,
                    new_tracks_auto_created,
                )
            });
            placements[index] = Some(placement.unwrap_or_else(|| {
                StemPlacement::Unmatched {
                    parent_track_id: (per_song && layout == SongImportTrackMode::SongFolder)
                        .then(|| song_folder_id(song, &region_id))
                        .flatten(),
                    song_region_id: per_song.then(|| region_id.clone()),
                }
            }));
        }
    }
    Ok(placements.into_iter().flatten().collect())
}

/// Las pistas con alias, en el orden del arreglo (que es la prioridad), de la
/// canción `region_id` o, con `None`, las compartidas.
fn alias_targets(song: &Song, region_id: Option<&str>) -> Vec<(String, Vec<String>)> {
    song.tracks
        .iter()
        .filter(|track| {
            !track.match_aliases.is_empty() && track.song_region_id.as_deref() == region_id
        })
        .map(|track| (track.id.clone(), track.match_aliases.clone()))
        .collect()
}

/// Nombres para las pistas que se creen: el del fichero sin lo que todo el lote
/// comparte al principio («Way Maker - EG 1» → «EG 1»), salvo que quitarlo deje
/// solo números («EG 1», «EG 2» comparten «EG »).
fn lane_names(names: &[String]) -> Vec<String> {
    if names.len() < 2 {
        return names.to_vec();
    }
    let is_separator = |ch: char| ch.is_whitespace() || ch == '-' || ch == '_' || ch == '.';
    let first: Vec<char> = names[0].chars().collect();
    let mut common = first.len();
    for name in &names[1..] {
        let shared = first
            .iter()
            .zip(name.chars())
            .take_while(|(left, right)| **left == *right)
            .count();
        common = common.min(shared);
    }
    // Cortar solo en un separador, nunca a media palabra.
    while common > 0 && !is_separator(first[common - 1]) {
        common -= 1;
    }
    if common == 0 {
        return names.to_vec();
    }
    let stripped: Vec<String> = names
        .iter()
        .map(|name| {
            name.chars()
                .skip(common)
                .collect::<String>()
                .trim_matches(is_separator)
                .to_string()
        })
        .collect();
    let only_numbers = stripped
        .iter()
        .any(|name| name.is_empty() || name.chars().all(|ch| ch.is_numeric() || is_separator(ch)));
    if only_numbers {
        names.to_vec()
    } else {
        stripped
    }
}

#[allow(clippy::too_many_arguments)]
fn place_on_target(
    song: &mut Song,
    target_id: &str,
    lane_name: &str,
    (region_start, region_end): (f64, f64),
    ids: &mut TrackIdAllocator,
    used: &mut HashSet<String>,
    last_sibling: &mut HashMap<String, String>,
    auto_color: bool,
    new_tracks_auto_created: bool,
) -> Option<StemPlacement> {
    let target = song
        .tracks
        .iter()
        .find(|track| track.id == target_id)?
        .clone();
    // Ocupada en esta canción: ya tiene audio en ella o se la ha llevado otro
    // stem del mismo lote.
    let busy = |song: &Song, used: &HashSet<String>, track_id: &str| {
        used.contains(track_id)
            || song.clips.iter().any(|clip| {
                clip.track_id == track_id
                    && clip.timeline_start_seconds < region_end
                    && clip.timeline_start_seconds + clip.duration_seconds > region_start
            })
    };
    let track_id = match target.kind {
        TrackKind::Folder => {
            let reusable = song
                .tracks
                .iter()
                .find(|track| {
                    track.parent_track_id.as_deref() == Some(target.id.as_str())
                        && track.kind == TrackKind::Audio
                        && track.name.trim().eq_ignore_ascii_case(lane_name.trim())
                        && !busy(song, used, &track.id)
                })
                .map(|track| track.id.clone());
            match reusable {
                Some(track_id) => track_id,
                None => {
                    let child = lane_track(
                        song,
                        ids.allocate(),
                        lane_name,
                        Some(target.id.clone()),
                        "inherit".to_string(),
                        target.color.clone(),
                        target.song_region_id.clone(),
                        auto_color,
                        new_tracks_auto_created,
                    );
                    let child_id = child.id.clone();
                    insert_track(&mut song.tracks, child, None, Some(&target.id)).ok()?;
                    child_id
                }
            }
        }
        TrackKind::Audio if !busy(song, used, &target.id) => target.id.clone(),
        TrackKind::Audio => {
            let sibling = lane_track(
                song,
                ids.allocate(),
                lane_name,
                target.parent_track_id.clone(),
                target.audio_to.clone(),
                target.color.clone(),
                target.song_region_id.clone(),
                auto_color,
                new_tracks_auto_created,
            );
            let sibling_id = sibling.id.clone();
            let after = last_sibling
                .get(&target.id)
                .cloned()
                .unwrap_or_else(|| target.id.clone());
            insert_track(
                &mut song.tracks,
                sibling,
                Some(&after),
                target.parent_track_id.as_deref(),
            )
            .ok()?;
            last_sibling.insert(target.id.clone(), sibling_id.clone());
            sibling_id
        }
        // Una pista MIDI o de vídeo no recibe audio: el stem sigue su camino.
        _ => return None,
    };
    used.insert(track_id.clone());
    Some(StemPlacement::Matched { track_id })
}

#[allow(clippy::too_many_arguments)]
fn lane_track(
    song: &Song,
    id: String,
    name: &str,
    parent_track_id: Option<String>,
    audio_to: String,
    color: Option<String>,
    song_region_id: Option<String>,
    auto_color: bool,
    auto_created: bool,
) -> Track {
    let color =
        color.or_else(|| auto_color_for_new_track(&song.tracks, TrackKind::Audio, auto_color));
    Track {
        id,
        name: name.to_string(),
        kind: TrackKind::Audio,
        parent_track_id,
        volume: 1.0,
        pan: 0.0,
        muted: false,
        solo: false,
        transpose_enabled: true,
        audio_to,
        mono_downmix: false,
        color,
        auto_created,
        midi_port: None,
        midi_channel: 1,
        midi_enabled: true,
        collapsed: false,
        height_offset: None,
        match_aliases: Vec::new(),
        song_region_id,
    }
}

/// Al renombrar una canción, su carpeta del modo «carpeta por canción» se
/// renombra con ella. Solo si la carpeta sigue llamándose como la canción: si
/// el usuario le puso otro nombre a mano, se respeta. Devuelve si cambió algo.
pub(crate) fn rename_song_folder(
    song: &mut Song,
    region_id: &str,
    old_name: &str,
    new_name: &str,
) -> bool {
    if old_name == new_name {
        return false;
    }
    let Some(folder_id) = song_folder_id(song, region_id) else {
        return false;
    };
    match song.tracks.iter_mut().find(|track| track.id == folder_id) {
        Some(folder) if folder.name == old_name => {
            folder.name = new_name.to_string();
            true
        }
        _ => false,
    }
}

/// Cuando una canción nueva se come a otras (crear una canción sobre un rango
/// que ya tenía una, como hace soltar una carpeta de la biblioteca: primero
/// los audios crean su canción y luego se crea la definitiva encima), las
/// pistas marcadas con las canciones que han desaparecido pasan a la canción
/// que ahora contiene su principio. Sin esto se quedaban huérfanas y la
/// plantilla, al no encontrar pistas de la canción nueva, hacía otra copia.
///
/// `previous` son las canciones de antes del cambio. Su carpeta, si aún se
/// llama como la canción vieja, toma el nombre de la nueva.
pub(crate) fn reassign_tracks_of_replaced_songs(song: &mut Song, previous: &[SongRegion]) {
    let still_there: HashSet<&str> = song.regions.iter().map(|r| r.id.as_str()).collect();
    let mut moves: Vec<(String, String, String, String)> = Vec::new();
    for old in previous {
        if still_there.contains(old.id.as_str()) {
            continue;
        }
        let Some(heir) = song.regions.iter().find(|region| {
            old.start_seconds >= region.start_seconds && old.start_seconds < region.end_seconds
        }) else {
            continue;
        };
        moves.push((
            old.id.clone(),
            old.name.clone(),
            heir.id.clone(),
            heir.name.clone(),
        ));
    }
    for (old_id, old_name, heir_id, heir_name) in moves {
        for track in &mut song.tracks {
            if track.song_region_id.as_deref() == Some(old_id.as_str()) {
                track.song_region_id = Some(heir_id.clone());
            }
        }
        rename_song_folder(song, &heir_id, &old_name, &heir_name);
    }
}

/// Al borrar una canción se van con ella las pistas que se crearon para ella
/// (las marcadas con `song_region_id`) y que se han quedado sin nada: sin clips
/// y sin hijas. Se borran de las hojas hacia arriba, así que la carpeta de la
/// canción cae al final si quedó vacía. Una pista suya que todavía tiene audio
/// en otra parte, o una pista del usuario metida en la carpeta, la mantienen.
///
/// Las pistas compartidas no llevan marca y nunca se tocan.
pub(crate) fn remove_empty_song_tracks(song: &mut Song, region_id: &str) -> bool {
    let mut removed_any = false;
    loop {
        let used: HashSet<&str> = song
            .clips
            .iter()
            .map(|clip| clip.track_id.as_str())
            .chain(song.midi_clips.iter().map(|clip| clip.track_id.as_str()))
            .chain(song.video_clips.iter().map(|clip| clip.track_id.as_str()))
            .collect();
        let parents: HashSet<&str> = song
            .tracks
            .iter()
            .filter_map(|track| track.parent_track_id.as_deref())
            .collect();
        let empty: HashSet<String> = song
            .tracks
            .iter()
            .filter(|track| {
                track.song_region_id.as_deref() == Some(region_id)
                    && !used.contains(track.id.as_str())
                    && !parents.contains(track.id.as_str())
            })
            .map(|track| track.id.clone())
            .collect();
        if empty.is_empty() {
            return removed_any;
        }
        song.tracks.retain(|track| !empty.contains(&track.id));
        removed_any = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::SongRegion;

    fn region(id: &str, name: &str, start: f64, end: f64) -> SongRegion {
        SongRegion {
            key_changes: Vec::new(),
            id: id.into(),
            name: name.into(),
            start_seconds: start,
            end_seconds: end,
            transpose_semitones: 0,
            key: None,
            warp_enabled: false,
            warp_source_bpm: None,
            master: libretracks_core::SongMaster::default(),
            compact_column_width_rem: None,
            chart: None,
            cover_image: None,
            voice_guide_count_style: None,
            structure: None,
        }
    }

    fn session(regions: Vec<SongRegion>) -> Song {
        Song {
            id: "song".into(),
            title: "Set".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 60.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions,
            tracks: vec![],
            clips: vec![],
            midi_clips: vec![],
            video_clips: vec![],
            section_markers: vec![],
        }
    }

    /// A folder with a child: enough to see the tree copied with its parents.
    fn template() -> Vec<Track> {
        let mut tracks = builtin_band_template(Some("es"));
        tracks.truncate(3); // Click, Guía, Batería
        let mut kick = tracks[0].clone();
        kick.id = "builtin_kick".into();
        kick.name = "Kick".into();
        kick.parent_track_id = Some("builtin_drums".into());
        kick.audio_to = "inherit".into();
        kick.match_aliases = vec!["kick".into()];
        tracks.push(kick);
        tracks
    }

    fn by_name<'a>(song: &'a Song, name: &str) -> Vec<&'a Track> {
        song.tracks
            .iter()
            .filter(|track| track.name == name)
            .collect()
    }

    #[test]
    fn the_builtin_template_is_localised_and_every_target_has_aliases() {
        let es = builtin_band_template(Some("es"));
        let en = builtin_band_template(None);
        assert_eq!(es[2].name, "Batería");
        assert_eq!(en[2].name, "Drums");
        assert!(es.iter().all(|track| !track.match_aliases.is_empty()));
        // Nothing assumes a headphone output.
        assert!(es.iter().all(|track| track.audio_to == "master"));
    }

    #[test]
    fn shared_creates_only_the_missing_tracks_and_merges_aliases() {
        let mut song = session(vec![
            region("r1", "Uno", 0.0, 10.0),
            region("r2", "Dos", 10.0, 20.0),
        ]);
        let mut click = template()[0].clone();
        click.id = "user_click".into();
        click.match_aliases = vec!["CLICK".into(), "metro".into()];
        song.tracks.push(click);

        let template = template();
        let changed = apply_template_to_region(
            &mut song,
            &template,
            "r1",
            SongImportTrackMode::MergeIntoExisting,
            true,
        )
        .expect("apply");
        assert!(changed);
        assert_eq!(
            by_name(&song, "Click").len(),
            1,
            "the existing click is reused"
        );
        let click = by_name(&song, "Click")[0];
        assert_eq!(click.id, "user_click");
        // Its own aliases stay, the template's missing ones are added once.
        assert!(click.match_aliases.contains(&"metro".to_string()));
        assert!(click.match_aliases.contains(&"clic".to_string()));
        assert_eq!(
            click
                .match_aliases
                .iter()
                .filter(|a| a.eq_ignore_ascii_case("click"))
                .count(),
            1
        );
        // The kick hangs from the session's drums folder, not the template's id.
        let drums = by_name(&song, "Batería")[0];
        let kick = by_name(&song, "Kick")[0];
        assert_eq!(kick.parent_track_id.as_ref(), Some(&drums.id));
        assert!(song
            .tracks
            .iter()
            .all(|track| track.song_region_id.is_none()));

        // A second song with the same template adds nothing.
        let tracks_before = song.tracks.len();
        let changed = apply_template_to_region(
            &mut song,
            &template,
            "r2",
            SongImportTrackMode::MergeIntoExisting,
            true,
        )
        .expect("apply again");
        assert!(!changed);
        assert_eq!(song.tracks.len(), tracks_before);
    }

    #[test]
    fn song_folder_copies_the_tree_inside_a_folder_named_after_the_song() {
        let mut song = session(vec![region("r1", "Way Maker", 0.0, 10.0)]);
        let template = template();
        apply_template_to_region(
            &mut song,
            &template,
            "r1",
            SongImportTrackMode::SongFolder,
            true,
        )
        .expect("apply");

        let folder_id = song_folder_id(&song, "r1").expect("song folder");
        let folder = song.tracks.iter().find(|t| t.id == folder_id).unwrap();
        assert_eq!(folder.name, "Way Maker");
        assert_eq!(song.tracks[0].id, folder_id, "the folder heads its tracks");

        let click = by_name(&song, "Click")[0];
        assert_eq!(click.parent_track_id.as_ref(), Some(&folder_id));
        assert_eq!(click.audio_to, "inherit", "master becomes the song folder");
        assert_eq!(click.song_region_id.as_deref(), Some("r1"));
        let drums = by_name(&song, "Batería")[0];
        let kick = by_name(&song, "Kick")[0];
        assert_eq!(kick.parent_track_id.as_ref(), Some(&drums.id));
        assert!(song
            .tracks
            .iter()
            .all(|t| t.song_region_id.as_deref() == Some("r1")));
        // Folder, then its subtree contiguous: every track after the folder.
        assert!(song
            .tracks
            .iter()
            .skip(1)
            .all(|t| t.parent_track_id.is_some()));

        // Idempotent: the song already has its folder.
        let before = song.tracks.len();
        let changed = apply_template_to_region(
            &mut song,
            &template,
            "r1",
            SongImportTrackMode::SongFolder,
            true,
        )
        .expect("apply again");
        assert!(!changed);
        assert_eq!(song.tracks.len(), before);
    }

    #[test]
    fn song_folder_keeps_a_specific_output() {
        let mut song = session(vec![region("r1", "Uno", 0.0, 10.0)]);
        let mut template = template();
        template[0].audio_to = "ext:2".into(); // the click to the in-ears
        apply_template_to_region(
            &mut song,
            &template,
            "r1",
            SongImportTrackMode::SongFolder,
            true,
        )
        .expect("apply");
        assert_eq!(by_name(&song, "Click")[0].audio_to, "ext:2");
    }

    #[test]
    fn separate_gives_each_song_its_own_copy_at_the_root() {
        let mut song = session(vec![
            region("r1", "Uno", 0.0, 10.0),
            region("r2", "Dos", 10.0, 20.0),
        ]);
        let template = template();
        for region_id in ["r1", "r2", "r1"] {
            apply_template_to_region(
                &mut song,
                &template,
                region_id,
                SongImportTrackMode::KeepSeparate,
                true,
            )
            .expect("apply");
        }
        let clicks = by_name(&song, "Click");
        assert_eq!(clicks.len(), 2, "one per song, and r1 was not copied twice");
        assert!(clicks.iter().all(|t| t.parent_track_id.is_none()));
        let regions: HashSet<_> = clicks.iter().map(|t| t.song_region_id.clone()).collect();
        assert_eq!(regions.len(), 2);
    }

    #[test]
    fn copied_tracks_are_never_auto_created() {
        let mut song = session(vec![region("r1", "Uno", 0.0, 10.0)]);
        let mut template = template();
        template.iter_mut().for_each(|t| t.auto_created = true);
        apply_template_to_region(
            &mut song,
            &template,
            "r1",
            SongImportTrackMode::KeepSeparate,
            true,
        )
        .expect("apply");
        assert!(song.tracks.iter().all(|t| !t.auto_created));
    }

    // ---- Drops ---------------------------------------------------------------

    fn stems<'a>(files: &[&'a str], start: f64) -> Vec<StemDrop<'a>> {
        files
            .iter()
            .map(|file_path| StemDrop {
                file_path,
                source_start_seconds: start,
                duration_seconds: 8.0,
            })
            .collect()
    }

    fn track_of<'a>(song: &'a Song, placement: &StemPlacement) -> &'a Track {
        match placement {
            StemPlacement::Matched { track_id } => song
                .tracks
                .iter()
                .find(|t| &t.id == track_id)
                .expect("placed track"),
            other => panic!("expected a match, got {other:?}"),
        }
    }

    fn put_clips(song: &mut Song, stems: &[StemDrop<'_>], placements: &[StemPlacement]) {
        for (index, placement) in placements.iter().enumerate() {
            if let StemPlacement::Matched { track_id } = placement {
                song.clips.push(libretracks_core::Clip {
                    id: format!("clip_{}_{index}", song.clips.len()),
                    track_id: track_id.clone(),
                    file_path: stems[index].file_path.to_string(),
                    timeline_start_seconds: stems[index].source_start_seconds,
                    source_start_seconds: 0.0,
                    duration_seconds: stems[index].duration_seconds,
                    gain: 1.0,
                    fade_in_seconds: None,
                    fade_out_seconds: None,
                    color: None,
                });
            }
        }
    }

    const MULTITRACK: [&str; 7] = [
        "audio/Way Maker - Click.wav",
        "audio/Way Maker - Guide.wav",
        "audio/Way Maker - EG 1.wav",
        "audio/Way Maker - EG 2.wav",
        "audio/Way Maker - Keys.wav",
        "audio/Way Maker - BGVs.wav",
        "audio/Way Maker - Banjo.wav",
    ];

    #[test]
    fn a_drop_into_an_empty_session_creates_the_song_and_lays_out_the_stems() {
        let mut song = session(vec![]);
        let template = builtin_band_template(Some("es"));
        let drop = stems(&MULTITRACK, 0.0);
        let placements = organise_stem_drop_with(
            &mut song,
            &drop,
            Some(&template),
            SongImportTrackMode::MergeIntoExisting,
            true,
            false,
            Some("es"),
        )
        .expect("organise");

        assert_eq!(song.regions.len(), 1, "the drop created its song");
        assert_eq!(track_of(&song, &placements[0]).name, "Click");
        assert_eq!(track_of(&song, &placements[1]).name, "Guía");
        // Both guitars are children of Guitarras, each on its own lane named
        // without the song's prefix, coloured like the folder.
        let guitars = song.tracks.iter().find(|t| t.name == "Guitarras").unwrap();
        for (placement, lane) in [(&placements[2], "EG 1"), (&placements[3], "EG 2")] {
            let track = track_of(&song, placement);
            assert_eq!(track.name, lane);
            assert_eq!(track.parent_track_id.as_ref(), Some(&guitars.id));
            assert_eq!(track.audio_to, "inherit");
            assert_eq!(track.color, guitars.color);
            assert!(!track.auto_created);
        }
        let keys = song.tracks.iter().find(|t| t.name == "Teclados").unwrap();
        assert_eq!(
            track_of(&song, &placements[4]).parent_track_id.as_ref(),
            Some(&keys.id)
        );
        assert_eq!(track_of(&song, &placements[5]).name, "BGVs");
        assert_eq!(
            placements[6],
            StemPlacement::Unmatched {
                parent_track_id: None,
                song_region_id: None
            },
            "the banjo has no place in the template and goes its usual way",
        );
        assert_eq!(
            TemplateDropSummary::of(&placements),
            TemplateDropSummary {
                matched: 6,
                unmatched: 1
            }
        );
    }

    #[test]
    fn a_taken_track_gets_a_sibling_with_its_colour_and_routing() {
        let mut song = session(vec![region("r1", "Uno", 0.0, 30.0)]);
        let mut template = builtin_band_template(Some("es"));
        template[0].audio_to = "ext:2".into();
        let drop = stems(&["Click.wav", "Click alt.wav"], 0.0);
        let placements = organise_stem_drop_with(
            &mut song,
            &drop,
            Some(&template),
            SongImportTrackMode::MergeIntoExisting,
            true,
            false,
            None,
        )
        .expect("organise");
        let first = track_of(&song, &placements[0]);
        let second = track_of(&song, &placements[1]);
        assert_eq!(first.name, "Click");
        assert_ne!(first.id, second.id);
        assert_eq!(second.audio_to, "ext:2");
        assert_eq!(second.color, first.color);
        let position = |id: &str| song.tracks.iter().position(|t| t.id == id).unwrap();
        assert_eq!(
            position(&second.id),
            position(&first.id) + 1,
            "right below it"
        );
    }

    #[test]
    fn shared_lanes_are_reused_by_the_next_song() {
        let mut song = session(vec![
            region("r1", "Uno", 0.0, 10.0),
            region("r2", "Dos", 20.0, 30.0),
        ]);
        let template = builtin_band_template(Some("es"));
        let first = stems(&["Uno - Click.wav", "Uno - EG 1.wav"], 0.0);
        let placements = organise_stem_drop_with(
            &mut song,
            &first,
            Some(&template),
            SongImportTrackMode::MergeIntoExisting,
            true,
            false,
            None,
        )
        .expect("first song");
        put_clips(&mut song, &first, &placements);
        let tracks_after_first = song.tracks.len();
        let first_click = track_of(&song, &placements[0]).id.clone();
        let first_guitar = track_of(&song, &placements[1]).id.clone();

        let second = stems(&["Dos - Click.wav", "Dos - EG 1.wav"], 20.0);
        let placements = organise_stem_drop_with(
            &mut song,
            &second,
            Some(&template),
            SongImportTrackMode::MergeIntoExisting,
            true,
            false,
            None,
        )
        .expect("second song");
        assert_eq!(track_of(&song, &placements[0]).id, first_click);
        assert_eq!(
            track_of(&song, &placements[1]).id,
            first_guitar,
            "same lane, other song"
        );
        assert_eq!(song.tracks.len(), tracks_after_first);
    }

    #[test]
    fn song_folder_drops_land_inside_the_songs_own_folder() {
        let mut song = session(vec![
            region("r1", "Uno", 0.0, 10.0),
            region("r2", "Dos", 20.0, 30.0),
        ]);
        let template = builtin_band_template(Some("es"));
        for (start, region_id) in [(0.0, "r1"), (20.0, "r2")] {
            let drop = stems(&["Click.wav", "Banjo.wav"], start);
            let placements = organise_stem_drop_with(
                &mut song,
                &drop,
                Some(&template),
                SongImportTrackMode::SongFolder,
                true,
                false,
                None,
            )
            .expect("organise");
            let folder = song_folder_id(&song, region_id).expect("song folder");
            let click = track_of(&song, &placements[0]);
            assert_eq!(click.song_region_id.as_deref(), Some(region_id));
            assert_eq!(click.parent_track_id.as_ref(), Some(&folder));
            // The banjo has no target but still belongs inside the song.
            assert_eq!(
                placements[1],
                StemPlacement::Unmatched {
                    parent_track_id: Some(folder.clone()),
                    song_region_id: Some(region_id.to_string()),
                }
            );
        }
        assert_eq!(song.tracks.iter().filter(|t| t.name == "Click").count(), 2);
    }

    #[test]
    fn a_session_made_from_a_template_organises_drops_without_a_default() {
        let mut song = session(vec![region("r1", "Uno", 0.0, 10.0)]);
        let mut click = builtin_band_template(None)[0].clone();
        click.id = "session_click".into();
        song.tracks.push(click);
        let drop = stems(&["Click.wav", "Keys.wav"], 0.0);
        let placements = organise_stem_drop_with(
            &mut song,
            &drop,
            None,
            SongImportTrackMode::SongFolder,
            true,
            false,
            None,
        )
        .expect("organise");
        assert_eq!(track_of(&song, &placements[0]).id, "session_click");
        let folder_id = song_folder_id(&song, "r1").expect("song folder");
        assert_eq!(
            placements[1],
            StemPlacement::Unmatched {
                parent_track_id: Some(folder_id),
                song_region_id: Some("r1".into())
            }
        );
        assert_eq!(song.tracks.len(), 2);
    }

    /// Stems de un setlist real que la plantilla de serie no sabía colocar.
    #[test]
    fn the_builtin_template_places_the_stems_of_a_real_setlist() {
        let parent_of = |song: &Song, placement: &StemPlacement| {
            let track = track_of(song, placement);
            song.tracks
                .iter()
                .find(|t| Some(&t.id) == track.parent_track_id.as_ref())
                .map(|t| t.name.clone())
        };
        let mut song = session(vec![]);
        let template = builtin_band_template(Some("es"));
        let files = [
            "audio/Alto.wav",
            "audio/Tenor.wav",
            "audio/CHORUS_04.wav",
            "audio/DISTOR 1_06.wav",
            "audio/DISTORSION_12.wav",
            "audio/Lap Steel.wav",
            "audio/Synth Loop.wav",
            "audio/LOOP_01.wav",
        ];
        let drop = stems(&files, 0.0);
        let placements = organise_stem_drop_with(
            &mut song,
            &drop,
            Some(&template),
            SongImportTrackMode::MergeIntoExisting,
            true,
            false,
            Some("es"),
        )
        .expect("organise");
        let expected = [
            "Voces",
            "Voces",
            "Voces",
            "Guitarras",
            "Guitarras",
            "Guitarras",
            "Synth y pads",
            // Un loop a secas sigue siendo de la batería.
            "Batería",
        ];
        for (index, group) in expected.iter().enumerate() {
            assert_eq!(
                parent_of(&song, &placements[index]).as_deref(),
                Some(*group),
                "{}",
                files[index]
            );
        }
    }

    /// Una canción creada «desde plantilla…» con otra plantilla: al soltar sus
    /// stems, la plantilla por defecto no añade sus pistas a las de la sesión.
    #[test]
    fn shared_drops_keep_the_layout_the_session_already_has() {
        let mut song = session(vec![region("r1", "Uno", 0.0, 10.0)]);
        // La plantilla elegida: solo Click y una carpeta de teclados propia.
        let mut click = builtin_band_template(Some("es"))[0].clone();
        click.id = "own_click".into();
        click.match_aliases = vec!["click".into()];
        let mut keys = builtin_band_template(Some("es"))[5].clone();
        keys.id = "own_keys".into();
        keys.name = "Pianos".into();
        keys.match_aliases = vec!["keys".into()];
        song.tracks = vec![click, keys];
        let default_template = builtin_band_template(Some("es"));
        let drop = stems(&["audio/Click.wav", "audio/Keys.wav", "audio/EG 1.wav"], 0.0);
        let placements = organise_stem_drop_with(
            &mut song,
            &drop,
            Some(&default_template),
            SongImportTrackMode::MergeIntoExisting,
            true,
            false,
            Some("es"),
        )
        .expect("organise");

        assert!(song.tracks.iter().all(|t| t.name != "Guitarras" && t.name != "Teclados"));
        assert_eq!(track_of(&song, &placements[0]).id, "own_click");
        assert_eq!(
            track_of(&song, &placements[1]).parent_track_id.as_deref(),
            Some("own_keys")
        );
        // La guitarra no tiene sitio en esta sesión: pista suelta, como siempre.
        assert!(matches!(placements[2], StemPlacement::Unmatched { .. }));
        // La pista que comparte nombre con la de serie recibe sus alias.
        let own_click = song.tracks.iter().find(|t| t.id == "own_click").unwrap();
        assert!(own_click.match_aliases.iter().any(|a| a == "metronome"));
    }

    #[test]
    fn lane_names_drop_the_shared_prefix_only_at_a_word_boundary() {
        let names =
            |list: &[&str]| lane_names(&list.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(
            names(&["Way Maker - EG 1", "Way Maker - Keys"]),
            ["EG 1", "Keys"]
        );
        assert_eq!(names(&["EG 1", "EG 2"]), ["EG 1", "EG 2"]);
        assert_eq!(names(&["Bass", "Bateria"]), ["Bass", "Bateria"]);
        assert_eq!(names(&["Solo"]), ["Solo"]);
    }
}
