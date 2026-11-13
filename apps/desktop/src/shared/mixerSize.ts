import { useSyncExternalStore } from "react";

// Mixer size: how wide the channel strips are and how big the faders, their
// caps and the M/S/T buttons, without scaling the rest of the interface.
// Asked for from an iPad: even at 125% interface size the strips felt narrow
// to ride a fader on stage. Per install (localStorage), like the interface
// size, and applied as a class on <html> that faders.css turns into the
// --lt-mixer-fader-scale / --lt-mixer-strip-width variables.
//
// "auto" keeps the built-in rule: large on a tablet, normal elsewhere.

export const MIXER_SIZES = ["auto", "normal", "large", "xlarge"] as const;
export type MixerSize = (typeof MIXER_SIZES)[number];

const STORAGE_KEY = "lt.ui.mixerSize";
const CLASS_PREFIX = "lt-mixer-size-";

const isMixerSize = (value: unknown): value is MixerSize =>
  typeof value === "string" && (MIXER_SIZES as readonly string[]).includes(value);

const readStored = (): MixerSize => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isMixerSize(raw) ? raw : "auto";
  } catch {
    return "auto";
  }
};

let current: MixerSize = typeof window === "undefined" ? "auto" : readStored();
const listeners = new Set<() => void>();

const applyToDom = (size: MixerSize): void => {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const candidate of MIXER_SIZES) {
    root.classList.toggle(`${CLASS_PREFIX}${candidate}`, candidate === size && size !== "auto");
  }
};

export function getMixerSize(): MixerSize {
  return current;
}

export function setMixerSize(next: MixerSize): void {
  const size = isMixerSize(next) ? next : "auto";
  applyToDom(size);
  if (size === current) return;
  current = size;
  try {
    window.localStorage.setItem(STORAGE_KEY, size);
  } catch {
    // Private mode / storage disabled: keep it for this run.
  }
  for (const listener of listeners) listener();
}

/** Apply the remembered size. Call once on app start. */
export function initMixerSize(): void {
  applyToDom(current);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMixerSize(): MixerSize {
  return useSyncExternalStore(subscribe, getMixerSize, () => "auto" as MixerSize);
}
