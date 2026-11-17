import { describe, expect, it } from "vitest";

import reference from "./fixtures/drumLoopsReference.json";
import type {
  DrumKitRef,
  DrumSampleRef,
  LoopLiveState,
  LoopPatternError,
  OneShotSet,
  RegionLoop,
} from "./models";

// El mismo JSON lo comprueba el core en Rust (`drum_loops_tests.rs`). Las
// asignaciones tipadas fallan en `tsc` si un nombre de campo diverge; los
// `expect` comprueban que cada campo del JSON existe en el tipo.
const regionLoop: RegionLoop = reference.regionLoop as RegionLoop;
const libraryKitRef: DrumKitRef = reference.libraryKitRef as DrumKitRef;
const userSample: DrumSampleRef = reference.userSample as DrumSampleRef;
const liveState: LoopLiveState = reference.liveState;
const oneShotSet: OneShotSet = reference.oneShotSet as OneShotSet;
const patternError: LoopPatternError = reference.patternError as LoopPatternError;

/** Las claves que el tipo TS declara, comprobadas en tiempo de compilación. */
function keysOf<T>(keys: (keyof T)[]): string[] {
  return keys as string[];
}

describe("drum loops shape", () => {
  it("region loop keys match the Rust JSON", () => {
    expect(Object.keys(reference.regionLoop).sort()).toEqual(
      keysOf<RegionLoop>(["autostart", "initialRows", "pattern"]).sort(),
    );
    expect(Object.keys(reference.regionLoop.pattern).sort()).toEqual(
      keysOf<RegionLoop["pattern"]>([
        "bars",
        "bpm",
        "id",
        "kit",
        "name",
        "rows",
        "signature",
        "stepsPerBeat",
        "swing",
      ]).sort(),
    );
    expect(Object.keys(reference.regionLoop.pattern.rows[0]).sort()).toEqual(
      keysOf<RegionLoop["pattern"]["rows"][number]>(["gainDb", "soundId", "variations"]).sort(),
    );
    const kit = regionLoop.pattern.kit;
    expect(kit.kind).toBe("embedded");
    if (kit.kind === "embedded") {
      expect(Object.keys(reference.regionLoop.pattern.kit.kit.sounds[0]).sort()).toEqual(
        keysOf<(typeof kit.kit.sounds)[number]>([
          "chokeGroup",
          "color",
          "gainDb",
          "id",
          "name",
          "sample",
        ]).sort(),
      );
      expect(kit.kit.sounds[0].sample.source).toEqual({ kind: "pack", packId: "latin" });
    }
  });

  it("kit refs, samples, live state, one shots and errors match", () => {
    expect(libraryKitRef).toEqual({ kind: "library", kitId: "basic" });
    expect(userSample.source.kind).toBe("user");
    expect(Object.keys(liveState).sort()).toEqual(
      keysOf<LoopLiveState>(["patternId", "playing", "rows"]).sort(),
    );
    const pad = oneShotSet.banks[0].pads[0];
    expect(pad).not.toBeNull();
    expect(Object.keys(pad!).sort()).toEqual(
      keysOf<NonNullable<typeof pad>>([
        "chokeGroup",
        "color",
        "gainDb",
        "id",
        "mode",
        "name",
        "quantize",
        "sample",
      ]).sort(),
    );
    expect(oneShotSet.banks[0].pads[1]).toBeNull();
    expect(patternError).toEqual({ code: "unknownSound", soundId: "x" });
  });
});
