import { describe, expect, it } from "vitest";

import {
  applyControllerProfile,
  BUILTIN_CONTROLLER_PROFILES,
  detectControllerProfile,
  parseControllerProfile,
  profileFromMappings,
} from "./controllerProfiles";

const nano = BUILTIN_CONTROLLER_PROFILES.find((item) => item.id === "korg-nanokontrol2")!;

describe("controller profiles", () => {
  it("nanoKONTROL2 fills 8 strips, transport and banks", () => {
    expect(nano.bindings["strip:1:volume"]).toEqual({ status: 0xb0, data1: 0, isCc: true });
    expect(nano.bindings["strip:8:mute"].data1).toBe(55);
    expect(nano.bindings["strip:3:solo"].data1).toBe(34);
    expect(nano.bindings["action:play"].data1).toBe(41);
    expect(nano.bindings["bank:next"].data1).toBe(59);
  });

  it("detects a profile from the port name, case-insensitively", () => {
    expect(detectControllerProfile(["Pedal", "NANOKONTROL2 1 SLIDER/KNOB"])?.profile.id).toBe(
      "korg-nanokontrol2",
    );
    expect(detectControllerProfile(["Pedal"])).toBeNull();
  });

  it("applying replaces controls the profile uses but keeps the rest", () => {
    const next = applyControllerProfile(
      {
        "param:tempo": { status: 0xb0, data1: 0, isCc: true }, // fader 1 -> gone
        "action:stop": { status: 0x90, data1: 60, isCc: false }, // replaced by key
        "track:bass:volume": { status: 0xb1, data1: 7, isCc: true }, // kept
      },
      nano,
    );
    expect(next["param:tempo"]).toBeUndefined();
    expect(next["action:stop"].data1).toBe(42);
    expect(next["track:bass:volume"]).toBeDefined();
  });

  it("exports device bindings only and imports them back", () => {
    const profile = profileFromMappings(
      {
        "strip:1:volume": { status: 0xb0, data1: 0, isCc: true, max: 0.8 },
        "track:bass:volume": { status: 0xb1, data1: 7, isCc: true },
      },
      "My Box",
      "My Box MIDI 1",
    );
    expect(Object.keys(profile.bindings)).toEqual(["strip:1:volume"]);
    const back = parseControllerProfile(JSON.stringify(profile));
    expect(back.name).toBe("My Box");
    expect(back.bindings["strip:1:volume"].max).toBe(0.8);
    expect(back.portMatch).toEqual(["My Box MIDI 1"]);
  });

  it("rejects what is not a profile", () => {
    expect(() => parseControllerProfile("[]")).toThrow();
    expect(() => parseControllerProfile('{"version":2,"name":"x","bindings":{}}')).toThrow(/version/);
    const lenient = parseControllerProfile(
      '{"version":1,"name":"x","bindings":{"a":{"status":"no"},"track:t:mute":{"status":144,"data1":1}}}',
    );
    expect(lenient.bindings).toEqual({});
  });

  it("Mackie faders are pitch bend per channel, V-Pots relative, buttons notes", () => {
    const mackie = BUILTIN_CONTROLLER_PROFILES.find((item) => item.id === "mackie-control")!;
    expect(mackie.bindings["strip:1:volume"].status).toBe(0xe0);
    expect(mackie.bindings["strip:8:volume"].status).toBe(0xe7);
    expect(mackie.bindings["mixer:song_master:volume"].status).toBe(0xe8);
    expect(mackie.bindings["strip:2:pan"]).toMatchObject({ data1: 17, mode: "relativeSignMagnitude" });
    expect(mackie.bindings["strip:3:mute"]).toEqual({ status: 0x90, data1: 18, isCc: false });
    expect(mackie.bindings["action:play"].data1).toBe(94);
    // The SMC-Mixer is found by its own port name before the generic profile.
    expect(detectControllerProfile(["SMC-Mixer Bluetooth"])?.profile.id).toBe("mvave-smc-mixer");
    expect(detectControllerProfile(["X-Touch"])?.profile.id).toBe("mackie-control");
  });

  it("applying Mackie on top of another profile drops the controls it reuses", () => {
    const mackie = BUILTIN_CONTROLLER_PROFILES.find((item) => item.id === "mackie-control")!;
    const next = applyControllerProfile(
      { "param:tempo": { status: 0xe0, data1: 12, isCc: false } },
      mackie,
    );
    expect(next["param:tempo"]).toBeUndefined();
  });
});

