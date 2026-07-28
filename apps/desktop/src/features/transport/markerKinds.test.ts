import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CUE_KINDS,
  MARKER_KINDS,
  availableCueKinds,
  availableSectionKinds,
} from "./markerKinds";

/** The bundled voice pack, relative to this file. */
const VOICES = join(
  __dirname,
  "../../../src-tauri/resources/voices",
);

const LANGS = ["es", "en"] as const;

function clipPath(lang: string, folder: "sections" | "cues", kind: string) {
  return join(VOICES, lang, folder, `${kind}.wav`);
}

// The menus are the only thing standing between a user and a silent marker:
// picking a kind with no recording creates a marker the engine announces as
// silence (section_for/cue_for return nullptr). These tests tie the offered
// vocabulary to the files actually shipped.
describe("marker kinds offered vs recordings on disk", () => {
  for (const lang of LANGS) {
    it(`every section offered in ${lang} has a recording`, () => {
      const missing = availableSectionKinds()
        .filter((kind) => kind !== "custom")
        .filter((kind) => !existsSync(clipPath(lang, "sections", kind)));
      expect(missing).toEqual([]);
    });

    it(`every cue offered in ${lang} has a recording`, () => {
      const missing = availableCueKinds(lang).filter(
        (kind) => !existsSync(clipPath(lang, "cues", kind)),
      );
      expect(missing).toEqual([]);
    });
  }

  // Guards the opposite mistake: a clip is added to the pack but the kind stays
  // hidden, so nobody can ever pick it.
  for (const lang of LANGS) {
    it(`no recorded section is hidden from the ${lang} menu`, () => {
      const offered = new Set(availableSectionKinds());
      const hiddenButRecorded = MARKER_KINDS.filter(
        (kind) =>
          kind !== "custom" &&
          !offered.has(kind) &&
          existsSync(clipPath(lang, "sections", kind)),
      );
      expect(hiddenButRecorded).toEqual([]);
    });

    it(`no recorded cue is hidden from the ${lang} menu`, () => {
      const offered = new Set(availableCueKinds(lang));
      const hiddenButRecorded = CUE_KINDS.filter(
        (kind) => !offered.has(kind) && existsSync(clipPath(lang, "cues", kind)),
      );
      expect(hiddenButRecorded).toEqual([]);
    });
  }

  it("keeps Custom available (it is an untyped marker, no clip by design)", () => {
    for (const lang of LANGS) {
      expect(availableSectionKinds()).toContain("custom");
    }
  });
});
