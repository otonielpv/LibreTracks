#pragma once

// La rejilla de tiempos de una canción: compás, tempo (con rampas) y dónde
// empieza cada tramo de rejilla. La comparten el metrónomo y el renderer de
// loops de batería (plan drum-loops) para que un loop caiga al frame exacto
// de cada clic. Sin reservas de memoria: barridos lineales de las marcas de la
// canción, como ya hacía el metrónomo por frame.

#include <lt_engine/core/types.h>
#include <lt_engine/session/session.h>
#include <lt_engine/session/tempo_ramp.h>

#include <cmath>
#include <cstdint>
#include <utility>

namespace lt {

inline std::pair<int, int> signature_at(const Song* song, Frame frame) noexcept {
    if (!song) return {4, 4};
    int beats = std::max(1, song->beats_per_bar);
    int unit = std::max(1, song->beat_unit);
    for (const auto& marker : song->time_signature_markers) {
        if (marker.frame > frame) break;
        beats = std::max(1, marker.beats_per_bar);
        unit = std::max(1, marker.beat_unit);
    }
    return {beats, unit};
}

inline double bpm_at(const Song* song, Frame frame) noexcept {
    if (!song) return 120.0;
    // Dentro de una rampa, el tempo alcanzado en este frame.
    return tempo_span_at(song, frame).bpm_at(static_cast<double>(frame));
}

// Inicio del tramo de rejilla que rige en `frame`: la última marca de tempo o
// de compás, o el inicio de la canción. Es un inicio de compás.
inline Frame timing_segment_start(const Song* song, Frame frame) noexcept {
    if (!song) return 0;
    Frame start = song->start_frame;
    for (const auto& marker : song->tempo_markers) {
        if (marker.frame > frame) break;
        start = std::max(song->start_frame, marker.frame);
    }
    for (const auto& marker : song->time_signature_markers) {
        if (marker.frame > frame) break;
        start = std::max(start, marker.frame);
    }
    return start;
}

// Where the next grid starts after `frame`: a tempo or time signature marker
// of the song, or the next song (`next_song_start`, -1 for none). -1 when
// nothing follows.
inline Frame next_grid_start(const Song* song, Frame frame, Frame next_song_start) noexcept {
    Frame next = next_song_start > frame ? next_song_start : -1;
    if (!song) return next;
    const auto earlier = [&](Frame candidate) {
        if (candidate > frame && (next < 0 || candidate < next)) next = candidate;
    };
    for (const auto& marker : song->tempo_markers) {
        if (marker.frame > frame) {
            earlier(marker.frame);
            break;
        }
    }
    for (const auto& marker : song->time_signature_markers) {
        if (marker.frame > frame) {
            earlier(marker.frame);
            break;
        }
    }
    return next;
}

// A click this close to where the next grid starts (as a share of the space
// between its clicks) is not played: that grid's own downbeat follows at
// once. A change of song or tempo a few ms off the old grid ("Digno de
// adorar" at 71 after 65, 3.5 ms past a beat of the 65) sounded as a double
// click.
constexpr double kClickBeforeGridShare = 0.25;

inline bool lands_on_next_grid(Frame click_frame, double spacing_frames, Frame next_grid) noexcept {
    return next_grid > click_frame
        && static_cast<double>(next_grid - click_frame) < kClickBeforeGridShare * spacing_frames;
}

// The song whose timing map drives the click. Like the ambient pad, the
// metronome must sound whether or not there is audio under the playhead: an
// empty song (no clips) collapses to end_frame == start_frame and would cover
// no frame at all, and the playhead can also sit past the last song's end.
// Timing (bpm / signature / tempo map) exists independently of audio content,
// so when no song covers the frame we fall back to the nearest one — the last
// song starting at or before the playhead, else the first song. Only a session
// with no songs at all leaves the click without a timing map.
inline const Song* active_song(const Session* session, Frame frame) noexcept {
    if (!session || session->songs.empty()) return nullptr;
    const Song* fallback = &session->songs.front();
    for (const auto& song : session->songs) {
        if (frame >= song.start_frame && frame < song.end_frame)
            return &song;
        if (song.start_frame <= frame && song.start_frame >= fallback->start_frame)
            fallback = &song;
    }
    return fallback;
}

// Inicio de la canción que sigue a `song` en la sesión, o -1.
inline Frame next_song_start_after(const Session* session, const Song* song) noexcept {
    Frame next = -1;
    if (!session || !song) return next;
    for (const auto& other : session->songs) {
        if (other.start_frame > song->start_frame && (next < 0 || other.start_frame < next))
            next = other.start_frame;
    }
    return next;
}

inline Frame rounded_beat_frame(Frame segment_start, double beat_frames, int64_t beat_index) noexcept {
    return segment_start + static_cast<Frame>(std::llround(static_cast<double>(beat_index) * beat_frames));
}

// ---------------------------------------------------------------------------
// Tramo de rejilla: la información constante entre dos marcas para colocar
// tiempos fraccionarios (pasos de un loop) con el MISMO redondeo que los
// clics del metrónomo: en un tiempo entero, `frame_of_beat` da exactamente el
// frame del clic.
// ---------------------------------------------------------------------------
struct GridSegment {
    const Song* song = nullptr;
    Frame start = 0;               // inicio de compás del tramo
    TempoSpan tempo;
    int beats_per_bar = 4;
    int beat_unit = 4;
    double beat_frames = 0.0;      // tempo constante: frames por tiempo
    Frame next_grid = -1;          // dónde empieza el siguiente tramo (-1: nunca)

    bool valid() const noexcept { return song && std::isfinite(beat_frames) && beat_frames >= 1.0; }
    double quarters_per_beat() const noexcept { return 4.0 / static_cast<double>(beat_unit); }

    // Tiempos desde el inicio del tramo hasta `frame` (negativo antes).
    double beats_at(Frame frame, double sample_rate) const noexcept {
        if (tempo.is_ramp()) {
            return tempo.quarters_between(static_cast<double>(start), static_cast<double>(frame),
                                          sample_rate)
                 / quarters_per_beat();
        }
        return static_cast<double>(frame - start) / beat_frames;
    }

    Frame frame_of_beat(double beat, double sample_rate) const noexcept {
        if (tempo.is_ramp()) {
            return static_cast<Frame>(std::llround(
                tempo.frame_after(static_cast<double>(start), beat * quarters_per_beat(), sample_rate)));
        }
        return start + static_cast<Frame>(std::llround(beat * beat_frames));
    }

    // Frames entre dos tiempos alrededor de `beat` (para la regla de
    // lands_on_next_grid).
    double frames_per_beat_near(double beat, double sample_rate) const noexcept {
        if (!tempo.is_ramp()) return beat_frames;
        const double frame = tempo.frame_after(static_cast<double>(start), beat * quarters_per_beat(),
                                               sample_rate);
        return sample_rate * 60.0 / tempo.bpm_at(frame) * quarters_per_beat();
    }
};

inline GridSegment grid_segment_at(const Song* song, Frame frame, double sample_rate,
                                   Frame next_song_start) noexcept {
    GridSegment g;
    g.song = song;
    if (!song || sample_rate <= 0.0) return g;
    g.start = timing_segment_start(song, frame);
    g.tempo = tempo_span_at(song, frame);
    const auto [beats, unit] = signature_at(song, frame);
    g.beats_per_bar = beats;
    g.beat_unit = unit;
    // Igual que el metrónomo: el tempo en el frame consultado. Fuera de una
    // rampa es constante en todo el tramo.
    const double bpm = g.tempo.bpm_at(static_cast<double>(frame));
    g.beat_frames = sample_rate * 60.0 / bpm * (4.0 / static_cast<double>(unit));
    g.next_grid = next_grid_start(song, frame, next_song_start);
    return g;
}

} // namespace lt
