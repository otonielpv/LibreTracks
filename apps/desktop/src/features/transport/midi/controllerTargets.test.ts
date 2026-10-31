import { describe, expect, it } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import i18n from "../../../shared/i18n";
import {
  describeMidiTarget,
  isOtherSessionTarget,
  mixerLearnKeys,
  sceneLearnKeys,
} from "./controllerTargets";

const song = {
  tracks: [],
  mixScenes: [{ id: "s1", name: "Ministrar", rampSeconds: 2, rules: [] }],
} as unknown as SongView;

describe("scene MIDI targets (plan live-scenes, paso 05)", () => {
  it("names scene targets in Spanish and English", () => {
    const es = i18n.getFixedT("es");
    const en = i18n.getFixedT("en");
    expect(describeMidiTarget("scene:s1:toggle", es, song)).toBe("Escena «Ministrar» (alternar)");
    expect(describeMidiTarget("scene:s1:apply", es, song)).toBe("Escena «Ministrar» (poner)");
    expect(describeMidiTarget("scene:s1:restore", en, song)).toBe("Scene “Ministrar” (release)");
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
