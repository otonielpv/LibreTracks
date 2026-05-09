#!/usr/bin/env bash
# Build the C++ audio engine v2 on Linux / macOS.
#
# Usage:  ./scripts/build.sh [Release|Debug]
#
# Prerequisites:
#   - CMake >= 3.25
#   - C++20 compiler (GCC 11+ or Clang 13+)
#   - git (for FetchContent)

set -euo pipefail

CONFIG="${1:-Release}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$SCRIPT_DIR/.."
BUILD_DIR="$ENGINE_DIR/build"

cmake -S "$ENGINE_DIR" -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE="$CONFIG" \
    -DLT_ENGINE_BUILD_TESTS=ON

cmake --build "$BUILD_DIR" --config "$CONFIG" --parallel

echo "Done. Output in: $BUILD_DIR/"
