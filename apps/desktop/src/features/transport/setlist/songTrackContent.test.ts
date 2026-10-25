import { describe, expect, it } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import { computeSongTrackContent } from "./songTrackContent";
import { testRegion } from "./testBindings";

const region = testRegion("r1", { startSeconds: 100, endSeconds: 200 });

const song = (parts: Partial<SongView>) =>
  ({ clips: [], midiClips: [], videoClips: [], automationCues: [], ...parts }) as SongView;

describe("computeSongTrackContent", () => {
  it("counts audio clips that overlap the song", () => {
    const content = computeSongTrackContent(
      song({
        clips: [
          { trackId: "in", timelineStartSeconds: 150, durationSeconds: 10 },
          { trackId: "spills-in", timelineStartSeconds: 90, durationSeconds: 20 },
          { trackId: "before", timelineStartSeconds: 50, durationSeconds: 50 },
          { trackId: "after", timelineStartSeconds: 200, durationSeconds: 5 },
        ] as SongView["clips"],
      }),
      region,
    );
    expect([...content.trackIds].sort()).toEqual(["in", "spills-in"]);
  });

  it("counts MIDI clips by their start and video clips by overlap", () => {
    const content = computeSongTrackContent(
      song({
        midiClips: [
          { trackId: "keys", timelineStartSeconds: 120 },
          { trackId: "keys-other", timelineStartSeconds: 220 },
        ] as SongView["midiClips"],
        videoClips: [{ trackId: "video", timelineStartSeconds: 80, durationSeconds: 40 }] as SongView["videoClips"],
      }),
      region,
    );
    expect([...content.trackIds].sort()).toEqual(["keys", "video"]);
  });

  it("reports the automation lane apart", () => {
    expect(
      computeSongTrackContent(song({ automationCues: [{ atSeconds: 150 }] as SongView["automationCues"] }), region)
        .hasAutomation,
    ).toBe(true);
    expect(
      computeSongTrackContent(song({ automationCues: [{ atSeconds: 250 }] as SongView["automationCues"] }), region)
        .hasAutomation,
    ).toBe(false);
  });

  it("survives snapshots without MIDI, video or automation", () => {
    const content = computeSongTrackContent({ clips: [] } as unknown as SongView, region);
    expect(content.trackIds.size).toBe(0);
    expect(content.hasAutomation).toBe(false);
  });
});
