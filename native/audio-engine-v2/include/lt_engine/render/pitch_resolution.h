#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/session/session.h>

namespace lt {

constexpr Semitones kMinSupportedPitchSemitones = -12;
constexpr Semitones kMaxSupportedPitchSemitones = 12;

Semitones clamp_supported_semitones(Semitones semitones) noexcept;
Semitones resolve_region_transpose(const Song& song, Frame timeline_frame) noexcept;
Semitones resolve_effective_semitones(const Track& track,
                                      const Clip& clip,
                                      const Song& song,
                                      Frame timeline_frame) noexcept;

// Which DSP path the renderer should use for a given clip in a given block.
// Selection follows the Ableton-style semantics:
//   Direct    → warp off, pitch 0 (or track is NeverTranspose). Copy source.
//   Varispeed → warp off, pitch != 0. Linear-interpolated resample changes
//               pitch AND duration (no time-stretch). Cheap, no Bungee voice.
//   Stretched → warp on (with or without pitch). Bungee handles pitch + warp
//               in a single grain pipeline via render_block's pitch_scale +
//               time_ratio parameters; duration is determined by warp ratio,
//               not by pitch.
enum class ClipPathKind {
    Direct,
    Varispeed,
    Stretched,
};

// Canonical pitch + warp resolution decision — call once per clip per render
// block. Encodes which DSP path the renderer should run and the parameters
// it needs. `path` is the source of truth; the other fields are populated
// for paths that consume them (effective_semitones / pitch scale,
// warp_time_ratio / Bungee stream speed).
struct PitchRenderDecision {
    Semitones    effective_semitones = 0;
    bool         needs_pitch = false;       // legacy: same as effective_semitones != 0
    bool         is_never_transpose = false;
    bool         warp_active = false;       // legacy: same as warp_time_ratio != 1.0
    double       warp_time_ratio = 1.0;
    // Frequency scale 2^(effective_semitones/12). Always set; the renderer
    // uses it for both Varispeed (resample by this factor) and Stretched
    // (Bungee pitch_scale parameter).
    double       pitch_scale = 1.0;
    ClipPathKind path = ClipPathKind::Direct;
};

// Returns the authoritative pitch decision for a clip at a given timeline position.
// Use this everywhere instead of calling resolve_effective_semitones directly so that
// TrackRenderer, Mixer, and RealtimePitchEngine always agree on the semitone key.
PitchRenderDecision resolve_pitch_render_decision(
    const Track& track, const Clip& clip, const Song& song, Frame timeline_frame) noexcept;

// ── Warp neutro ─────────────────────────────────────────────────────────────
//
// Un warp con ratio 1.0 y sin transposición es la identidad: Bungee analiza y
// resintetiza para devolver exactamente lo que entró, a ~1 % del presupuesto
// del callback POR PISTA. Medido: a nivel de motor entero, 24 pistas pasan de
// 0,9 % a 37,6 % con warp, y el ratio no cambia ese coste (ratio 1.0 y 1.2
// miden igual). Ver el hecho 2 de
// docs/plans/audio-thread-parallelism/00-DIAGNOSTICO.md.
//
// La decisión puede tomarse una vez, no por bloque: resolve_warp_time_ratio()
// toma el BPM objetivo en el frame de INICIO de la región, así que el ratio de
// una región es constante mientras dure.
//
// Tolerancia: comparación EXACTA con 1.0. Un ratio de 1,000001 no es neutro —
// en una canción de cinco minutos son ~14 ms de deriva contra el clic, que sí
// se oye. Cualquier tolerancia que se eligiera aquí habría que justificarla
// contra esa deriva acumulada, y no hay ningún valor que lo consiga mejor que
// la igualdad: los ratios los produce una división de dobles que da exactamente
// 1.0 cuando los dos BPM coinciden.
constexpr double kNeutralWarpRatio = 1.0;

// True cuando el clip está en una región con warp cuya combinación de ratio y
// transposición hace que Bungee no cambie nada.
//
// ESTA FUNCIÓN ES LA ÚNICA VERDAD. La consultan resolve_pitch_render_decision
// (para elegir camino) y enumerate_voices (para decidir si enrola voz). Si las
// dos no coinciden, la pista enmudece: render_path_stretched devuelve silencio
// cuando no encuentra voz. Ver project_region_parsers_must_mirror — en este
// repo ya hubo un bug por tener la misma regla escrita en dos sitios.
bool is_neutral_warp(const Track& track,
                     const Clip& clip,
                     const Song& song,
                     Frame timeline_frame) noexcept;

// Compute the time_ratio Bungee should use for a clip at `timeline_frame`
// based on the region's warp settings and the song's effective tempo at the
// region start. Returns 1.0 (= no warp) when warp is disabled, when the
// source BPM is missing/invalid, or when no region covers `timeline_frame`.
double resolve_warp_time_ratio(const Song& song, Frame timeline_frame) noexcept;

// First region in `song` whose [start_frame, end_frame) contains `frame`,
// or nullptr if no region covers it. Linear scan — regions are typically a
// handful per song. Used by the voice manager to find every clip that needs
// a Bungee voice prepared because it sits inside the same warp-active
// region as the playhead.
const Region* region_at_frame(const Song& song, Frame frame) noexcept;

} // namespace lt
