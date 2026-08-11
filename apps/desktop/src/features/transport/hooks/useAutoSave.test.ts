import { describe, expect, it } from "vitest";

import { shouldAutoSave } from "./useAutoSave";

const base = {
  enabled: true,
  revision: 5,
  lastSavedRevision: 4,
  songFilePath: "D:/sessions/set/set.ltsession",
  isPlaying: false,
  isSaving: false,
};

describe("shouldAutoSave", () => {
  it("saves when the project changed since the last save", () => {
    expect(shouldAutoSave(base)).toBe(true);
  });

  it("skips when nothing changed since the last save", () => {
    // The whole point of tracking the revision: an idle session must not
    // rewrite the same bytes every interval.
    expect(shouldAutoSave({ ...base, lastSavedRevision: 5 })).toBe(false);
  });

  it("skips while the transport is playing", () => {
    // save_project runs synchronously under the session lock; writing during a
    // performance risks an audible hiccup.
    expect(shouldAutoSave({ ...base, isPlaying: true })).toBe(false);
  });

  it("skips when the session has never been saved to disk", () => {
    // No path means saveProject would need a "Save as..." dialog, which must
    // never appear on its own.
    expect(shouldAutoSave({ ...base, songFilePath: null })).toBe(false);
    expect(shouldAutoSave({ ...base, songFilePath: "" })).toBe(false);
  });

  it("skips when a previous autosave is still running", () => {
    expect(shouldAutoSave({ ...base, isSaving: true })).toBe(false);
  });

  it("skips when the setting is off", () => {
    expect(shouldAutoSave({ ...base, enabled: false })).toBe(false);
  });

  it("saves a freshly opened session that already has pending changes", () => {
    // lastSavedRevision is seeded to -1, which no real revision equals.
    expect(shouldAutoSave({ ...base, revision: 0, lastSavedRevision: -1 })).toBe(
      true,
    );
  });
});
