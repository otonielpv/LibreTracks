import type { MidiBinding } from "@libretracks/shared/models";

import { trackIdOfTarget } from "./controllerTargets";

/**
 * Controller profiles (plan midi-controllers, paso 07, D9): one JSON fills
 * the strips, the banks and the transport of a known controller at once, so
 * plugging a nanoKONTROL2 in does not mean learning 40 controls.
 *
 * A profile only holds device-level bindings (`strip:*`, `bank:*`,
 * `mixer:*`, `action:*`, `param:*`): a `track:<id>` binding belongs to one
 * session and is never exported.
 */
export type ControllerProfile = {
  /** File format version, for a future change of shape. */
  version: 1;
  id: string;
  name: string;
  /** Case-insensitive substrings of the MIDI port name that identify it. */
  portMatch: string[];
  /** Notes for the user (how to set the device up). */
  notes?: string;
  bindings: Record<string, MidiBinding>;
};

const cc = (data1: number, channel = 1): MidiBinding => ({
  status: 0xb0 | (channel - 1),
  data1,
  isCc: true,
});

/**
 * Korg nanoKONTROL2, factory scene in CC mode (global channel 1), as Korg's
 * parameter guide lists it: faders CC 0-7, knobs 16-23, S 32-39, M 48-55,
 * R 64-71, transport 41-46, track 58/59, marker 60-62. Still to confirm with
 * the device and the app's MIDI monitor (plan, "Por verificar").
 */
function nanoKontrol2(): ControllerProfile {
  const bindings: Record<string, MidiBinding> = {};
  for (let strip = 1; strip <= 8; strip += 1) {
    const offset = strip - 1;
    bindings[`strip:${strip}:volume`] = cc(0 + offset);
    bindings[`strip:${strip}:pan`] = cc(16 + offset);
    bindings[`strip:${strip}:solo`] = cc(32 + offset);
    bindings[`strip:${strip}:mute`] = cc(48 + offset);
  }
  bindings["action:play"] = cc(41);
  bindings["action:stop"] = cc(42);
  bindings["action:previous_song"] = cc(43);
  bindings["action:next_song"] = cc(44);
  bindings["action:toggle_vamp"] = cc(46);
  bindings["bank:prev"] = cc(58);
  bindings["bank:next"] = cc(59);
  return {
    version: 1,
    id: "korg-nanokontrol2",
    name: "Korg nanoKONTROL2",
    portMatch: ["nanokontrol2"],
    notes:
      "Factory CC scene. For the S/M buttons and the transport to light from the app, set LED Mode to External in the KORG KONTROL Editor.",
    bindings,
  };
}

const note = (data1: number): MidiBinding => ({ status: 0x90, data1, isCc: false });

/**
 * Mackie Control Universal (plan midi-controllers, paso 09). The protocol is
 * public and fixed: faders are 14-bit pitch bend on channels 1-8 (master on
 * 9) and move by motor when the app sends the same message back; V-Pots are
 * CC 16-23 in sign-magnitude; buttons are notes on channel 1 whose LED
 * lights with the same note at velocity 127: REC 0-7, SOLO 8-15, MUTE 16-23,
 * bank left/right 46/47, rewind 91, forward 92, stop 93, play 94, cycle 86,
 * click 89.
 */
function mackieBindings(): Record<string, MidiBinding> {
  const bindings: Record<string, MidiBinding> = {};
  for (let strip = 1; strip <= 8; strip += 1) {
    const offset = strip - 1;
    bindings[`strip:${strip}:volume`] = { status: 0xe0 | offset, data1: 0, isCc: false };
    bindings[`strip:${strip}:pan`] = { ...cc(16 + offset), mode: "relativeSignMagnitude" };
    bindings[`strip:${strip}:solo`] = note(8 + offset);
    bindings[`strip:${strip}:mute`] = note(16 + offset);
  }
  bindings["mixer:song_master:volume"] = { status: 0xe8, data1: 0, isCc: false };
  bindings["bank:prev"] = note(46);
  bindings["bank:next"] = note(47);
  bindings["action:previous_song"] = note(91);
  bindings["action:next_song"] = note(92);
  bindings["action:stop"] = note(93);
  bindings["action:play"] = note(94);
  bindings["action:toggle_vamp"] = note(86);
  bindings["action:toggle_metronome"] = note(89);
  return bindings;
}

function mackieControl(): ControllerProfile {
  return {
    version: 1,
    id: "mackie-control",
    name: "Mackie Control (MCU)",
    portMatch: ["mackie", "mcu", "x-touch", "qcon", "platform m"],
    notes:
      "Put the controller in Mackie Control / MCU mode. Motor faders and button LEDs need the controller output set in Settings > MIDI.",
    bindings: mackieBindings(),
  };
}

/**
 * M-Vave SMC-Mixer in its Mackie mode (the protocol above), which this app
 * drives in full. Its generic CC mode has no confirmed map yet (plan, "Por
 * verificar"): learn it and export it as a profile.
 */
function smcMixer(): ControllerProfile {
  return {
    ...mackieControl(),
    id: "mvave-smc-mixer",
    name: "M-Vave SMC-Mixer (Mackie)",
    portMatch: ["smc-mixer", "smc mixer", "smc_mixer"],
    notes:
      "Switch the SMC-Mixer to its Mackie (MCU) mode. For LEDs and motor faders choose its output in Settings > MIDI.",
  };
}

export const BUILTIN_CONTROLLER_PROFILES: ControllerProfile[] = [
  nanoKontrol2(),
  smcMixer(),
  mackieControl(),
];

/** The profile whose port name matches one of the given ports. */
export function detectControllerProfile(
  portNames: string[],
  profiles: ControllerProfile[] = BUILTIN_CONTROLLER_PROFILES,
): { profile: ControllerProfile; port: string } | null {
  for (const port of portNames) {
    const lower = port.toLowerCase();
    const profile = profiles.find((item) =>
      item.portMatch.some((match) => match && lower.includes(match.toLowerCase())),
    );
    if (profile) return { profile, port };
  }
  return null;
}

/**
 * The mappings after applying a profile: its bindings win for the keys it
 * names, and any other binding that used one of its controls is dropped, so
 * a fader does not end up driving an old target as well.
 */
export function applyControllerProfile(
  current: Record<string, MidiBinding>,
  profile: ControllerProfile,
): Record<string, MidiBinding> {
  const controlKey = (binding: MidiBinding) => {
    const kind = binding.status & 0xf0;
    const status = kind === 0x80 ? 0x90 | (binding.status & 0x0f) : binding.status;
    return kind === 0xe0 ? `${status}` : `${status}:${binding.data1}`;
  };
  const used = new Set(Object.values(profile.bindings).map(controlKey));
  const next: Record<string, MidiBinding> = {};
  for (const [key, binding] of Object.entries(current)) {
    if (!used.has(controlKey(binding)) && !(key in profile.bindings)) {
      next[key] = binding;
    }
  }
  return { ...next, ...profile.bindings };
}

/** A profile from the current device-level bindings, for export. */
export function profileFromMappings(
  mappings: Record<string, MidiBinding>,
  name: string,
  portName: string | null,
): ControllerProfile {
  const bindings = Object.fromEntries(
    Object.entries(mappings).filter(([key]) => trackIdOfTarget(key) === null),
  );
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    version: 1,
    id: slug || "custom",
    name,
    portMatch: portName ? [portName] : [],
    bindings,
  };
}

/** Parse and validate an imported profile; throws with a reason. */
export function parseControllerProfile(text: string): ControllerProfile {
  const data = JSON.parse(text) as Partial<ControllerProfile>;
  if (!data || typeof data !== "object") throw new Error("not an object");
  if (data.version !== 1) throw new Error("unknown profile version");
  if (typeof data.name !== "string" || !data.name.trim()) throw new Error("missing name");
  if (!data.bindings || typeof data.bindings !== "object") throw new Error("missing bindings");
  const bindings: Record<string, MidiBinding> = {};
  for (const [key, value] of Object.entries(data.bindings)) {
    const binding = value as Partial<MidiBinding> | null;
    if (
      !binding ||
      !Number.isInteger(binding.status) ||
      !Number.isInteger(binding.data1) ||
      trackIdOfTarget(key) !== null
    ) {
      continue;
    }
    bindings[key] = { ...binding, isCc: ((binding.status as number) & 0xf0) === 0xb0 } as MidiBinding;
  }
  return {
    version: 1,
    id: typeof data.id === "string" && data.id ? data.id : "imported",
    name: data.name.trim(),
    portMatch: Array.isArray(data.portMatch)
      ? data.portMatch.filter((item): item is string => typeof item === "string")
      : [],
    notes: typeof data.notes === "string" ? data.notes : undefined,
    bindings,
  };
}
