#pragma once

// ---------------------------------------------------------------------------
// Modo de canal de una pista (como el Utility de Ableton)
//
// Como coloca la pista los dos canales de su fuente ANTES del paneo y la
// ganancia. Una fuente MONO ya llega duplicada a los dos lados desde el
// renderer de clips (TrackRenderer / decode_window), asi que Left/Right sobre
// ella no cambian nada. Una ESTEREO se respeta tal cual en Stereo aunque un
// lado venga en silencio.
//
//   Stereo  l, r
//   Mono    (l + r) / 2 por los dos lados (no satura y deja una senal
//           correlacionada al mismo nivel)
//   Left    l por los dos lados, sin compensar ganancia
//   Right   r por los dos lados, sin compensar ganancia
//
// Lo comparten la mezcla en directo, el medidor de pista y el render offline,
// para que los tres suenen y midan exactamente lo mismo.
// ---------------------------------------------------------------------------

#include <cstdint>
#include <string>

namespace lt {

enum class TrackChannelMode : std::uint8_t { Stereo = 0, Mono, Left, Right };

// Token del formato de sesion y de los comandos ("stereo" | "mono" | "left" |
// "right"). Un token desconocido o vacio devuelve `fallback`.
inline TrackChannelMode parse_track_channel_mode(const std::string& token,
                                                 TrackChannelMode fallback) noexcept {
    if (token == "stereo") return TrackChannelMode::Stereo;
    if (token == "mono") return TrackChannelMode::Mono;
    if (token == "left") return TrackChannelMode::Left;
    if (token == "right") return TrackChannelMode::Right;
    return fallback;
}

inline const char* track_channel_mode_str(TrackChannelMode mode) noexcept {
    switch (mode) {
        case TrackChannelMode::Mono: return "mono";
        case TrackChannelMode::Left: return "left";
        case TrackChannelMode::Right: return "right";
        case TrackChannelMode::Stereo: break;
    }
    return "stereo";
}

// Una muestra. El modo es constante en el bloque, asi que la rama es
// perfectamente predecible (y el compilador puede sacarla del bucle).
inline void place_track_source(TrackChannelMode mode, float& l, float& r) noexcept {
    switch (mode) {
        case TrackChannelMode::Stereo: return;
        case TrackChannelMode::Mono: {
            const float summed = 0.5f * (l + r);
            l = summed;
            r = summed;
            return;
        }
        case TrackChannelMode::Left: r = l; return;
        case TrackChannelMode::Right: l = r; return;
    }
}

// Un bloque entero, en sitio, con el modo resuelto una sola vez.
inline void place_track_source_block(TrackChannelMode mode, float* l, float* r,
                                     int num_frames) noexcept {
    switch (mode) {
        case TrackChannelMode::Stereo: return;
        case TrackChannelMode::Mono:
            for (int f = 0; f < num_frames; ++f) {
                const float summed = 0.5f * (l[f] + r[f]);
                l[f] = summed;
                r[f] = summed;
            }
            return;
        case TrackChannelMode::Left:
            for (int f = 0; f < num_frames; ++f) r[f] = l[f];
            return;
        case TrackChannelMode::Right:
            for (int f = 0; f < num_frames; ++f) l[f] = r[f];
            return;
    }
}

}  // namespace lt
