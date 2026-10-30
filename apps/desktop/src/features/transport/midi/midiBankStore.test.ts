import { describe, expect, it } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import { hasStripMappings, midiStripOrder } from "./midiBankStore";

const track = (
  id: string,
  extra: { kind?: string; parentTrackId?: string; collapsed?: boolean } = {},
) => ({ id, kind: "audio", parentTrackId: null, ...extra });

describe("midiBankStore", () => {
  it("orders strips like the mixer, skipping video and folded children", () => {
    const song = {
      tracks: [
        track("drums", { kind: "folder", collapsed: true }),
        track("kick", { parentTrackId: "drums" }),
        track("bass"),
        track("vid", { kind: "video" }),
        track("keys", { kind: "folder" }),
        track("pad", { parentTrackId: "keys" }),
        track("click", { kind: "midi" }),
      ],
    } as unknown as SongView;
    expect(midiStripOrder(song)).toEqual(["drums", "bass", "keys", "pad", "click"]);
    expect(midiStripOrder(null)).toEqual([]);
  });

  it("is active only with a strip binding", () => {
    expect(hasStripMappings({ "action:play": {} })).toBe(false);
    expect(hasStripMappings({ "strip:1:volume": {} })).toBe(true);
  });
});
