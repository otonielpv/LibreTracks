import { describe, expect, it } from "vitest";

import { roleAllows, type NetworkCommandName } from "./networkRoles";

// Mirrors the table in crates/libretracks-link/src/permissions.rs. If a
// command moves role there, it moves here in the same commit.
const CONTROL: NetworkCommandName[] = [
  "play",
  "pause",
  "stop",
  "fadeOutStop",
  "seek",
  "jumpToMarker",
  "jumpToSong",
  "toggleVamp",
  "cancelJump",
  "setJumpSettings",
  "reorderSong",
];
const EDIT: NetworkCommandName[] = [
  "setSongChart",
  "setSongTranspose",
  "setTrackMix",
  "setSongMasterGain",
  "setMetronome",
];

describe("roleAllows", () => {
  it("viewer and nobody can send nothing", () => {
    for (const command of [...CONTROL, ...EDIT]) {
      expect(roleAllows("viewer", command)).toBe(false);
      expect(roleAllows(null, command)).toBe(false);
    }
  });

  it("controller gets transport and setlist, not content or mix", () => {
    for (const command of CONTROL) expect(roleAllows("controller", command)).toBe(true);
    for (const command of EDIT) expect(roleAllows("controller", command)).toBe(false);
  });

  it("editor gets everything, mix included", () => {
    for (const command of [...CONTROL, ...EDIT]) expect(roleAllows("editor", command)).toBe(true);
  });
});
