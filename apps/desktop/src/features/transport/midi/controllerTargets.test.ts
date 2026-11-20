import { describe, expect, it } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import i18n from "../../../shared/i18n";
import {
  describeMidiTarget,
  eqControl,
  isOtherSessionTarget,
  parseEqControl,
  trackIdOfTarget,
  mixerLearnKeys,
  sceneLearnKeys,
} from "./controllerTargets";

const song = {
  tracks: [],
  mixScenes: [{ id: "s1", name: "Banda baja", rampSeconds: 2, rules: [] }],
} as unknown as SongView;

describe("scene MIDI targets (plan live-scenes, paso 05)", () => {
  it("names scene targets in Spanish and English", () => {
    const es = i18n.getFixedT("es");
    const en = i18n.getFixedT("en");
    expect(describeMidiTarget("scene:s1:toggle", es, song)).toBe("Escena «Banda baja» (alternar)");
    expect(describeMidiTarget("scene:s1:apply", es, song)).toBe("Escena «Banda baja» (poner)");
    expect(describeMidiTarget("scene:s1:restore", en, song)).toBe("Scene “Banda baja” (release)");
    expect(describeMidiTarget("scene_slot:3", es, song)).toBe("Escena 3 (alternar)");
    expect(describeMidiTarget("scene_slot:3", en, song)).toBe("Scene 3 (toggle)");
    expect(describeMidiTarget("scene:gone:toggle", es, song)).toBe("Escena de otra sesión");
    expect(describeMidiTarget("scene:s1:foo", es, song)).toBeNull();
  });

  it("flags scenes of another session", () => {
    expect(isOtherSessionTarget("scene:gone:toggle", song)).toBe(true);
    expect(isOtherSessionTarget("scene:s1:toggle", song)).toBe(false);
    expect(isOtherSessionTarget("scene_slot:1", song)).toBe(false);
  });

  it("the Scenes view lists each scene's three targets, then slots 1-8", () => {
    const slots = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `scene_slot:${n}`);
    expect(sceneLearnKeys(song)).toEqual([
      "scene:s1:toggle",
      "scene:s1:apply",
      "scene:s1:restore",
      ...slots,
    ]);
    expect(sceneLearnKeys(null)).toEqual(slots);
    expect(mixerLearnKeys().some((key) => key.startsWith("scene"))).toBe(false);
  });
});

describe("EQ MIDI targets (plan track-eq-2, paso 05)", () => {
  const withTrack = {
    tracks: [{ id: "song:a:voz", name: "Voz", kind: "audio" }],
    mixScenes: [],
  } as unknown as SongView;

  it("names each eq control of a track, also when its id has colons", () => {
    const es = i18n.getFixedT("es");
    const en = i18n.getFixedT("en");
    expect(describeMidiTarget("track:song:a:voz:eq3gain", es, withTrack)).toBe(
      "Voz · EQ banda 3: ganancia",
    );
    expect(describeMidiTarget("track:song:a:voz:eq1freq", en, withTrack)).toBe(
      "Voz · EQ band 1: frequency",
    );
    expect(describeMidiTarget("track:song:a:voz:eq6q", es, withTrack)).toBe("Voz · EQ banda 6: Q");
    expect(describeMidiTarget("track:song:a:voz:eq2on", es, withTrack)).toBe(
      "Voz · EQ banda 2: encendida",
    );
    expect(describeMidiTarget("track:song:a:voz:eqon", en, withTrack)).toBe("Voz · EQ on");
    expect(trackIdOfTarget("track:song:a:voz:eq3gain")).toBe("song:a:voz");
  });

  it("rejects bands out of range and eq on a strip", () => {
    const es = i18n.getFixedT("es");
    expect(describeMidiTarget("track:voz:eq7gain", es, withTrack)).toBeNull();
    expect(describeMidiTarget("track:voz:eq0gain", es, withTrack)).toBeNull();
    expect(describeMidiTarget("strip:1:eq3gain", es, withTrack)).toBeNull();
    expect(eqControl(2, "gain")).toBe("eq3gain");
    expect(parseEqControl("eqon")).toBe("all");
    expect(parseEqControl("eq4freq")).toEqual([3, "freq"]);
  });
});
