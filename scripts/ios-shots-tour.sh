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

  local w h
  w="$(sips -g pixelWidth "$file" 2>/dev/null | awk '/pixelWidth/ {print $2}')"
  h="$(sips -g pixelHeight "$file" 2>/dev/null | awk '/pixelHeight/ {print $2}')"

  # simctl writes the DEVICE framebuffer, which stays portrait even when the
  # app runs landscape: the app is drawn rotated inside it, status bar down
  # the right-hand edge. Rotating 270° puts that edge back on top, and the
  # result is both readable and the exact size App Store Connect expects for
  # a landscape screenshot.
  if [ "${SCREEN_W:-0}" -gt "${SCREEN_H:-0}" ] 2>/dev/null && [ "$h" -gt "$w" ] 2>/dev/null; then
    sips -r 270 "$file" >/dev/null 2>&1
    w="$(sips -g pixelWidth "$file" 2>/dev/null | awk '/pixelWidth/ {print $2}')"
    h="$(sips -g pixelHeight "$file" 2>/dev/null | awk '/pixelHeight/ {print $2}')"
    log "  📸 $(basename "$file")  ${w}x${h} (rotada)"
    return
  fi
  log "  📸 $(basename "$file")  ${w}x${h}"
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
# Coordinates, not labels: the WebView publishes nothing to the accessibility
# tree, so there is nothing to look up. These fractions were measured off the
# iPad screenshots — both dialogs are centred cards, and "Skip tutorial" sits
# in the lower-left of the card with the primary button to its right.
tap_frac "Skip tutorial" 0.44 0.56
shot "after-skip"
# The analytics consent usually appears right after, in a card of the same
# shape. A second tap in the same place dismisses it when it is there and
# lands on empty background when it is not.
tap_frac "No, thanks (mismo sitio)" 0.44 0.56
shot "after-consent"

log "── 01 Portada ──────────────────────────────────────────────"
shot "home"

# CALIBRATION STAGE. The three view modes already work (the app cycles them
# with Tab), but the sidebar, the demo button and the mixer toggle need
# coordinates measured off a clean screenshot of the landing — which is
# exactly what "home" above now provides. Until those are measured, walking
# blind would only produce six pictures of the same screen.
log "── Vistas, que sí se ciclan con Tab ────────────────────────"
key 43   # daw → compact
shot "compact-empty"
key 43   # compact → live
shot "live-empty"
key 43   # live → daw
shot "daw-empty"

log "────────────────────────────────────────────────────────────"
log "Etapa de calibración: faltan Configuración, la demo y el mixer,"
log "que necesitan coordenadas tomadas de 02-home.png"
