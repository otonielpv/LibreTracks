#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Walks the app in a booted simulator and photographs the six screens the
# App Store listing needs:
#
#   01 home        the landing, after the tutorial and the analytics prompt
#   02 settings    the settings panel
#   03 daw         the demo song on the timeline
#   04 compact     the compact (song columns) view
#   05 mixer       the same view with the mixer band open
#   06 live        the live markers view
#
# Taps go through idb, which reads the accessibility tree, so screens are
# found by their LABEL rather than by hardcoded coordinates — a layout change
# then moves the tap instead of silently photographing the wrong thing. The
# three view modes need no tap at all: the app cycles them with Tab.
#
# Every step screenshots whatever is on screen, including when a tap failed,
# and the accessibility tree of a failed lookup is written next to it. A tour
# that goes wrong should leave evidence of what it saw, not six pictures of
# the same screen.
#
#   ios-shots-tour.sh <udid> <output-dir>
# ---------------------------------------------------------------------------
set -uo pipefail

UDID="${1:?usage: ios-shots-tour.sh <udid> <output-dir>}"
OUT="${2:?usage: ios-shots-tour.sh <udid> <output-dir>}"
BUNDLE_ID="com.libretracks.ios"

mkdir -p "$OUT"
failures=0
step=0

if ! command -v idb >/dev/null 2>&1; then
  echo "ios-shots-tour: idb is not installed, so nothing can be tapped." >&2
  echo "Install it with: brew trust facebook/fb && brew install facebook/fb/idb-companion && pip install fb-idb" >&2
  exit 1
fi

log() { printf '%s\n' "$*"; }

shot() {
  local name="$1"
  step=$((step + 1))
  local file
  file="$(printf '%s/%02d-%s.png' "$OUT" "$step" "$name")"
  xcrun simctl io "$UDID" screenshot "$file" >/dev/null 2>&1
  local size
  size="$(sips -g pixelWidth -g pixelHeight "$file" 2>/dev/null \
    | awk '/pixelWidth/ {w=$2} /pixelHeight/ {h=$2} END {print w "x" h}')"
  log "  📸 $(basename "$file")  $size"
}

# The accessibility tree, as idb sees it. Cached per call because every lookup
# needs a fresh one (the UI moves between taps).
describe() {
  idb ui describe-all --udid "$UDID" 2>/dev/null
}

# Screen size in POINTS, read from the one element the tree does contain: the
# application itself. idb taps in points, and the app is the whole screen.
SCREEN_W=0
SCREEN_H=0
read_screen_size() {
  local tree
  tree="$(describe)"
  SCREEN_W="$(printf '%s' "$tree" | jq -r '[.[] | select(.type == "Application") | .frame.width] | .[0] // 0' 2>/dev/null)"
  SCREEN_H="$(printf '%s' "$tree" | jq -r '[.[] | select(.type == "Application") | .frame.height] | .[0] // 0' 2>/dev/null)"
  log "  pantalla: ${SCREEN_W}x${SCREEN_H} puntos"
}

# Tap a point given as a fraction of the screen. The WebView publishes nothing
# to the accessibility tree — `describe-all` returns the application and
# nothing else — so labels cannot be looked up and this is what is left.
# Fractions rather than pixels so the same tour survives a different device.
tap_frac() {
  local what="$1" fx="$2" fy="$3"
  if [ "$SCREEN_W" = "0" ] || [ "$SCREEN_H" = "0" ]; then
    read_screen_size
  fi
  local x y
  x="$(awk "BEGIN { printf \"%d\", $SCREEN_W * $fx }")"
  y="$(awk "BEGIN { printf \"%d\", $SCREEN_H * $fy }")"
  idb ui tap --udid "$UDID" "$x" "$y" >/dev/null 2>&1 \
    && log "  👆 $what en ($x, $y)" \
    || log "  ⚠️  el toque de $what no llegó"
  sleep 2
}

# Tap the centre of the first element whose label matches, case-insensitively.
# Retries: the WebView publishes its tree a beat after the view appears, and a
# single miss would otherwise derail the whole tour.
tap_label() {
  local needle="$1"
  local tries="${2:-5}"
  local tree coords
  for _ in $(seq 1 "$tries"); do
    tree="$(describe)"
    coords="$(printf '%s' "$tree" | jq -r --arg n "$needle" '
        select(type == "object")
        | select((.AXLabel // .label // "") | ascii_downcase | contains($n | ascii_downcase))
        | select(.frame != null)
        | "\(.frame.x + .frame.width / 2) \(.frame.y + .frame.height / 2)"
      ' 2>/dev/null | head -1)"
    if [ -n "$coords" ]; then
      # shellcheck disable=SC2086
      idb ui tap --udid "$UDID" $coords >/dev/null 2>&1
      log "  👆 \"$needle\" en ($coords)"
      sleep 2
      return 0
    fi
    sleep 2
  done
  log "  ⚠️  no encontrado: \"$needle\""
  printf '%s' "$tree" > "$OUT/tree-missing-$(printf '%s' "$needle" | tr -c 'a-zA-Z0-9' '-').json"
  return 1
}

# Same, but a miss is expected and fine (a dialog that did not appear).
tap_label_optional() {
  tap_label "$1" "${2:-2}" || true
}

require() {
  if ! "$@"; then
    failures=$((failures + 1))
  fi
}

key() {
  # HID usage codes: Tab is 43, Escape is 41.
  idb ui key --udid "$UDID" "$1" >/dev/null 2>&1 \
    && log "  ⌨️  tecla $1" \
    || log "  ⚠️  la tecla $1 no llegó"
  sleep 2
}

log "── Esperando a que la app termine de arrancar ──────────────"
sleep 20
describe > "$OUT/tree-at-launch.json" 2>/dev/null || true
read_screen_size
shot "launch"

log "── Despachando el tutorial y el aviso de estadísticas ──────"
# Order is not guaranteed, and either may be absent on a warm container, so
# both are attempted twice rather than assumed.
tap_label_optional "Skip tutorial"
tap_label_optional "No, thanks"
tap_label_optional "Skip tutorial"
tap_label_optional "No, thanks"

log "── 01 Portada ──────────────────────────────────────────────"
shot "home"

log "── 02 Configuración ────────────────────────────────────────"
if tap_label "Settings"; then
  shot "settings"
  key 41   # Escape
else
  failures=$((failures + 1))
  shot "settings-FAILED"
fi

log "── 03 Canción de demostración en la vista DAW ──────────────"
if tap_label "Demo song" 5; then
  # Creating the demo unpacks audio and analyses waveforms; the timeline is
  # not worth photographing until that settles.
  sleep 25
  shot "daw"
else
  failures=$((failures + 1))
  shot "daw-FAILED"
fi

log "── 04 Vista compacta ───────────────────────────────────────"
key 43   # Tab: daw → compact
# On a tablet the mixer band starts open, so close it for the clean shot and
# open it again for the next one.
tap_label_optional "Hide mixer"
shot "compact"

log "── 05 Mixer de la vista compacta ───────────────────────────"
require tap_label "Mixer"
shot "mixer"

log "── 06 Vista live ───────────────────────────────────────────"
key 43   # Tab: compact → live
shot "live"

log "────────────────────────────────────────────────────────────"
if [ "$failures" -gt 0 ]; then
  log "El recorrido terminó con $failures paso(s) fallidos; mira las capturas -FAILED y los árboles tree-missing-*.json"
  exit 1
fi
log "Las seis capturas salieron sin incidencias"
