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
# Taps go by COORDINATE, which was not the first choice: idb can look elements
# up in the accessibility tree, but this app is a WebView and
# `idb ui describe-all` returns exactly one element — the application — with
# nothing inside it. There is no label to search for. So the fractions below
# were measured off real screenshots of this app on this device, and every tap
# verifies that the screen actually changed instead of assuming it landed.
#
# The three view modes need no tap at all: the app cycles them with Tab.
#
# Every step screenshots whatever is on screen, including after a tap that
# missed. A tour that goes wrong should leave evidence of what it saw, not six
# pictures of the same screen.
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

# iPad and iPhone lay the same UI out differently — the phone is far narrower
# in proportion — so a single set of fractions cannot serve both. The profile
# is read from the aspect ratio rather than from a flag, so running the tour
# on a new device picks the right one without anybody remembering to pass it.
#
#   iPad Pro 13"      1376 x 1032  -> 1.33
#   iPhone 16 Pro Max  956 x  440  -> 2.17
PROFILE=""
read_profile() {
  if [ "$SCREEN_W" = "0" ] || [ "$SCREEN_H" = "0" ]; then
    read_screen_size
  fi
  local wide
  wide="$(awk "BEGIN { print ($SCREEN_W / $SCREEN_H > 1.8) ? 1 : 0 }")"
  if [ "$wide" = "1" ]; then PROFILE="phone"; else PROFILE="tablet"; fi
  log "  perfil: $PROFILE"
}

# Fractions of the app's own space, measured off real screenshots of this app
# on each device. An empty answer means "not calibrated on this device yet":
# the step then records a miss and moves on, instead of tapping a guess that
# could hit the wrong button (on the consent card, the neighbour is "Allow").
coords() {
  case "$PROFILE:$1" in
    tablet:skip)     echo "0.437 0.563" ;;
    phone:skip)      echo "0.345 0.680" ;;
    tablet:consent)  echo "0.465 0.593" ;;
    phone:consent)   echo "0.385 0.738" ;;
    tablet:settings) echo "0.019 0.819" ;;
    phone:settings)  echo "0.090 0.782" ;;
    tablet:demo)     echo "0.683 0.341" ;;
    phone:demo)      echo "0.700 0.597" ;;
    tablet:mixer)    echo "0.520 0.278" ;;
    phone:mixer)     echo "0.561 0.916" ;;
    *) echo "" ;;
  esac
}

tap_control() {
  local what="$1" control="$2" fracs
  fracs="$(coords "$control")"
  if [ -z "$fracs" ]; then
    log "  ⚠️  $what: sin calibrar en el perfil $PROFILE"
    return 1
  fi
  # shellcheck disable=SC2086
  tap_frac "$what" $fracs
}

screen_hash() {
  local tmp="$OUT/.probe.png"
  xcrun simctl io "$UDID" screenshot "$tmp" >/dev/null 2>&1
  shasum -a 1 "$tmp" 2>/dev/null | cut -d' ' -f1
}

# Tap a point given as a fraction of the APP's own (landscape) space. The
# WebView publishes nothing to the accessibility tree — `describe-all` returns
# the application and nothing else — so labels cannot be looked up and this is
# what is left. Fractions rather than pixels so the same tour survives a
# different device.
#
# The catch: the app runs landscape but the DEVICE stays portrait, and it is
# not documented which of the two spaces idb taps in. So this tries the
# device-space conversion first, checks whether the screen actually changed,
# and falls back to the app space when it did not. One run settles it instead
# of a guess that silently taps empty background.
tap_frac() {
  local what="$1" fx="$2" fy="$3"
  if [ "$SCREEN_W" = "0" ] || [ "$SCREEN_H" = "0" ]; then
    read_screen_size
  fi
  local xa ya xd yd before after
  xa="$(awk "BEGIN { printf \"%d\", $SCREEN_W * $fx }")"
  ya="$(awk "BEGIN { printf \"%d\", $SCREEN_H * $fy }")"
  # Landscape app point -> portrait device point.
  xd="$(( SCREEN_H - ya ))"
  yd="$xa"

  before="$(screen_hash)"
  idb ui tap --udid "$UDID" "$xd" "$yd" >/dev/null 2>&1
  sleep 2
  after="$(screen_hash)"
  if [ -n "$before" ] && [ "$before" != "$after" ]; then
    log "  👆 $what en device($xd, $yd) ✔"
    return 0
  fi

  idb ui tap --udid "$UDID" "$xa" "$ya" >/dev/null 2>&1
  sleep 2
  after="$(screen_hash)"
  if [ -n "$before" ] && [ "$before" != "$after" ]; then
    log "  👆 $what en app($xa, $ya) ✔"
    return 0
  fi
  log "  ⚠️  $what: ni device($xd, $yd) ni app($xa, $ya) cambiaron la pantalla"
  return 1
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
read_profile
shot "launch"

log "── Despachando el tutorial y el aviso de estadísticas ──────"
# Coordinates, not labels: the WebView publishes nothing to the accessibility
# tree, so there is nothing to look up. These fractions were measured off the
# iPad screenshots — both dialogs are centred cards, and "Skip tutorial" sits
# in the lower-left of the card with the primary button to its right.
tap_control "Skip tutorial" skip
# The analytics consent only appears AFTER the tutorial closes, and it takes a
# moment: tapping its position too early hits the tutorial's backdrop instead.
sleep 4
shot "after-skip"
# Its card is wider than the tutorial's, so "No, thanks" sits elsewhere —
# measured off 04-home.png of run 34645588357.
tap_control "No, thanks" consent
shot "after-consent"

log "── 01 Portada ──────────────────────────────────────────────"
shot "home"

# Every fraction below was measured off a real screenshot of this app on this
# device (run 34646454084), not guessed. They are fractions rather than pixels
# so an iPhone run lands in the same relative place.
log "── 02 Configuración ────────────────────────────────────────"
if tap_control "Ajustes (engranaje de la barra lateral)" settings; then
  shot "settings"
  key 41   # Escape closes the panel (nav.cancelOrClear)
  sleep 2
else
  failures=$((failures + 1))
  shot "settings-FAILED"
fi

log "── 03 Canción de demostración en la vista DAW ──────────────"
if tap_control "Demo song" demo; then
  # Creating the demo unpacks its audio and analyses the waveforms. The
  # timeline is not worth photographing until that settles.
  sleep 30
  shot "daw"
else
  failures=$((failures + 1))
  shot "daw-FAILED"
fi

log "── 04 y 05 Vista compacta, con y sin mixer ─────────────────"
key 43   # daw → compact
# Which of the two comes first depends on the device: CompactView opens the
# mixer band by default only when the window is at least 1000 points wide, so
# the iPad starts with it open and the phone with it closed. Same two shots,
# opposite order, and the toggle sits somewhere different on each.
if [ "$PROFILE" = "tablet" ]; then
  shot "compact-with-mixer"
  if tap_control "Hide mixer" mixer; then
    shot "compact"
  else
    failures=$((failures + 1))
    shot "compact-FAILED"
  fi
else
  shot "compact"
  if tap_control "Show mixer" mixer; then
    shot "compact-with-mixer"
  else
    failures=$((failures + 1))
    shot "compact-with-mixer-FAILED"
  fi
fi

log "── 06 Vista live ───────────────────────────────────────────"
key 43   # compact → live
shot "live"

rm -f "$OUT/.probe.png"

log "────────────────────────────────────────────────────────────"
if [ "$failures" -gt 0 ]; then
  log "El recorrido terminó con $failures paso(s) fallidos; mira las capturas -FAILED"
  exit 1
fi
log "Recorrido completo"
