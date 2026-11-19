#pragma once

// Lectura TOLERANTE del EQ de una pista (plan track-eq, D8). La comparten los
// dos parsers de pista: `session_adapter.cpp` (el `Song` camelCase del core) y
// `commands.cpp` (`UpsertSongTracks` / `SetTrackEq`). Así no hay dos lecturas
// que se desincronicen, el mismo problema que ya tuvieron las regiones.
//
// El objeto es el `TrackEq` del core tal cual (camelCase):
//   { "enabled": true, "bands": [ { "enabled", "kind", "frequencyHz",
//     "gainDb", "q", "slope" } ] }
// Sin objeto, `null` o de otro tipo = sin EQ. Campos ausentes = los valores
// por defecto del core. Un tipo de banda desconocido (de una versión futura)
// apaga esa banda en vez de sonar a otra cosa. El resultado sale recortado.

#include <lt_engine/render/track_eq_params.h>

#include <nlohmann/json.hpp>

#include <optional>

namespace lt {

std::optional<TrackEqParams> parse_track_eq_json(const nlohmann::json& value) noexcept;

} // namespace lt
