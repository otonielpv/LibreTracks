import type { SongView } from "@libretracks/shared/models";

/**
 * The mixer targets of the MIDI controller plan (pasos 03-04) as the UI
 * names them. The key format mirrors `MidiTarget` in
 * `libretracks-core/src/midi_control.rs`.
 */
export const MIX_CONTROLS = ["volume", "pan", "mute", "solo"] as const;
export type MixControl = (typeof MIX_CONTROLS)[number];

export const MIXER_TARGETS = [
  { key: "mixer:song_master:volume", labelKey: "midiMap.songMaster" },
  { key: "mixer:metronome:volume", labelKey: "midiMap.metronome" },
  { key: "mixer:voice_guide:volume", labelKey: "midiMap.voiceGuide" },
  { key: "mixer:pads:volume", labelKey: "midiMap.pads" },
] as const;

export const STRIP_COUNT = 8;

export const trackTarget = (trackId: string, control: MixControl) =>
  `track:${trackId}:${control}`;

type T = (key: string, options?: Record<string, unknown>) => string;

function parseMix(rest: string): [string, MixControl] | null {
  const split = rest.lastIndexOf(":");
  if (split <= 0) return null;
  const control = rest.slice(split + 1);
  if (!(MIX_CONTROLS as readonly string[]).includes(control)) return null;
  return [rest.slice(0, split), control as MixControl];
}

/** The track id of a `track:<id>:<control>` key. */
export function trackIdOfTarget(key: string): string | null {
  if (!key.startsWith("track:")) return null;
  return parseMix(key.slice("track:".length))?.[0] ?? null;
}

/**
 * A readable name for a mixer target, or null for keys this module does not
 * own (the transport rows keep their own labels).
 */
export function describeMidiTarget(
  key: string,
  t: T,
  song: SongView | null,
): string | null {
  if (key.startsWith("track:")) {
    const parsed = parseMix(key.slice("track:".length));
    if (!parsed) return null;
    const [trackId, control] = parsed;
    const track = song?.tracks.find((item) => item.id === trackId);
    return `${track?.name ?? t("midiMap.otherSession")} · ${t(`midiMap.${control}`)}`;
  }
  if (key.startsWith("strip:")) {
    const [index, control] = key.slice("strip:".length).split(":");
    if (!(MIX_CONTROLS as readonly string[]).includes(control)) return null;
    return `${t("midiMap.strip", { index })} · ${t(`midiMap.${control}`)}`;
  }
  if (key === "bank:next") return t("midiMap.bankNext");
  if (key === "bank:prev") return t("midiMap.bankPrev");
  const mixer = MIXER_TARGETS.find((item) => item.key === key);
  return mixer ? t(mixer.labelKey) : null;
}

/** Whether a track binding points at a track the open session does not have. */
export function isOtherSessionTarget(key: string, song: SongView | null) {
  const trackId = trackIdOfTarget(key);
  return trackId !== null && !song?.tracks.some((track) => track.id === trackId);
}

/** The "Mixer" view rows: strips 1-8, banks and the app-level faders. */
export function mixerLearnKeys(): string[] {
  const keys: string[] = [];
  for (let index = 1; index <= STRIP_COUNT; index += 1) {
    for (const control of MIX_CONTROLS) {
      keys.push(`strip:${index}:${control}`);
    }
  }
  keys.push("bank:prev", "bank:next");
  for (const mixer of MIXER_TARGETS) keys.push(mixer.key);
  return keys;
}
