#pragma once

// Ruteo de salida de las voces auxiliares (metrónomo, loops de batería, one
// shots): "master" | "monitor" | "ext:a-b". El parseo corre en el hilo de
// comandos; la resolución a canales del callback, en el de audio, sin
// reservas.

#include <lt_engine/devices/device_channel_layout.h>

#include <algorithm>
#include <cctype>
#include <string>

namespace lt {

enum class AuxRouteMode : int { Master = 0, Monitor = 1, Ext = 2 };

struct AuxRoute {
    AuxRouteMode mode = AuxRouteMode::Master;
    int start = 0;
    int end = 1;
};

inline std::string normalize_aux_route(std::string route) {
    std::transform(route.begin(), route.end(), route.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    route.erase(route.begin(), std::find_if(route.begin(), route.end(), [](unsigned char c) {
        return std::isspace(c) == 0;
    }));
    route.erase(std::find_if(route.rbegin(), route.rend(), [](unsigned char c) {
        return std::isspace(c) == 0;
    }).base(), route.end());
    return route.empty() ? std::string("master") : route;
}

// `route` ya normalizada.
inline AuxRoute parse_aux_route(const std::string& route) {
    AuxRoute out;
    if (route == "monitor") {
        out.mode = AuxRouteMode::Monitor;
        out.start = 2;
        out.end = 3;
    } else if (route.rfind("ext:", 0) == 0) {
        out.mode = AuxRouteMode::Ext;
        const std::string spec = route.substr(4);
        const auto dash = spec.find('-');
        try {
            if (dash == std::string::npos) {
                out.start = out.end = std::max(0, std::stoi(spec));
            } else {
                out.start = std::max(0, std::stoi(spec.substr(0, dash)));
                out.end = std::max(out.start, std::stoi(spec.substr(dash + 1)));
            }
        } catch (...) {
            out.start = 0;
            out.end = 1;
        }
    }
    return out;
}

struct ResolvedAuxRoute {
    int left = 0;
    int right = 0;
    const char* label = "master";
};

// Canales del callback para un ruteo. Sin reservas: apto para el render.
inline ResolvedAuxRoute resolve_aux_route(AuxRouteMode mode, int start, int end, int num_channels,
                                          const int* active_output_channels,
                                          int active_output_channel_count) noexcept {
    ResolvedAuxRoute r;
    r.left = 0;
    r.right = std::min(1, num_channels - 1);
    if (mode == AuxRouteMode::Monitor) {
        if (num_channels >= 4) {
            r.left = 2;
            r.right = 3;
            r.label = "monitor";
        } else {
            r.label = "monitor_fallback_master";
        }
    } else if (mode == AuxRouteMode::Ext) {
        const int mapped_left = device_layout::callback_channel_for_physical(
            start, active_output_channels, active_output_channel_count, num_channels);
        const int mapped_right = device_layout::callback_channel_for_physical(
            end, active_output_channels, active_output_channel_count, num_channels);
        if (mapped_left >= 0 && mapped_right >= 0) {
            r.left = mapped_left;
            r.right = mapped_right;
            r.label = "ext";
        } else {
            r.label = "ext_fallback_master";
        }
    }
    return r;
}

} // namespace lt
