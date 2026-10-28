import { describe, expect, it } from "vitest";

import type { TempoProposal } from "@libretracks/shared/desktopApi";
import type { SongView } from "@libretracks/shared/models";
import { getBeatDurationSeconds } from "@libretracks/shared/timelineMath";

import {
  bpmFromNames,
  buildApplyPayload,
  clickTrackOptions,
  formatSongPosition,
  guideTrackOptions,
  isUnrecognised,
  keyTrackOptions,
  markersForLabels,
  placeGuideSections,
  musicTempoTrackIds,
  scaleTempoRows,
  keyStretchesAreNew,
  snapKeyChangesToSections,
  parseBpm,
  parseSignature,
  reviewRows,
  startsOnEighths,
  storedSeconds,
  tempoInView,
  tempoLevel,
  viewSeconds,
} from "./songAnalysisPlan";

const audioTrack = (id: string, name: string, kind = "audio") =>
  ({ id, name, kind, depth: 0, parentTrackId: null }) as never;

function song(): SongView {
  return {
    id: "s",
    title: "Set",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 300,
    tempoMarkers: [
      { id: "t-before", startSeconds: 50, bpm: 100 },
      { id: "t-inside", startSeconds: 130, bpm: 88 },
    ],
    timeSignatureMarkers: [{ id: "s-inside", startSeconds: 110, signature: "3/4" }],
    sectionMarkers: [],
    regions: [
      { id: "a", name: "First", startSeconds: 0, endSeconds: 100 } as never,
      { id: "b", name: "Second", startSeconds: 100, endSeconds: 200 } as never,
    ],
    tracks: [
      audioTrack("keys", "Keys"),
      audioTrack("folder", "Click folder", "folder"),
      audioTrack("metro", "Metrónomo"),
      audioTrack("guide", "Guía"),
      audioTrack("other-song", "Click"),
    ],
    clips: [
      { id: "c1", trackId: "keys", timelineStartSeconds: 100, durationSeconds: 100 } as never,
      { id: "c2", trackId: "metro", timelineStartSeconds: 100, durationSeconds: 100 } as never,
      { id: "c3", trackId: "guide", timelineStartSeconds: 100, durationSeconds: 100 } as never,
      // Only in the first song: not a candidate for the second.
      { id: "c4", trackId: "other-song", timelineStartSeconds: 0, durationSeconds: 100 } as never,
    ],
    projectRevision: 1,
  };
}

const proposal: TempoProposal = {
  tempoMarkers: [
    { startSeconds: 100.5, bpm: 92 },
  ],
  signatureMarkers: [{ startSeconds: 100.5, signature: "6/8" }],
  currentBpm: 100,
  currentSignature: "4/4",
  unchanged: false,
};

describe("clickTrackOptions", () => {
  it("offers the song's audio tracks with a click-named one first and preselected", () => {
    const { options, preselected } = clickTrackOptions(song(), "b");
    expect(options.map((option) => option.id)).toEqual(["metro", "keys", "guide"]);
    expect(preselected).toBe("metro");
  });

  it("preselects nothing when no track is named like a click", () => {
    const withoutClick = song();
    withoutClick.tracks = withoutClick.tracks.filter((track) => track.id !== "metro");
    expect(clickTrackOptions(withoutClick, "b").preselected).toBeNull();
  });
});

describe("keyTrackOptions", () => {
  it("preselects the harmonic tracks and leaves out click, guide and percussion", () => {
    const withDrums = song();
    withDrums.tracks.push(audioTrack("drums-folder", "Drums", "folder"));
    withDrums.tracks.push({
      ...(audioTrack("kick", "Kick In") as object),
      parentTrackId: "drums-folder",
    } as never);
    withDrums.tracks.push({
      ...(audioTrack("tom", "Low") as object),
      parentTrackId: "drums-folder",
    } as never);
    withDrums.clips.push(
      { id: "c5", trackId: "kick", timelineStartSeconds: 100, durationSeconds: 100 } as never,
      { id: "c6", trackId: "tom", timelineStartSeconds: 100, durationSeconds: 100 } as never,
    );
    const options = keyTrackOptions(withDrums, "b");
    expect(options.map((option) => [option.id, option.preselected])).toEqual([
      ["keys", true],
      ["metro", false],
      ["guide", false],
      ["kick", false],
      // Its own name says nothing; its folder does.
      ["tom", false],
    ]);
  });
});

describe("tempo from the music", () => {
  it("uses every track but the click and the cues", () => {
    // In the fixture: Keys, Metrónomo (click) and Guía (cue) sound in "b".
    expect(musicTempoTrackIds(song(), "b")).toEqual(["keys"]);
  });

  it("scales the song's tempo markers", () => {
    const scaled = scaleTempoRows(reviewRows(proposal), 2);
    expect(scaled.filter((row) => row.kind === "tempo").map((row) => row.text)).toEqual(["184"]);
    // Out of range stays.
    const tooFast = scaleTempoRows(scaled, 2);
    expect(tooFast.find((row) => row.kind === "tempo")?.text).toBe("184");
  });
});

describe("the tempo a multitrack names", () => {
  const named = (regionName: string, clickPath = "audio/Click.wav") => {
    const view = song();
    view.regions[1] = { ...view.regions[1], name: regionName };
    view.clips[1] = { ...view.clips[1], filePath: clickPath };
    return bpmFromNames(view, "b", "metro");
  };

  it("reads it from the song's name, however it is spelt", () => {
    expect(named("Digno de Adorar-MSM-D-71bpm")).toBe(71);
    expect(named("Es Él-Felipe S. Santos Bb 70 Bpm")).toBe(70);
    expect(named("Way Maker (68 BPM)")).toBe(68);
    expect(named("Song_92,5_bpm")).toBe(92.5);
    expect(named("Second")).toBeNull();
    expect(named("Track 2024 bpms")).toBeNull();
  });

  it("or from the folder of the click inside the song", () => {
    expect(named("Second", "audio/Digno de Adorar-MSM-D-71bpm/Click Track.wav")).toBe(71);
  });

  it("starts on the eighths reading only when the name says its tempo", () => {
    expect(startsOnEighths(71, 142, 71)).toBe(true);
    expect(startsOnEighths(70, 142, 71)).toBe(true);
    expect(startsOnEighths(142, 142, 71)).toBe(false);
    expect(startsOnEighths(null, 142, 71)).toBe(false);
    expect(startsOnEighths(71, 142, undefined)).toBe(false);
  });
});

describe("guide", () => {
  it("preselects the guide-named track", () => {
    expect(guideTrackOptions(song(), "b").preselected).toBe("guide");
  });

  it("reads the labels as a section and a cue", () => {
    expect(markersForLabels(["verse_3", "drums_in"])).toEqual({
      section: "verse:3",
      cue: "drums_in",
      ignored: false,
    });
    expect(markersForLabels(["chorus"])).toEqual({ section: "chorus", cue: "", ignored: false });
    expect(markersForLabels(["count"])).toEqual({ section: "", cue: "", ignored: true });
    // A variant the picker does not offer becomes the plain kind.
    expect(markersForLabels(["verse_9"]).section).toBe("verse");
    expect(markersForLabels(["not_a_kind"])).toEqual({ section: "", cue: "", ignored: false });
    expect(isUnrecognised(markersForLabels([]))).toBe(true);
    expect(isUnrecognised(markersForLabels(["count"]))).toBe(false);
  });

  it("a cue said with a count-in is the section", () => {
    // "Toda la banda" + "tres, cuatro" starts a section.
    expect(markersForLabels(["all_in"], true)).toEqual({
      section: "all_in",
      cue: "",
      ignored: false,
    });
    expect(markersForLabels(["all_in"])).toEqual({ section: "", cue: "all_in", ignored: false });
    // With a section named, the cue stays a cue.
    expect(markersForLabels(["bridge", "softly"], true)).toEqual({
      section: "bridge",
      cue: "softly",
      ignored: false,
    });
  });

  it("puts a cue in the section slot in the section lane", () => {
    const { analysis } = oneAnnouncement(5.3, []);
    const markers = [{ section: "all_in", cue: "", ignored: false }];
    expect(placeGuideSections(plain(), "b", 100, analysis, markers, null)).toEqual([
      { startSeconds: 106, kind: "all_in", variant: null, categoryOverride: "section" },
    ]);
  });

  const plain = () => ({ ...song(), tempoMarkers: [], timeSignatureMarkers: [] });
  const oneAnnouncement = (endSeconds: number, labels: string[]) => ({
    analysis: {
      announcements: [{ startSeconds: endSeconds - 0.5, endSeconds, group: 0 }],
      groups: [
        {
          labels,
          transcript: null,
          matchCost: null,
          occurrences: 1,
          firstStartSeconds: endSeconds - 0.5,
          firstEndSeconds: endSeconds,
        },
      ],
    },
    markers: [markersForLabels(labels)],
  });

  // One group per announcement: [start, end, labels, count words].
  const announced = (
    list: [number, number, string[], { number: number; startSeconds: number }[]?][],
  ) => ({
    analysis: {
      announcements: list.map(([startSeconds, endSeconds, , countWords], group) => ({
        startSeconds,
        endSeconds,
        group,
        countWords: countWords ?? [],
      })),
      groups: list.map(([startSeconds, endSeconds, labels]) => ({
        labels,
        transcript: null,
        matchCost: null,
        occurrences: 1,
        firstStartSeconds: startSeconds,
        firstEndSeconds: endSeconds,
      })),
    },
    markers: list.map(([, , labels]) => markersForLabels(labels)),
  });
  // 120 BPM 4/4 from the song at 100 s: beats of 0.5 s, bars of 2 s.
  const sectionsAt = (beats: number[], only = "chorus") => {
    const { analysis, markers } = announced(
      beats.map((beat) => [beat * 0.5, beat * 0.5 + 0.4, [only]]),
    );
    return placeGuideSections(plain(), "b", 100, analysis, markers, null)
      .filter((marker) => marker.kind === only)
      .map((marker) => marker.startSeconds);
  };

  it("sections announced off the click's bar in runs start a bar after the voice", () => {
    // "Poema de salvación", "Goodness of God": the song has a short bar the
    // click does not keep, and its names are said on beat 3 of the click's
    // bars until another brings them back. The click's bars stay (no 2/4):
    // the sections fall mid-bar, where the user placed them.
    expect(sectionsAt([8, 24, 42, 58, 76, 92])).toEqual([106, 114, 123, 131, 140, 148]);
  });

  it("a lone name said on beat 3 starts its section on the next downbeat", () => {
    // "Es Él": "Pre coro" two beats before its section, among names on beat 1.
    expect(sectionsAt([8, 26, 40, 56])).toEqual([106, 114, 122, 130]);
  });

  it("places short and long guide phrases on the same corrected bar grid", () => {
    const view = plain();
    const { analysis, markers } = announced([
      [0.00, 3.29, ["intro"]],
      [8.11, 8.60, ["intro"]],
      [14.60, 16.41, ["chorus", "drums_in"]],
      [40.54, 42.13, ["interlude", "all_in"]],
      [53.51, 54.33, ["verse_1"]],
      [103.79, 105.37, ["chorus", "all_in"]],
      [152.44, 154.02, ["chorus", "all_in"]],
      [243.26, 243.72, ["ending"]],
    ]);
    const placed = placeGuideSections(view, "b", 100, analysis, markers, {
      tempoMarkers: [{ startSeconds: 100, bpm: 148 }],
      signatureMarkers: [{ startSeconds: 100, signature: "4/4" }],
    });
    const bar = 4 * getBeatDurationSeconds(148, "4/4");
    const expected = [
      [2, "intro"], [6, "intro"], [10, "chorus"], [10, "drums_in"],
      [26, "interlude"], [26, "all_in"], [34, "verse"],
      [65, "chorus"], [65, "all_in"], [95, "chorus"], [95, "all_in"], [151, "ending"],
    ] as const;
    expect(placed).toHaveLength(expected.length);
    for (const [index, [bars, kind]] of expected.entries()) {
      expect(placed[index].kind).toBe(kind);
      expect(Math.abs(placed[index].startSeconds - (100 + bars * bar))).toBeLessThan(0.0005);
    }
  });

  it("a count that is a section's count-in places no count markers", () => {
    // "Poema de salvación": "Intro." before the click, then a bar of "uno, dos,
    // tres, cuatro": the voice guide counts the intro in by itself.
    const words = [0, 1, 2, 3].map((k) => ({ number: k + 1, startSeconds: 2 + k * 0.5 }));
    const { analysis, markers } = announced([
      [0.1, 0.5, ["intro"]],
      [2.0, 3.8, ["spoken_count"], words],
    ]);
    expect(
      placeGuideSections(plain(), "b", 100, analysis, markers, null).map((m) => [
        m.startSeconds,
        m.kind,
      ]),
    ).toEqual([[104, "intro"]]);
  });

  it("a cue said apart in a section's lead-in goes with that section", () => {
    // "Chorus." on beat 1, "Drums in." on beat 3 of the bar before it.
    const { analysis, markers } = announced([
      [4.0, 4.4, ["chorus"]],
      [5.0, 5.6, ["drums_in"]],
    ]);
    expect(
      placeGuideSections(plain(), "b", 100, analysis, markers, null).map((m) => [
        m.startSeconds,
        m.kind,
      ]),
    ).toEqual([
      [106, "chorus"],
      [106, "drums_in"],
    ]);
  });

  it("puts both markers of one announcement on the next downbeat", () => {
    const { analysis, markers } = oneAnnouncement(5.3, ["verse_3", "drums_in"]);
    // 120 BPM 4/4: bars of 2 s. Song at 100 s; ends at 105.3 → 106.
    expect(placeGuideSections(plain(), "b", 100, analysis, markers, null)).toEqual([
      { startSeconds: 106, kind: "verse", variant: 3, categoryOverride: null },
      { startSeconds: 106, kind: "drums_in", variant: null, categoryOverride: null },
    ]);
  });

  it("a long announcement from beat 1 that runs past the next downbeat lands on it", () => {
    // "Intro, toda la banda" in "Rey de Reyes": said from a downbeat, it
    // fills the bar and ends 0.37 beats into the next, where the band comes
    // in. 120 BPM: bars of 2 s, beats of 0.5 s; song at 100 s.
    const spoken = (startSeconds: number, endSeconds: number) => {
      const { analysis, markers } = oneAnnouncement(endSeconds, ["intro", "all_in"]);
      const withStart = {
        ...analysis,
        announcements: [{ ...analysis.announcements[0], startSeconds }],
      };
      return placeGuideSections(plain(), "b", 100, withStart, markers, null)[0]?.startSeconds;
    };
    expect(spoken(2.0, 4.18)).toBe(104);
    expect(spoken(1.96, 4.18)).toBe(104);
    // Started mid-bar: the end still decides.
    expect(spoken(2.6, 4.18)).toBe(106);
    // Running more than half a beat past is the next bar.
    expect(spoken(2.0, 4.3)).toBe(106);
    // Ending before the downbeat, as usual.
    expect(spoken(2.0, 3.6)).toBe(104);
  });

  it("a section said a bar before its count-in comes after the count", () => {
    // Real (Es Él): "Intro." on the pickup, then "uno", "dos", "tres,
    // cuatro" over the whole next bar; the intro landed on the count's
    // first beat. 120 BPM: bars of 2 s; song at 100 s.
    const fragment = (startSeconds: number, endSeconds: number, group: number) => ({
      startSeconds,
      endSeconds,
      group,
    });
    const group = (labels: string[]) => ({
      labels,
      transcript: null,
      matchCost: null,
      occurrences: 1,
      firstStartSeconds: 0,
      firstEndSeconds: 0,
    });
    const analysis = {
      announcements: [
        fragment(0.6, 1.1, 0),
        fragment(2.0, 2.3, 1),
        fragment(2.5, 2.8, 1),
        fragment(3.0, 3.8, 1),
        // A cue said well after the count is not part of it.
        fragment(9.3, 9.8, 2),
      ],
      groups: [group(["intro"]), group(["count"]), group(["ease_down"])],
    };
    const markers = analysis.groups.map((g) => markersForLabels(g.labels));
    expect(
      placeGuideSections(plain(), "b", 100, analysis, markers, null).map((m) => [
        m.startSeconds,
        m.kind,
      ]),
    ).toEqual([
      [104, "intro"],
      [108, "ease_down"],
    ]);
  });

  it("a cue said on its own warns a bar before the downbeat", () => {
    // Real: "Bajar intensidad" landed on the drop itself, where the voice
    // guide speaks it too late. 105.3 → downbeat 106 → a bar before, 104.
    const { analysis, markers } = oneAnnouncement(5.3, ["ease_down"]);
    expect(placeGuideSections(plain(), "b", 100, analysis, markers, null)).toEqual([
      { startSeconds: 104, kind: "ease_down", variant: null, categoryOverride: null },
    ]);
  });

  it("a count said on its own puts each number on its beat", () => {
    expect(markersForLabels(["spoken_count"])).toEqual({ section: "", cue: "count", ignored: false });
    // "1 . 2 . | 1 2 3 4" at 120 BPM from the song start (100 s), the words
    // a little off the beats as the voice says them.
    const { analysis, markers } = oneAnnouncement(3.6, ["spoken_count"]);
    const countWords = [
      { number: 1, startSeconds: 0.02 },
      { number: 2, startSeconds: 1.03 },
      { number: 1, startSeconds: 1.98 },
      { number: 2, startSeconds: 2.49 },
      { number: 3, startSeconds: 2.93 },
      { number: 4, startSeconds: 3.47 },
    ];
    const withWords = {
      ...analysis,
      announcements: [{ ...analysis.announcements[0], countWords }],
    };
    expect(
      placeGuideSections(plain(), "b", 100, withWords, markers, null).map((m) => [
        m.startSeconds,
        m.kind,
        m.variant,
      ]),
    ).toEqual([
      [100, "count", 1],
      [101, "count", 2],
      [102, "count", 1],
      [102.5, "count", 2],
      [103, "count", 3],
      [103.5, "count", 4],
    ]);
  });

  it("a second section of one announcement goes in the cue lane", () => {
    // "Verso a capella": two sections cannot share a spot.
    expect(markersForLabels(["verse", "acapella"])).toEqual({
      section: "verse",
      cue: "acapella",
      ignored: false,
    });
    const { analysis, markers } = oneAnnouncement(5.3, ["verse", "acapella"]);
    expect(placeGuideSections(plain(), "b", 100, analysis, markers, null)).toEqual([
      { startSeconds: 106, kind: "verse", variant: null, categoryOverride: null },
      { startSeconds: 106, kind: "acapella", variant: null, categoryOverride: "cue" },
    ]);
  });

  it("two announcements naming sections on one downbeat: the later is a cue", () => {
    const analysis = {
      announcements: [
        { startSeconds: 4.0, endSeconds: 4.5, group: 0 },
        { startSeconds: 4.8, endSeconds: 5.3, group: 1 },
      ],
      groups: [0, 1].map(() => ({
        labels: [],
        transcript: null,
        matchCost: null,
        occurrences: 1,
        firstStartSeconds: 4,
        firstEndSeconds: 5.3,
      })),
    };
    const markers = [markersForLabels(["chorus"]), markersForLabels(["tag"])];
    expect(
      placeGuideSections(plain(), "b", 100, analysis, markers, null).map((m) => [
        m.kind,
        m.categoryOverride,
      ]),
    ).toEqual([
      ["chorus", null],
      ["tag", "cue"],
    ]);
  });

  it("a word's tail just past the downbeat still lands on it", () => {
    // "…cuatro" ends 50 ms after the downbeat at 106 (measured on a real
    // guide against markers placed by hand): the section is at 106, not 108.
    const { analysis, markers } = oneAnnouncement(6.05, ["intro"]);
    expect(placeGuideSections(plain(), "b", 100, analysis, markers, null)[0].startSeconds).toBe(106);
  });

  it("a guide that speaks two bars ahead puts the section a bar later", () => {
    const { analysis, markers } = oneAnnouncement(5.3, ["intro"]);
    expect(placeGuideSections(plain(), "b", 100, analysis, markers, null, 2)[0].startSeconds).toBe(
      108,
    );
  });

  it("follows the tempo the review is about to write", () => {
    const { analysis, markers } = oneAnnouncement(5.3, ["intro"]);
    const tempo = {
      tempoMarkers: [{ startSeconds: 100, bpm: 60 }],
      signatureMarkers: [{ startSeconds: 100, signature: "4/4" }],
    };
    // 60 BPM: bars of 4 s from 100 → 108.
    expect(placeGuideSections(plain(), "b", 100, analysis, markers, tempo)[0].startSeconds).toBe(108);
  });

  it("follows a ramp the review is about to write", () => {
    // 60 → 120 over 10 s from the song start: bar 2 (4 quarters) comes at
    // 60·t + 3·t² = 240, sooner than the 4 s a steady 60 would take.
    const { analysis, markers } = oneAnnouncement(3.0, ["intro"]);
    const tempo = {
      tempoMarkers: [
        { startSeconds: 100, bpm: 60, ramp: true },
        { startSeconds: 110, bpm: 120 },
      ],
      signatureMarkers: [{ startSeconds: 100, signature: "4/4" }],
    };
    const [placed] = placeGuideSections(plain(), "b", 100, analysis, markers, tempo);
    expect(placed.startSeconds).toBeCloseTo(100 + (-60 + Math.sqrt(3600 + 2880)) / 6, 3);
  });

  it("follows the tempo the review writes for a song at the session start", () => {
    // "Bienvenido Espíritu Santo": first song at 0, the session at 120 and
    // the click at 98. A marker at 0 is the song's own tempo; the markers
    // used to land on the 120 grid (8 s, 28 s…) instead of 98's (9.796…).
    const { analysis, markers } = oneAnnouncement(9.5, ["intro"]);
    const tempo = {
      tempoMarkers: [{ startSeconds: 0, bpm: 98 }],
      signatureMarkers: [],
    };
    const [placed] = placeGuideSections(plain(), "a", 0, analysis, markers, tempo);
    expect(placed.startSeconds).toBeCloseTo((4 * 4 * 60) / 98, 3);
  });
});

describe("parsing the edited values", () => {
  it("accepts BPMs in the app's range, comma or point", () => {
    expect(parseBpm("92,5")).toBe(92.5);
    expect(parseBpm(" 120 ")).toBe(120);
    expect(parseBpm("10")).toBeNull();
    expect(parseBpm("abc")).toBeNull();
  });

  it("accepts real meters only", () => {
    expect(parseSignature(" 6 / 8 ")).toBe("6/8");
    expect(parseSignature("7/4")).toBe("7/4");
    expect(parseSignature("4/3")).toBeNull();
    expect(parseSignature("0/4")).toBeNull();
  });

  it("formats positions from the song start", () => {
    expect(formatSongPosition(65.27)).toBe("1:05.3");
    expect(formatSongPosition(0)).toBe("0:00.0");
  });
});

describe("buildApplyPayload", () => {
  it("sends the edited values of both kinds", () => {
    const rows = reviewRows(proposal).map((row) =>
      row.kind === "tempo" && row.index === 0 ? { ...row, text: "93" } : row,
    );
    expect(buildApplyPayload(song(), "b", rows, { tempo: true, signature: true })).toEqual({
      tempoMarkers: [
        { startSeconds: 100.5, bpm: 93 },
      ],
      signatureMarkers: [{ startSeconds: 100.5, signature: "6/8" }],
    });
  });

  it("keeps the song's own markers of the kind left out, since apply replaces both", () => {
    const payload = buildApplyPayload(song(), "b", reviewRows(proposal), {
      tempo: false,
      signature: true,
    });
    expect(payload?.tempoMarkers).toEqual([
      { startSeconds: 130, bpm: 88 },
    ]);
    const signatureOnly = buildApplyPayload(song(), "b", reviewRows(proposal), {
      tempo: true,
      signature: false,
    });
    expect(signatureOnly?.signatureMarkers).toEqual([
      { startSeconds: 110, signature: "3/4" },
    ]);
  });

  it("refuses to build while a value is invalid", () => {
    const rows = reviewRows(proposal).map((row) =>
      row.kind === "signature" ? { ...row, text: "6/7" } : row,
    );
    expect(buildApplyPayload(song(), "b", rows, { tempo: true, signature: true })).toBeNull();
  });
});

describe("warped song", () => {
  // Recorded 100–150 s; warped to play 1.2 times as long, starting at 90 s
  // (a faster song before it): it plays 90–150 s.
  const timeline = {
    regionStartSeconds: 100,
    regionEndSeconds: 150,
    renderStartSeconds: 90,
    viewScale: 1.2,
  };

  it("maps recorded seconds to the song as it plays and back", () => {
    expect(viewSeconds(timeline, 100)).toBe(90);
    expect(viewSeconds(timeline, 110)).toBeCloseTo(102);
    // After it: shifted by where it ends.
    expect(viewSeconds(timeline, 160)).toBeCloseTo(160);
    for (const seconds of [95, 100, 110, 149, 160]) {
      expect(storedSeconds(timeline, viewSeconds(timeline, seconds))).toBeCloseTo(seconds);
    }
  });

  it("places the proposed tempo map where it plays, BPM untouched", () => {
    const inView = tempoInView(
      {
        tempoMarkers: [{ startSeconds: 110, bpm: 96 }],
        signatureMarkers: [{ startSeconds: 100, signature: "4/4" }],
      },
      timeline,
    );
    expect(inView.tempoMarkers[0].startSeconds).toBeCloseTo(102);
    expect(inView.tempoMarkers[0].bpm).toBe(96);
    expect(inView.signatureMarkers[0].startSeconds).toBe(90);
  });

  it("keeps the song's own markers at their recorded seconds", () => {
    // The timeline shows the 3/4 at 110 s as it plays; it is stored at 116.67.
    const shown = { ...timeline, regionStartSeconds: 100, renderStartSeconds: 100 };
    const payload = buildApplyPayload(
      song(),
      "b",
      reviewRows(proposal),
      { tempo: true, signature: false },
      shown,
    );
    expect(payload?.signatureMarkers[0].startSeconds).toBeCloseTo(100 + 10 / 1.2);
  });
});


describe("snapKeyChangesToSections", () => {
  it("puts a key change on a section start a few seconds away", () => {
    expect(
      snapKeyChangesToSections([{ startSeconds: 178, key: "E" }], [120, 176.4, 200]),
    ).toEqual([{ startSeconds: 176.4, key: "E" }]);
  });

  it("leaves it where it was found with no section near", () => {
    expect(
      snapKeyChangesToSections([{ startSeconds: 178, key: "E" }], [120, 183]),
    ).toEqual([{ startSeconds: 178, key: "E" }]);
  });
});

describe("keyStretchesAreNew", () => {
  const stretches = [
    { startSeconds: 0, key: "D" },
    { startSeconds: 178, key: "E" },
  ];
  const song = (keyChanges: { id: string; startSeconds: number; key: string }[]) => ({
    key: "D",
    startSeconds: 100,
    keyChanges,
  });

  it("a song already in its key but without the change has something new", () => {
    expect(keyStretchesAreNew(song([]), stretches)).toBe(true);
  });

  it("the same change already there (give or take a few seconds) is nothing new", () => {
    expect(keyStretchesAreNew(song([{ id: "up", startSeconds: 276.4, key: "E" }]), stretches)).toBe(false);
  });

  it("a song that does not modulate never asks for key changes", () => {
    expect(keyStretchesAreNew(song([]), [{ startSeconds: 0, key: "D" }])).toBe(false);
  });
});
