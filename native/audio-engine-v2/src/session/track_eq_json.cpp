#include "session/track_eq_json.h"

#include <string>

namespace lt {

namespace {

std::optional<EqBandKind> parse_kind(const std::string& kind) noexcept {
    if (kind == "lowCut") return EqBandKind::LowCut;
    if (kind == "lowShelf") return EqBandKind::LowShelf;
    if (kind == "peak") return EqBandKind::Peak;
    if (kind == "highShelf") return EqBandKind::HighShelf;
    if (kind == "highCut") return EqBandKind::HighCut;
    if (kind == "notch") return EqBandKind::Notch;
    return std::nullopt;
}

template <typename T>
T number_or(const nlohmann::json& object, const char* key, T fallback) noexcept {
    const auto it = object.find(key);
    if (it == object.end() || !it->is_number())
        return fallback;
    return it->get<T>();
}

bool bool_or(const nlohmann::json& object, const char* key, bool fallback) noexcept {
    const auto it = object.find(key);
    if (it == object.end() || !it->is_boolean())
        return fallback;
    return it->get<bool>();
}

} // namespace

std::optional<TrackEqParams> parse_track_eq_json(const nlohmann::json& value) noexcept {
    try {
        if (!value.is_object())
            return std::nullopt;
        TrackEqParams params;
        params.enabled = bool_or(value, "enabled", true);
        params.band_count = 0;
        const auto bands = value.find("bands");
        if (bands != value.end() && bands->is_array()) {
            for (const auto& band : *bands) {
                if (params.band_count >= kTrackEqMaxBands)
                    break;
                if (!band.is_object())
                    continue;
                TrackEqBandParams out;
                out.enabled = bool_or(band, "enabled", true);
                const auto kind_it = band.find("kind");
                const std::string kind =
                    (kind_it != band.end() && kind_it->is_string()) ? kind_it->get<std::string>() : "peak";
                if (const auto parsed = parse_kind(kind)) {
                    out.kind = *parsed;
                } else {
                    out.kind = EqBandKind::Peak;
                    out.enabled = false;
                }
                out.frequency_hz = number_or<float>(band, "frequencyHz", 1000.0f);
                out.gain_db = number_or<float>(band, "gainDb", 0.0f);
                out.q = number_or<float>(band, "q", kTrackEqDefaultQ);
                out.slope_db_per_octave = number_or<int>(band, "slope", 12);
                params.bands[params.band_count++] = out;
            }
        }
        return clamp_params(params);
    } catch (...) {
        return std::nullopt;
    }
}

} // namespace lt
