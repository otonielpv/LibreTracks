#!/usr/bin/env bash
# Make the build machine's Homebrew FFmpeg (and its full codec closure)
# universal (x86_64 + arm64), in place, by lipo-merging each dylib with its
# counterpart from a second single-arch Homebrew prefix.
#
# Why: the release builds the engine for --target universal-apple-darwin
# (x86_64;arm64) and bundles --target universal-apple-darwin. Homebrew bottles
# are single-arch (the runner's arch), so:
#   - at LINK time the engine's "other arch" slice can't link a single-arch
#     libav* → the universal build fails outright, and
#   - at RUNTIME a single-arch bundled FFmpeg crashes on the missing arch.
# Both go away if the FFmpeg dylibs the engine links and bundles are universal.
#
# Usage:
#   scripts/macos-universal-ffmpeg.sh <PRIMARY_BREW_PREFIX> <SECONDARY_BREW_PREFIX>
# PRIMARY is the native prefix the engine build discovers via pkg-config (it is
# universalized in place). SECONDARY is the other arch's Homebrew prefix,
# supplying the missing slice. On an arm64 runner: PRIMARY=/opt/homebrew,
# SECONDARY=/usr/local (an x86_64 Homebrew installed under Rosetta). The dylib
# closure is walked from PRIMARY's libav*; each dylib is merged with the file at
# the same relative path under SECONDARY.
#
# macOS only. Requires otool + lipo (Xcode command line tools).
set -euo pipefail

PRIMARY="${1:?usage: macos-universal-ffmpeg.sh <primary-prefix> <secondary-prefix>}"
SECONDARY="${2:?usage: macos-universal-ffmpeg.sh <primary-prefix> <secondary-prefix>}"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "macos-universal-ffmpeg: not macOS, nothing to do."
  exit 0
fi

# Strip trailing slashes so prefix substitution is exact.
PRIMARY="${PRIMARY%/}"
SECONDARY="${SECONDARY%/}"

FF_LIB="$PRIMARY/opt/ffmpeg/lib"
if [[ ! -d "$FF_LIB" ]]; then
  echo "macos-universal-ffmpeg: no ffmpeg under $FF_LIB — is it brew-installed in the primary prefix?" >&2
  exit 1
fi

# Same membership trick as macos-bundle-ffmpeg.sh — bash 3.2 has no associative
# arrays (and neither do the GitHub macOS runners).
seen=" "
is_seen() { case "$seen" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# A path under the PRIMARY prefix that we should consider for merging: a brew
# dylib (not an OS dylib under /usr/lib or /System).
under_primary() {
  case "$1" in
    "$PRIMARY"/*.dylib | "$PRIMARY"/*/*.dylib) return 0 ;;
    *) return 1 ;;
  esac
}

# Seed the walk with the four libraries the engine links directly. otool then
# pulls in the rest of the closure (libavcodec → x264/x265/dav1d/..., openssl,
# etc.) as we visit each file.
queue=()
for soname in libavformat libavcodec libavutil libswresample; do
  for cand in "$FF_LIB/$soname".*.dylib; do
    [[ -e "$cand" ]] && queue+=("$cand")
  done
done

merged=0
skipped=0
while [[ ${#queue[@]} -gt 0 ]]; do
  current="${queue[0]}"
  queue=("${queue[@]:1}")
  current="$(cd "$(dirname "$current")" && pwd -P)/$(basename "$current")"
  if is_seen "$current"; then continue; fi
  seen="$seen$current "

  # Already universal? Leave it (idempotent across re-runs).
  archs="$(lipo -archs "$current" 2>/dev/null || echo '')"
  if [[ "$archs" == *x86_64* && "$archs" == *arm64* ]]; then
    skipped=$((skipped + 1))
  else
    counterpart="$SECONDARY${current#"$PRIMARY"}"
    if [[ ! -f "$counterpart" ]]; then
      echo "macos-universal-ffmpeg: ERROR — no secondary-arch counterpart for $current at $counterpart" >&2
      echo "  (is the same ffmpeg version installed in $SECONDARY?)" >&2
      exit 1
    fi
    echo "  lipo  $(basename "$current")  ($archs + $(lipo -archs "$counterpart" 2>/dev/null))"
    tmp="$current.universal.$$"
    lipo -create "$current" "$counterpart" -output "$tmp"
    chmod u+w "$current"
    mv -f "$tmp" "$current"
    merged=$((merged + 1))
  fi

  # Walk this dylib's own brew dependencies.
  while IFS= read -r dep; do
    if under_primary "$dep"; then
      queue+=("$dep")
    fi
  done < <(otool -L "$current" | tail -n +2 | awk '{print $1}')
done

echo "macos-universal-ffmpeg: done. merged=$merged already-universal=$skipped"
