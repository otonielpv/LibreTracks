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

  it("gives a clip that spills into the next song only to the song it mostly lives in", () => {
    const previous = testRegion("r0", { startSeconds: 0, endSeconds: 100 });
    const next = testRegion("r2", { startSeconds: 200, endSeconds: 300 });
    const content = computeSongTrackContent(
      song({
        regions: [previous, region, next],
        clips: [
          // A folder of stems from the previous song whose tails run 5 s in.
          { trackId: "prev-tail", timelineStartSeconds: 0, durationSeconds: 105 },
          // Starts a hair early, but it is this song's.
          { trackId: "early", timelineStartSeconds: 99.9, durationSeconds: 100 },
          { trackId: "in", timelineStartSeconds: 150, durationSeconds: 10 },
          // This song's tail running into the next one still counts here.
          { trackId: "own-tail", timelineStartSeconds: 120, durationSeconds: 90 },
        ] as SongView["clips"],
        videoClips: [{ trackId: "prev-video", timelineStartSeconds: 10, durationSeconds: 95 }] as SongView["videoClips"],
      }),
      region,
    );
    expect([...content.trackIds].sort()).toEqual(["early", "in", "own-tail"]);
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
