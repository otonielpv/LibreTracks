#pragma once

#include <string>
#include <string_view>

namespace lt {

// Engine version, matching CMake project version.
constexpr int kEngineMajor = 0;
constexpr int kEngineMinor = 1;
constexpr int kEnginePatch = 0;

std::string engine_version_string();

} // namespace lt
