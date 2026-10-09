use serde::{Deserialize, Serialize};

fn default_song_bpm() -> f64 {
    120.0
}

fn default_song_time_signature() -> String {
    "4/4".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub songs: Vec<Song>,
    pub setlists: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub key: Option<String>,
    #[serde(default = "default_song_bpm")]
    pub bpm: f64,
    #[serde(default = "default_song_time_signature")]
    pub time_signature: String,
    pub duration_seconds: f64,
    #[serde(default)]
    pub tempo_markers: Vec<TempoMarker>,
    #[serde(default)]
    pub time_signature_markers: Vec<TimeSignatureMarker>,
    #[serde(default)]
    pub regions: Vec<SongRegion>,
    pub tracks: Vec<Track>,
    pub clips: Vec<Clip>,
    /// MIDI clips, kept in a list of their own rather than mixed into `clips`:
    /// they carry messages instead of audio, and every consumer of `clips`
    /// (mixer, waveforms, warp) would have to learn to skip them. Songs saved
    /// before MIDI tracks existed deserialize to an empty list.
    #[serde(default)]
    pub midi_clips: Vec<MidiClip>,
    /// Video clips, in a list of their own for the same reason as
    /// `midi_clips`: they carry pictures, not audio, and every consumer of
    /// `clips` (mixer, waveforms, warp, render) would have to learn to skip
    /// them. Songs saved before video tracks existed deserialize to an empty
    /// list. An empty list is left out on save so a song without video stays
    /// a valid v7 document that 1.12.x opens.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub video_clips: Vec<VideoClip>,
    pub section_markers: Vec<Marker>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TempoMarker {
    pub id: String,
    pub start_seconds: f64,
    pub bpm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SongRegion {
    pub id: String,
    pub name: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    #[serde(default)]
    pub transpose_semitones: i32,
    /// The song's original musical key (e.g. `"Dm"`, `"F#"`). Pure display
    /// metadata: the effective key shown to the user is this value transposed
    /// by `transpose_semitones`. `None` when unset. Sessions saved before this
    /// field deserialize to `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// When true, every track in this region is time-stretched so the audio's
    /// original tempo (`warp_source_bpm`) aligns with the timeline's effective
    /// tempo. Pitch is preserved. Warp applies to the whole region — it is
    /// not per-track and not gated by `transpose_semitones`.
    #[serde(default)]
    pub warp_enabled: bool,
    /// BPM of the source audio at unity speed. Kept as `Option` even when
    /// warp is disabled so toggling off and back on preserves the user's
    /// configured value.
    #[serde(default)]
    pub warp_source_bpm: Option<f64>,
    #[serde(default)]
    pub master: SongMaster,
    /// Width, in rem, of this song's column in the compact view. Pure view
    /// state — it has no effect on playback, the timeline, or any export.
    /// `None` (the default, and what pre-existing sessions deserialize to)
    /// means "use the view's default width", so a project the user never
    /// resized keeps looking exactly as it did before this field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_column_width_rem: Option<f64>,
    /// Original de la canción y sus arreglos (reordenar, repetir y quitar
    /// secciones). `None` —y lo que deserializan las sesiones de antes— es una
    /// canción sin original capturado. Se omite al guardar, así que una canción
    /// sin arreglos se escribe igual que antes de que existiera el campo. Una
    /// versión vieja lo ignora y ve el timeline lineal que el arreglo escribió.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structure: Option<SongStructure>,
}

/// Original de una canción y los arreglos construidos a partir de él.
///
/// Invariante: si `applied_arrangement_id` es `Some`, el contenido de la región
/// en el timeline es exactamente `build_arrangement(original, bloques)`
/// trasladado a su inicio. Nada guarda contenido arreglado que no se pueda
/// volver a derivar del original.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SongStructure {
    /// Contenido de la canción tal como era antes de aplicar ningún arreglo,
    /// en tiempo de fuente. Ver [`OriginalSnapshot`] para el sistema de
    /// coordenadas.
    pub original: OriginalSnapshot,
    /// Secciones del original, en orden. Se derivan de las marcas de categoría
    /// Section al capturar y se guardan para no recalcularlas.
    pub sections: Vec<OriginalSection>,
    /// Arreglos guardados ("Domingo", "Versión corta"…).
    #[serde(default)]
    pub arrangements: Vec<Arrangement>,
    /// Arreglo aplicado ahora en el timeline. `None` = el timeline ES el
    /// original.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_arrangement_id: Option<String>,
}

/// Las mismas listas que `Song`, filtradas a una región, en tiempo de fuente
/// (sin warp).
///
/// **Coordenadas.** Las posiciones se guardan tal como estaban en el timeline
/// al capturar, junto con `origin_seconds` (el inicio de la región en ese
/// momento). La posición relativa de algo es `posición - origin_seconds`, y
/// colocar el original en una región que ahora empieza en `s` es sumar
/// `s - origin_seconds` a todo. Guardarlo así, y no ya restado, es lo que hace
/// exacta la identidad: si la canción no se ha movido el desplazamiento es 0
/// y cada posición vuelve bit a bit, cosa que `(x - s) + s` no garantiza en
/// coma flotante. Mover la canción no toca la instantánea.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct OriginalSnapshot {
    /// Inicio de la región cuando se capturó.
    pub origin_seconds: f64,
    /// Duración original de la región.
    pub duration_seconds: f64,
    /// Tempo que regía en el inicio de la región, venga de una marca de dentro
    /// o de fuera (la canción anterior, o el tempo base del proyecto). Con él
    /// se decide si un tramo necesita una marca de tempo de arranque.
    pub base_bpm: f64,
    /// Compás que regía en el inicio de la región, igual que `base_bpm`.
    pub base_time_signature: String,
    #[serde(default)]
    pub clips: Vec<Clip>,
    #[serde(default)]
    pub midi_clips: Vec<MidiClip>,
    #[serde(default)]
    pub video_clips: Vec<VideoClip>,
    #[serde(default)]
    pub tempo_markers: Vec<TempoMarker>,
    #[serde(default)]
    pub time_signature_markers: Vec<TimeSignatureMarker>,
    /// Todas las marcas de la región: las de sección y las de cue.
    #[serde(default)]
    pub section_markers: Vec<Marker>,
    /// Cues de automatización de la canción. Viven en el `Song` (aunque en
    /// ejecución estén en `automation.ltautomation`) para que deshacer, que
    /// sólo apila `Song`, restaure también su original. Los destinos `Frame`
    /// de sus saltos están en las mismas coordenadas que el resto.
    #[serde(default)]
    pub automation_cues: Vec<crate::automation::AutomationCue>,
}

/// Una sección del original: desde una marca de categoría Section hasta la
/// siguiente o el final de la región. Posiciones RELATIVAS al inicio de la
/// región (en fuente): la primera empieza en 0 y la última acaba en la
/// duración del original.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OriginalSection {
    /// Id de la marca que la abre, o el id estable de la sección implícita
    /// "Inicio" (ver `implicit_start_section_id`) si la primera marca no está
    /// en el inicio de la región.
    pub marker_id: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

/// Un arreglo guardado: una lista de secciones del original en el orden en
/// que deben sonar.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Arrangement {
    pub id: String,
    pub name: String,
    pub blocks: Vec<ArrangementBlock>,
}

/// Un bloque del arreglo: una aparición de una sección del original.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArrangementBlock {
    pub id: String,
    pub section_marker_id: String,
}

/// Id estable de la sección implícita "Inicio" de una región: el tramo entre
/// el inicio de la región y su primera marca de sección.
pub fn implicit_start_section_id(region_id: &str) -> String {
    format!("{region_id}~start")
}

impl SongStructure {
    pub fn applied_arrangement(&self) -> Option<&Arrangement> {
        let id = self.applied_arrangement_id.as_deref()?;
        self.arrangements.iter().find(|arrangement| arrangement.id == id)
    }

    pub fn section(&self, marker_id: &str) -> Option<&OriginalSection> {
        self.sections
            .iter()
            .find(|section| section.marker_id == marker_id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SongMaster {
    pub gain: f64,
}

impl Default for SongMaster {
    fn default() -> Self {
        Self { gain: 1.0 }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrackKind {
    Audio,
    Folder,
    /// Sends MIDI to an external device (lighting desks, lyric projection).
    /// Produces no audio, so it is filtered out before the song is handed to
    /// the native engine — unlike [`TrackKind::Folder`], which the engine does
    /// know about for gain/mute folding.
    Midi,
    /// Holds [`VideoClip`]s projected to an external display. Produces no
    /// audio, so like [`TrackKind::Midi`] it never reaches the native engine.
    /// Reuses `muted` (hidden) and `solo` (the only visible video track);
    /// volume, pan and routing do not apply.
    Video,
}

impl TrackKind {
    /// Whether tracks of this kind are handed to the native audio engine.
    /// MIDI and video tracks produce no audio and the engine has no concept of
    /// them; they are played from Rust-side runtimes instead.
    pub fn reaches_audio_engine(self) -> bool {
        matches!(self, TrackKind::Audio | TrackKind::Folder)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub name: String,
    pub kind: TrackKind,
    pub parent_track_id: Option<String>,
    pub volume: f64,
    pub pan: f64,
    pub muted: bool,
    pub solo: bool,
    #[serde(default = "default_true")]
    pub transpose_enabled: bool,
    #[serde(default = "default_audio_to", alias = "outputBusId")]
    pub audio_to: String,
    /// Sumar los dos canales de la pista a uno solo y colocarlo por el paneo,
    /// como el botón de mono de un canal de mezcla.
    ///
    /// **No toca el fichero**: es reversible y no hay nada destructivo. Por
    /// defecto `false`, así que las sesiones creadas antes de que esto
    /// existiera se abren en estéreo, que es como estaban.
    #[serde(default)]
    pub mono_downmix: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Tracks marked auto_created are removed automatically the moment they
    /// no longer hold any clip. Set when a track is conjured by a drop into
    /// the compact view's song column (one audio file → one auto track).
    /// Tracks the user created explicitly (DAW track header, library drop
    /// with a target_track_id) stay false and survive becoming empty.
    #[serde(default)]
    pub auto_created: bool,
    /// MIDI output port this track sends to, for [`TrackKind::Midi`] tracks.
    /// `None` = fall back to the app-wide output device, which is what a
    /// single-destination setup wants. Set it per track to drive two programs
    /// (say a lighting desk and lyric projection) on different ports at once.
    /// Ignored by every other track kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub midi_port: Option<String>,
    /// Channel (1-16) every message from this track uses unless the individual
    /// event overrides it. The port is the cable; the channel is which of the
    /// 16 addresses inside that cable the message is tagged with.
    #[serde(default = "default_midi_channel")]
    pub midi_channel: u8,
    /// Whether this MIDI track sends at all. This is what a MIDI track has
    /// instead of mute/solo: there is no mix to fold it into, so the only
    /// meaningful state is on or off.
    #[serde(default = "default_true")]
    pub midi_enabled: bool,
    /// Whether a [`TrackKind::Folder`] is collapsed in the arrangement view,
    /// hiding its children. Purely a view state — the engine never reads it,
    /// folding gain/mute happens regardless — but it lives on the track so it
    /// survives closing the session and travels with the .ltpkg/template,
    /// which is what users expect from a folder they collapsed. Meaningless
    /// on non-folder tracks, where it stays false.
    #[serde(default)]
    pub collapsed: bool,
    /// Extra pixels this track's arrangement row gets on top of the global
    /// track height, letting one track stay tall while the rest are collapsed.
    /// Stored as an offset rather than an absolute height so the global height
    /// control still shifts every row by the same amount and the differences
    /// the user set survive it. Like [`Track::collapsed`] this is pure view
    /// state the engine never reads, kept on the track so it survives closing
    /// the session and travels with the .ltpkg/template.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height_offset: Option<i32>,
}

pub fn default_audio_to() -> String {
    "master".to_string()
}

pub fn default_midi_channel() -> u8 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub track_id: String,
    pub file_path: String,
    pub timeline_start_seconds: f64,
    pub source_start_seconds: f64,
    pub duration_seconds: f64,
    pub gain: f64,
    pub fade_in_seconds: Option<f64>,
    pub fade_out_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// How a video frame is fitted into the output display when their aspect
/// ratios differ.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum VideoFit {
    /// Whole frame visible, black bars where the ratios differ.
    #[default]
    Contain,
    /// Fill the display, cropping what overflows.
    Cover,
    /// Fill the display, distorting the picture.
    Stretch,
}

impl VideoFit {
    pub fn as_token(self) -> &'static str {
        match self {
            VideoFit::Contain => "contain",
            VideoFit::Cover => "cover",
            VideoFit::Stretch => "stretch",
        }
    }
}

/// A window of a video file placed on a [`TrackKind::Video`] track.
///
/// Same geometry as an audio [`Clip`] — start, trim and length — so moving
/// it with its song, duplicating the song or exporting it needs no
/// conversion. The picture is played by the desktop video output, never by the
/// audio engine; the file's own soundtrack is extracted to a regular audio
/// clip if the user wants it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoClip {
    pub id: String,
    pub track_id: String,
    pub file_path: String,
    /// Position on the timeline, in the song's source seconds (the same space
    /// as [`Clip::timeline_start_seconds`], i.e. pre-warp).
    pub timeline_start_seconds: f64,
    /// Offset into the file where the visible window starts (the trim).
    pub source_start_seconds: f64,
    pub duration_seconds: f64,
    #[serde(default)]
    pub fade_in_seconds: Option<f64>,
    #[serde(default)]
    pub fade_out_seconds: Option<f64>,
    /// `None` = use the video output's global fit setting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit: Option<VideoFit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl VideoClip {
    /// Timeline position of the clip's end.
    pub fn end_seconds(&self) -> f64 {
        self.timeline_start_seconds + self.duration_seconds
    }
}

/// What the analysis of a video file found. Stored in the session library
/// (`library.json`), not in the song document: it describes the file, not how
/// the song uses it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoAssetInfo {
    pub duration_seconds: f64,
    pub width: u32,
    pub height: u32,
    /// Frames per second of the container; 0 when unknown (still images).
    pub fps: f64,
    /// Clockwise rotation from the container metadata (0, 90, 180, 270).
    #[serde(default)]
    pub rotation_degrees: u32,
    pub codec: String,
    /// Whether hardware decoding engaged for this codec on this machine.
    #[serde(default)]
    pub hardware_decode: bool,
    pub has_audio: bool,
    /// Longest gap between keyframes found by sampling, in seconds. Long gaps
    /// make seeks and jumps slow; the library warns above two seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyframe_interval_seconds: Option<f64>,
}

/// Keyframe spacing above which jumps into the video can visibly lag.
pub const SLOW_SEEK_KEYFRAME_INTERVAL_SECONDS: f64 = 2.0;

impl VideoAssetInfo {
    pub fn has_slow_seeks(&self) -> bool {
        self.keyframe_interval_seconds
            .is_some_and(|interval| interval > SLOW_SEEK_KEYFRAME_INTERVAL_SECONDS)
    }
}

/// File extensions imported as video.
pub const VIDEO_FILE_EXTENSIONS: &[&str] =
    &["mp4", "m4v", "mov", "mkv", "webm", "avi", "mpg", "mpeg"];

/// Whether `path` names a video file by its extension (case-insensitive).
pub fn is_video_file_path(path: &str) -> bool {
    path.rsplit_once('.')
        .map(|(_, extension)| {
            VIDEO_FILE_EXTENSIONS
                .iter()
                .any(|known| known.eq_ignore_ascii_case(extension))
        })
        .unwrap_or(false)
}

/// Lowest/highest valid value for a MIDI channel as the user sees it (1-16).
/// Stored 1-based to match every hardware label; the wire format's 0-based
/// nibble is produced at send time.
pub const MIN_MIDI_CHANNEL: u8 = 1;
pub const MAX_MIDI_CHANNEL: u8 = 16;
/// MIDI data bytes are 7-bit: note numbers, velocities, controllers and
/// controller values all share this ceiling.
pub const MAX_MIDI_DATA_VALUE: u8 = 127;

/// A bundle of MIDI messages anchored to one point on the timeline.
///
/// This is deliberately *not* a piano roll. LibreTracks is a multitrack
/// player, so the useful unit is "when the playhead reaches this point, fire
/// these messages" — several notes at once with their own velocities, a
/// program change, a controller sweep. Events carry no absolute time of their
/// own; they are all relative to `timeline_start_seconds`, so moving the clip
/// moves its contents with it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MidiClip {
    pub id: String,
    pub track_id: String,
    /// Position on the timeline, in the song's source seconds (the same space
    /// as [`Clip::timeline_start_seconds`], i.e. pre-warp).
    pub timeline_start_seconds: f64,
    /// Free-text label shown on the clip in the timeline.
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub events: Vec<MidiEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// One message (or sweep) inside a [`MidiClip`].
///
/// `at_seconds` is an offset from the clip's start, so the common case — a
/// chord where everything fires together — is several events all at `0.0`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MidiEvent {
    pub id: String,
    /// Offset from the clip start in seconds. `0.0` = fires with the clip.
    #[serde(default)]
    pub at_seconds: f64,
    /// Per-event channel override (1-16). `None` — the normal case — means
    /// "use the track's channel", so a track that talks to one device is
    /// configured in one place. An override exists because "everything on
    /// channel 3, but this one program change goes to 10" is a real lighting
    /// case that would otherwise need a whole extra track.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<u8>,
    pub kind: MidiEventKind,
}

/// What a [`MidiEvent`] actually sends.
///
/// Note that `Note` carries a duration rather than being split into a
/// note-on/note-off pair: the pairing is the runtime's job, which keeps the
/// editor to one row per musical intention instead of two.
// `rename_all` renames the VARIANTS; struct-variant FIELDS need
// `rename_all_fields` as well, or `durationSeconds` from the frontend fails to
// deserialize into `duration_seconds`. Same trap the AutomationActionSummary
// enum documents in models/view.rs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum MidiEventKind {
    /// A note held for `duration_seconds`, then released.
    Note {
        note: u8,
        velocity: u8,
        duration_seconds: f64,
    },
    /// A single controller value.
    ControlChange { controller: u8, value: u8 },
    /// A patch/scene recall — the usual way to drive a lighting desk.
    ProgramChange { program: u8 },
    /// A controller swept from `from_value` to `to_value` over
    /// `duration_seconds`. Interpolated at the transport's tick rate, which is
    /// ample for fades but not sample-accurate.
    ControlCurve {
        controller: u8,
        from_value: u8,
        to_value: u8,
        duration_seconds: f64,
    },
}

impl MidiEvent {
    /// The channel this event actually goes out on: its own override if set,
    /// otherwise the owning track's. Single place the fallback is decided, so
    /// playback, the editor and the timeline can never disagree about it.
    pub fn effective_channel(&self, track_channel: u8) -> u8 {
        self.channel.unwrap_or(track_channel)
    }

    /// How long this event occupies the timeline, measured from `at_seconds`.
    /// Instantaneous messages report `0.0`.
    pub fn duration_seconds(&self) -> f64 {
        match self.kind {
            MidiEventKind::Note {
                duration_seconds, ..
            }
            | MidiEventKind::ControlCurve {
                duration_seconds, ..
            } => duration_seconds.max(0.0),
            MidiEventKind::ControlChange { .. } | MidiEventKind::ProgramChange { .. } => 0.0,
        }
    }
}

impl MidiClip {
    /// The clip's extent: from its start to the end of its longest event. A
    /// clip of instantaneous messages has zero duration, which is intentional —
    /// it renders as a marker rather than a block.
    pub fn duration_seconds(&self) -> f64 {
        self.events
            .iter()
            .map(|event| event.at_seconds.max(0.0) + event.duration_seconds())
            .fold(0.0, f64::max)
    }

    /// Timeline position of the clip's end.
    pub fn end_seconds(&self) -> f64 {
        self.timeline_start_seconds + self.duration_seconds()
    }
}

/// Semantic type of a section marker. Drives the pre-recorded voice-guide clip
/// and the marker's colour/icon in the timeline. `name` remains the free-text
/// label shown to the user; `kind` is the closed vocabulary the voice bank and
/// UI key off. Sessions saved before the voice-guide feature lack this field and
/// deserialize to [`MarkerKind::Custom`] via `#[serde(default)]`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum MarkerKind {
    Intro,
    Verse,
    PreChorus,
    Chorus,
    PostChorus,
    Bridge,
    Breakdown,
    Drop,
    Solo,
    Outro,
    // Extended vocabulary covered by the bundled voice pack (worship/band
    // arrangements). Append new variants at the end — the C++ engine indexes
    // its clip bank by this enum's integer value, so order is part of the ABI.
    Acapella,
    Instrumental,
    Interlude,
    Refrain,
    Tag,
    Vamp,
    Ending,
    Exhortation,
    Rap,
    Turnaround,
    // Dynamic guide cues (worship/band arrangements): short spoken instructions
    // that happen *within* a section rather than marking one — "Build", "All In",
    // "Drums In", "Key Change Up". Unlike sections they are not counted in; they
    // fire as one-shots (chained into a nearby section's lead-in when close, see
    // the voice-guide renderer). Appended after the section kinds — same ABI rule
    // (the C++ clip bank indexes by this integer): append before Custom only.
    AdLib,
    AllIn,
    Bass,
    BigEnding,
    Break,
    Build,
    DrumsIn,
    Drums,
    Guitar,
    Hits,
    Hold,
    KeyChangeDown,
    KeyChangeUp,
    Keys,
    LastTime,
    SlowlyBuild,
    Softly,
    Swell,
    WorshipFreely,
    // Appended after the first cue block — the ABI rule above still applies, so
    // these sit here rather than in alphabetical or category order. `NextSong`
    // is a *section* despite its position among cues; see `category`.
    EaseDown,
    GetReady,
    NextSong,
    // Instrument solos: sections (count-in like any other), appended per the
    // ABI rule. Their clips are the pack's own "Solo" + instrument cue joined
    // (scripts/voice-guide/make-instrument-solo-clips.mjs).
    DrumSolo,
    BassSolo,
    GuitarSolo,
    /// User-defined section with no pre-recorded voice clip; the announcement
    /// falls back to silence (or TTS, if added later).
    #[default]
    Custom,
}

/// Whether a [`MarkerKind`] marks a song *section* (Verse, Chorus — announced
/// with a name + rhythmic count-in) or is a dynamic *cue* (Build, All In — a
/// one-shot spoken instruction within a section, no count-in). Derived from the
/// kind, never stored: a kind belongs to exactly one category, so there is no
/// such thing as an invalid combination.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MarkerCategory {
    Section,
    Cue,
}

impl MarkerKind {
    /// The serialized snake_case token (matching the serde representation), used
    /// when sending markers to the audio engine over the command channel.
    pub fn as_token(self) -> &'static str {
        match self {
            MarkerKind::Intro => "intro",
            MarkerKind::Verse => "verse",
            MarkerKind::PreChorus => "pre_chorus",
            MarkerKind::Chorus => "chorus",
            MarkerKind::PostChorus => "post_chorus",
            MarkerKind::Bridge => "bridge",
            MarkerKind::Breakdown => "breakdown",
            MarkerKind::Drop => "drop",
            MarkerKind::Solo => "solo",
            MarkerKind::Outro => "outro",
            MarkerKind::Acapella => "acapella",
            MarkerKind::Instrumental => "instrumental",
            MarkerKind::Interlude => "interlude",
            MarkerKind::Refrain => "refrain",
            MarkerKind::Tag => "tag",
            MarkerKind::Vamp => "vamp",
            MarkerKind::Ending => "ending",
            MarkerKind::Exhortation => "exhortation",
            MarkerKind::Rap => "rap",
            MarkerKind::Turnaround => "turnaround",
            MarkerKind::AdLib => "ad_lib",
            MarkerKind::AllIn => "all_in",
            MarkerKind::Bass => "bass",
            MarkerKind::BigEnding => "big_ending",
            MarkerKind::Break => "break",
            MarkerKind::Build => "build",
            MarkerKind::DrumsIn => "drums_in",
            MarkerKind::Drums => "drums",
            MarkerKind::Guitar => "guitar",
            MarkerKind::Hits => "hits",
            MarkerKind::Hold => "hold",
            MarkerKind::KeyChangeDown => "key_change_down",
            MarkerKind::KeyChangeUp => "key_change_up",
            MarkerKind::Keys => "keys",
            MarkerKind::LastTime => "last_time",
            MarkerKind::SlowlyBuild => "slowly_build",
            MarkerKind::Softly => "softly",
            MarkerKind::Swell => "swell",
            MarkerKind::WorshipFreely => "worship_freely",
            MarkerKind::EaseDown => "ease_down",
            MarkerKind::GetReady => "get_ready",
            MarkerKind::NextSong => "next_song",
            MarkerKind::DrumSolo => "drum_solo",
            MarkerKind::BassSolo => "bass_solo",
            MarkerKind::GuitarSolo => "guitar_solo",
            MarkerKind::Custom => "custom",
        }
    }

    /// Whether this kind is a song section or a dynamic cue. Drives voice-guide
    /// behaviour (sections get a name + count-in; cues are one-shots) and the
    /// UI grouping. Custom counts as a section (it is an untyped section marker).
    pub fn category(self) -> MarkerCategory {
        match self {
            MarkerKind::AdLib
            | MarkerKind::AllIn
            | MarkerKind::Bass
            | MarkerKind::BigEnding
            | MarkerKind::Break
            | MarkerKind::Build
            | MarkerKind::DrumsIn
            | MarkerKind::Drums
            | MarkerKind::Guitar
            | MarkerKind::Hits
            | MarkerKind::Hold
            | MarkerKind::KeyChangeDown
            | MarkerKind::KeyChangeUp
            | MarkerKind::Keys
            | MarkerKind::LastTime
            | MarkerKind::SlowlyBuild
            | MarkerKind::Softly
            | MarkerKind::Swell
            | MarkerKind::WorshipFreely
            | MarkerKind::EaseDown
            | MarkerKind::GetReady => MarkerCategory::Cue,
            // NextSong falls through: it is announced with a count-in like a
            // section, not fired as a one-shot.
            _ => MarkerCategory::Section,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: String,
    pub name: String,
    pub start_seconds: f64,
    pub digit: Option<u8>,
    #[serde(default)]
    pub kind: MarkerKind,
    /// Numbered variant of the section (e.g. Verse 2, Chorus 3). `None` is the
    /// unnumbered base section. The voice bank plays `<kind>_<variant>.wav` when
    /// present, falling back to the base `<kind>.wav`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<u8>,
    /// Optional user-chosen colour (CSS string) overriding the kind's default
    /// colour. Mainly for Custom markers, which have no semantic kind colour, but
    /// allowed on any marker. `None` falls back to the kind palette.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Lane the user dragged this marker into, overriding the category its
    /// [`MarkerKind`] implies. `None` — the default, and what every session
    /// saved before this feature deserializes to — means "wherever my kind
    /// belongs", so markers still land in their natural lane out of the box.
    ///
    /// This is the one place category is *stored* rather than derived: it lets a
    /// Chorus be announced as a one-shot cue, or a Build get a count-in, without
    /// changing its kind (and therefore its name, colour and voice clip). Read
    /// it through [`Marker::category`], never directly, so the fallback to the
    /// kind stays in one place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_override: Option<MarkerCategory>,
}

impl Marker {
    /// The category that actually governs this marker: the lane the user dragged
    /// it into, or the one its kind implies. Everything that branches on
    /// section-vs-cue (voice-guide count-in, jump targets, ruler lane, ordering)
    /// must go through here rather than calling `kind.category()`, or a dragged
    /// marker behaves like its old category.
    pub fn category(&self) -> MarkerCategory {
        self.category_override
            .unwrap_or_else(|| self.kind.category())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TempoSource {
    #[default]
    Manual,
    AutoImport,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TempoMetadata {
    #[serde(default)]
    pub source: TempoSource,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub reference_file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimeSignatureMarker {
    pub id: String,
    pub start_seconds: f64,
    pub signature: String,
}

pub fn parse_audio_output_route(audio_to: &str, available_channels: usize) -> Vec<usize> {
    let channel_count = available_channels.max(1);
    let normalized = audio_to.trim().to_ascii_lowercase();

    match normalized.as_str() {
        "" | "master" | "main" => return stereo_pair(0, channel_count),
        "monitor" => {
            return if channel_count >= 4 {
                stereo_pair(2, channel_count)
            } else {
                stereo_pair(0, channel_count)
            };
        }
        _ => {}
    }

    if let Some(explicit) = parse_external_output_channels(&normalized, channel_count) {
        return explicit;
    }

    stereo_pair(0, channel_count)
}

fn parse_external_output_channels(
    normalized_audio_to: &str,
    available_channels: usize,
) -> Option<Vec<usize>> {
    let mut value = normalized_audio_to
        .trim_start_matches("ext:")
        .trim_start_matches("hardware:")
        .trim()
        .to_string();
    if let Some(stripped) = value.strip_prefix("out ") {
        value = stripped.trim().to_string();
    }
    if let Some(stripped) = value.strip_prefix("out_") {
        value = stripped.trim().to_string();
    }
    if let Some(stripped) = value.strip_prefix("out") {
        value = stripped.trim().to_string();
    }

    if let Some((start, end)) = value.split_once('-') {
        let start = start.trim().parse::<usize>().ok()?;
        let end = end.trim().parse::<usize>().ok()?;
        if end < start || (!normalized_audio_to.starts_with("ext:") && (start == 0 || end == 0)) {
            return None;
        }

        let mut channels = Vec::new();
        for channel in start..=end {
            let zero_based = if normalized_audio_to.starts_with("ext:") {
                channel
            } else {
                channel - 1
            };
            if zero_based < available_channels {
                channels.push(zero_based);
            }
        }
        return (!channels.is_empty()).then_some(channels);
    }

    let channel = value.parse::<usize>().ok()?;
    if channel == 0 && !normalized_audio_to.starts_with("ext:") {
        return None;
    }
    let zero_based = if normalized_audio_to.starts_with("ext:") {
        channel
    } else {
        channel - 1
    };
    (zero_based < available_channels).then_some(vec![zero_based])
}

fn stereo_pair(start_channel: usize, available_channels: usize) -> Vec<usize> {
    let first = start_channel.min(available_channels.saturating_sub(1));
    let second = (first + 1).min(available_channels.saturating_sub(1));
    if first == second {
        vec![first]
    } else {
        vec![first, second]
    }
}

impl Song {
    /// La instantánea del original de cada canción que tenga una. Quien
    /// reescriba clips en todo el `Song` (rutas de audio al importar o
    /// reenlazar, pistas al importar un paquete) tiene que pasar también por
    /// aquí: la instantánea guarda sus propios clips, y si se queda atrás, al
    /// volver al original o reaplicar un arreglo el clip apuntaría a un fichero
    /// o a una pista que ya no existen.
    pub fn structure_snapshots_mut(&mut self) -> impl Iterator<Item = &mut OriginalSnapshot> {
        self.regions
            .iter_mut()
            .filter_map(|region| region.structure.as_mut())
            .map(|structure| &mut structure.original)
    }

    pub fn sorted_markers(&self) -> Vec<&Marker> {
        let mut markers = self.section_markers.iter().collect::<Vec<_>>();
        markers.sort_by(|left, right| {
            left.start_seconds
                .partial_cmp(&right.start_seconds)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        markers
    }

    pub fn marker_by_id(&self, marker_id: &str) -> Option<&Marker> {
        self.section_markers
            .iter()
            .find(|marker| marker.id == marker_id)
    }

    pub fn marker_by_digit(&self, digit: u8) -> Option<&Marker> {
        self.section_markers
            .iter()
            .find(|marker| marker.digit == Some(digit))
    }

    pub fn marker_at(&self, position_seconds: f64) -> Option<Marker> {
        if position_seconds < 0.0 {
            return None;
        }

        self.sorted_markers()
            .into_iter()
            .rev()
            .find(|marker| marker.start_seconds <= position_seconds)
            .cloned()
    }

    pub fn next_marker_after(&self, position_seconds: f64) -> Option<Marker> {
        self.sorted_markers()
            .into_iter()
            .find(|marker| marker.start_seconds > position_seconds)
            .cloned()
    }

    pub fn next_marker_name(&self) -> String {
        format!("Marker {}", self.section_markers.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker(id: &str, start_seconds: f64, digit: Option<u8>) -> Marker {
        Marker {
            id: id.into(),
            name: id.into(),
            start_seconds,
            digit,
            kind: MarkerKind::Custom,
            variant: None,
            color: None,
            category_override: None,
        }
    }

    fn song_with_markers(markers: Vec<Marker>) -> Song {
        Song {
            id: "s".into(),
            title: "S".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 100.0,
            tempo_markers: vec![],
            time_signature_markers: vec![],
            regions: vec![],
            tracks: vec![],
            clips: vec![],
            midi_clips: vec![],
            video_clips: vec![],
            section_markers: markers,
        }
    }

    // ── parse_audio_output_route ──────────────────────────────────────────

    #[test]
    fn route_master_and_aliases_map_to_the_first_stereo_pair() {
        for route in ["", "master", "main", "MASTER", "  Main  "] {
            assert_eq!(parse_audio_output_route(route, 8), vec![0, 1], "{route:?}");
        }
    }

    #[test]
    fn route_monitor_uses_channels_3_4_when_available() {
        assert_eq!(parse_audio_output_route("monitor", 8), vec![2, 3]);
    }

    #[test]
    fn route_monitor_falls_back_to_main_on_stereo_devices() {
        assert_eq!(parse_audio_output_route("monitor", 2), vec![0, 1]);
    }

    #[test]
    fn route_ext_is_zero_based() {
        assert_eq!(parse_audio_output_route("ext:0", 8), vec![0]);
        assert_eq!(parse_audio_output_route("ext:2-3", 8), vec![2, 3]);
    }

    #[test]
    fn route_hardware_out_is_one_based() {
        // "out 1" addresses the first physical output -> zero-based channel 0.
        assert_eq!(parse_audio_output_route("out 1", 8), vec![0]);
        assert_eq!(parse_audio_output_route("out 3-4", 8), vec![2, 3]);
    }

    #[test]
    fn route_drops_channels_beyond_the_device_channel_count() {
        // ext:6-7 on a 2-channel device yields nothing valid -> master fallback.
        assert_eq!(parse_audio_output_route("ext:6-7", 2), vec![0, 1]);
    }

    #[test]
    fn route_one_based_zero_is_invalid_and_falls_back() {
        // "out 0" is not a valid 1-based channel -> master fallback.
        assert_eq!(parse_audio_output_route("out 0", 8), vec![0, 1]);
    }

    #[test]
    fn route_unparseable_falls_back_to_master() {
        assert_eq!(parse_audio_output_route("garbage", 8), vec![0, 1]);
    }

    #[test]
    fn route_clamps_to_a_single_channel_on_mono_devices() {
        assert_eq!(parse_audio_output_route("master", 1), vec![0]);
    }

    // ── Song marker lookups ───────────────────────────────────────────────

    #[test]
    fn marker_by_id_and_digit_find_the_right_marker() {
        let song = song_with_markers(vec![marker("a", 0.0, Some(1)), marker("b", 10.0, Some(2))]);
        assert_eq!(song.marker_by_id("b").unwrap().start_seconds, 10.0);
        assert!(song.marker_by_id("missing").is_none());
        assert_eq!(song.marker_by_digit(2).unwrap().id, "b");
        assert!(song.marker_by_digit(9).is_none());
    }

    #[test]
    fn next_marker_after_returns_the_first_marker_strictly_ahead() {
        let song = song_with_markers(vec![marker("b", 20.0, None), marker("a", 10.0, None)]);
        // Sorted internally; from 5s the next is "a" at 10s.
        assert_eq!(song.next_marker_after(5.0).unwrap().id, "a");
        // Exactly on a marker is not "after" it.
        assert_eq!(song.next_marker_after(10.0).unwrap().id, "b");
        assert!(song.next_marker_after(20.0).is_none());
    }

    #[test]
    fn marker_at_returns_none_for_negative_positions() {
        let song = song_with_markers(vec![marker("a", 0.0, None)]);
        assert!(song.marker_at(-1.0).is_none());
    }

    #[test]
    fn next_marker_name_counts_existing_markers() {
        let song = song_with_markers(vec![marker("a", 0.0, None)]);
        assert_eq!(song.next_marker_name(), "Marker 1");
    }

    // ── MarkerKind migration ──────────────────────────────────────────────

    #[test]
    fn marker_without_kind_field_deserializes_to_custom() {
        // Sessions saved before the voice-guide feature carry no `kind`. They
        // must keep loading, defaulting to Custom and preserving their name.
        let legacy = r#"{
            "id": "section_intro",
            "name": "Mi sección rara",
            "startSeconds": 4.0,
            "digit": 2
        }"#;
        let marker: Marker = serde_json::from_str(legacy).expect("legacy marker must load");
        assert_eq!(marker.kind, MarkerKind::Custom);
        assert_eq!(marker.name, "Mi sección rara");
        assert_eq!(marker.digit, Some(2));
    }

    #[test]
    fn marker_kind_round_trips_through_json() {
        let marker = Marker {
            id: "section_chorus".into(),
            name: "Coro final".into(),
            start_seconds: 32.0,
            digit: Some(3),
            kind: MarkerKind::Chorus,
            variant: None,
            color: None,
            category_override: None,
        };
        let json = serde_json::to_string(&marker).expect("serialize");
        // Enum serializes snake_case to match the camelCase session schema style.
        assert!(json.contains("\"kind\":\"chorus\""), "got: {json}");
        let back: Marker = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, marker);
    }

    #[test]
    fn pre_chorus_kind_uses_snake_case_token() {
        let marker = Marker {
            id: "m".into(),
            name: "PC".into(),
            start_seconds: 0.0,
            digit: None,
            kind: MarkerKind::PreChorus,
            variant: None,
            color: None,
            category_override: None,
        };
        let json = serde_json::to_string(&marker).expect("serialize");
        assert!(json.contains("\"kind\":\"pre_chorus\""), "got: {json}");
    }

    #[test]
    fn marker_category_falls_back_to_the_kind() {
        let mut marker = marker("m", 0.0, None);
        marker.kind = MarkerKind::Chorus;
        assert_eq!(marker.category(), MarkerCategory::Section);

        marker.kind = MarkerKind::Build;
        assert_eq!(marker.category(), MarkerCategory::Cue);
    }

    #[test]
    fn stored_category_override_wins_over_the_kind() {
        // Dragging a marker to the other ruler row is what writes this: the
        // kind (and so the spoken word) stays, the announcement style flips.
        let mut marker = marker("m", 0.0, None);
        marker.kind = MarkerKind::Chorus;
        marker.category_override = Some(MarkerCategory::Cue);
        assert_eq!(marker.category(), MarkerCategory::Cue);

        marker.kind = MarkerKind::Build;
        marker.category_override = Some(MarkerCategory::Section);
        assert_eq!(marker.category(), MarkerCategory::Section);
    }

    #[test]
    fn sessions_without_a_category_override_still_load() {
        // Every session saved before draggable lanes lacks the field; it must
        // deserialize to "no override" rather than failing the whole load.
        let legacy = r#"{
            "id": "m1",
            "name": "Coro",
            "startSeconds": 4.0,
            "digit": null,
            "kind": "chorus"
        }"#;
        let marker: Marker = serde_json::from_str(legacy).expect("legacy load");
        assert_eq!(marker.category_override, None);
        assert_eq!(marker.category(), MarkerCategory::Section);
    }

    #[test]
    fn category_override_round_trips_through_json() {
        let mut marker = marker("m", 0.0, None);
        marker.kind = MarkerKind::Chorus;
        marker.category_override = Some(MarkerCategory::Cue);

        let json = serde_json::to_string(&marker).expect("serialize");
        assert!(json.contains("\"categoryOverride\":\"cue\""), "got: {json}");
        let back: Marker = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, marker);
    }
}

#[cfg(test)]
mod video_media_tests {
    use super::*;

    #[test]
    fn video_extensions_are_recognised_case_insensitively() {
        for path in ["a.mp4", "C:/x/B.MOV", "clip.WebM", "old.mpeg", "x.m4v"] {
            assert!(is_video_file_path(path), "{path}");
        }
        for path in ["a.wav", "a.mp3", "mp4", "folder.mp4/file", "a.flac"] {
            assert!(!is_video_file_path(path), "{path}");
        }
    }

    #[test]
    fn long_keyframe_gaps_are_flagged() {
        let mut info = VideoAssetInfo {
            duration_seconds: 60.0,
            width: 1920,
            height: 1080,
            fps: 30.0,
            rotation_degrees: 0,
            codec: "h264".into(),
            hardware_decode: true,
            has_audio: false,
            keyframe_interval_seconds: Some(10.0),
        };
        assert!(info.has_slow_seeks());
        info.keyframe_interval_seconds = Some(1.0);
        assert!(!info.has_slow_seeks());
        info.keyframe_interval_seconds = None;
        assert!(!info.has_slow_seeks());
    }
}
