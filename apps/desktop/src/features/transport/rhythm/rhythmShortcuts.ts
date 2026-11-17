// Atajos de teclado del panel Ritmo (plan drum-loops, paso 10). Usan los
// mismos handlers que la pantalla (D14): una instancia sin ajustes, porque
// solo dispara (loop, variaciones, pads, parar todo), que no los necesita.
import {
  loopSetAllRows,
  loopSetRow,
  loopToggle,
  setLoopPlaying,
  loopToggleRow,
  oneShotDown,
  oneShotsStopAll,
  oneShotUp,
  setActivePattern,
  setLoopConfig,
  setOneShotBank,
  setOneShotConfig,
} from "../desktopApi";
import type { ShortcutActionId } from "../keyboard/actions";
import { createRhythmHandlers } from "./rhythmHandlers";

const handlers = createRhythmHandlers({
  api: {
    loopToggle,
    setLoopPlaying,
    loopToggleRow,
    loopSetRow,
    loopSetAllRows,
    oneShotDown,
    oneShotUp,
    oneShotsStopAll,
    setActivePattern,
    setOneShotBank,
    setLoopConfig,
    setOneShotConfig,
  },
  getSettings: () => null,
  applySettings: () => {},
});

type Handler = (event: KeyboardEvent) => void;

const once = (run: () => unknown): Handler => (event) => {
  event.preventDefault();
  if (!event.repeat) void run();
};

/** Un pad suena mientras la tecla está pulsada (los pads en modo mantener
 * lo necesitan); al soltarla, `up`. */
const padKey = (pad: number): Handler => (event) => {
  event.preventDefault();
  if (event.repeat) return;
  void handlers.padDown(pad);
  const code = event.code;
  const release = (up: KeyboardEvent) => {
    if (up.code !== code) return;
    window.removeEventListener("keyup", release);
    void handlers.padUp(pad);
  };
  window.addEventListener("keyup", release);
};

type RhythmShortcutId = Extract<ShortcutActionId, `rhythm.${string}`>;
type PadShortcutId = Extract<RhythmShortcutId, `rhythm.pad${string}`>;

const PAD_HANDLERS = Object.fromEntries(
  Array.from({ length: 12 }, (_, i) => [`rhythm.pad${i + 1}`, padKey(i)]),
) as Record<PadShortcutId, Handler>;

export const RHYTHM_SHORTCUT_HANDLERS: Record<RhythmShortcutId, Handler> = {
  "rhythm.loopToggle": once(handlers.toggleLoop),
  "rhythm.variationA": once(() => handlers.setAllRows(0)),
  "rhythm.variationB": once(() => handlers.setAllRows(1)),
  "rhythm.variationC": once(() => handlers.setAllRows(2)),
  "rhythm.variationD": once(() => handlers.setAllRows(3)),
  "rhythm.stopAllPads": once(handlers.stopAllPads),
  ...PAD_HANDLERS,
};
