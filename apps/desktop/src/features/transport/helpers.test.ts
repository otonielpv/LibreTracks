import { describe, expect, it } from "vitest";

import type {
  ClipSummary,
  MidiBinding,
  SectionMarkerSummary,
  SongRegionSummary,
  SongView,
  TrackSummary,
} from "./desktopApi";
import type {
  NativeDropCandidateDebug,
  OptimisticClipOperation,
} from "./types";
import {
  buildAudioRoutingOptions,
  buildMemoizedClipsByTrack,
  buildVisibleTracks,
  clamp,
  clipDisplayName,
  filterOutputChannelsForOutputCount,
  findClip,
  findPreviousFolderTrack,
  findSection,
  findMidiMappingKeyForMessage,
  findTrack,
  formatAudioRouteLabel,
  formatBpmDraft,
  formatClock,
  formatCompactTime,
  formatMidiBinding,
  humanizeLibraryTrackName,
  isAudioDeviceVisibleForBackend,
  isTrackDescendant,
  keyboardDigit,
  libraryAssetFileName,
  mergeOptimisticClipsByTrack,
  normalizeEnabledOutputChannelsForOutputCount,
  resolveMarkerShortcut,
  resolveNativeAudioImportPayloads,
  resolveRegionShortcut,
  selectNativeDropCandidate,
  trackChildrenCount,
} from "./helpers";

// A translator that echoes the defaultValue so label tests stay i18n-agnostic.
const t = (_key: string, options?: Record<string, unknown>) =>
  String(options?.defaultValue ?? _key);

function makeTrack(overrides: Partial<TrackSummary> = {}): TrackSummary {
  return {
    id: "t1",
    name: "Track",
    kind: "audio",
    parentTrackId: null,
    depth: 0,
    hasChildren: false,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    audioTo: "master",
    transposeEnabled: false,
    ...overrides,
  };
}

function makeClip(overrides: Partial<ClipSummary> = {}): ClipSummary {
  return {
    id: "c1",
    trackId: "t1",
    trackName: "Track",
    filePath: "C:/audio/loop.wav",
    waveformKey: "w1",
    isMissing: false,
    timelineStartSeconds: 0,
    sourceStartSeconds: 0,
    sourceWindowDurationSeconds: 4,
    sourceDurationSeconds: 4,
    durationSeconds: 4,
    gain: 1,
    ...overrides,
  };
}

function makeSong(overrides: Partial<SongView> = {}): SongView {
  return {
    id: "s",
    title: "S",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 60,
    tempoMarkers: [],
    timeSignatureMarkers: [],
    regions: [],
    sectionMarkers: [],
    clips: [],
    tracks: [],
    projectRevision: 1,
    ...overrides,
  };
}

function makeCandidate(
  overrides: Partial<NativeDropCandidateDebug>,
): NativeDropCandidateDebug {
  return {
    label: "raw",
    clientX: 0,
    clientY: 0,
    elementFromPoint: null,
    laneBounds: null,
    rulerBounds: null,
    dropSeconds: 0,
    rawSeconds: 0,
    snappedSeconds: 0,
    rawLeftPx: null,
    rawClientX: null,
    snappedLeftPx: null,
    snappedClientX: null,
    previewLeftPx: null,
    previewClientX: null,
    rawDeltaPx: null,
    score: 0,
    isOverTimeline: true,
    ...overrides,
  } as NativeDropCandidateDebug;
}

describe("selectNativeDropCandidate", () => {
  it("returns null when no candidate is over the timeline", () => {
    expect(
      selectNativeDropCandidate([
        makeCandidate({ isOverTimeline: false, dropSeconds: 1 }),
      ]),
    ).toBeNull();
  });

  it("prefers the smallest pointer delta", () => {
    const winner = makeCandidate({ rawDeltaPx: 2, dropSeconds: 5, score: 1 });
    const result = selectNativeDropCandidate([
      makeCandidate({ rawDeltaPx: 10, dropSeconds: 3, score: 9 }),
      winner,
    ]);
    expect(result).toBe(winner);
  });

  it("breaks delta ties by higher score", () => {
    const winner = makeCandidate({ rawDeltaPx: 4, dropSeconds: 1, score: 8 });
    const result = selectNativeDropCandidate([
      winner,
      makeCandidate({ rawDeltaPx: 4, dropSeconds: 2, score: 2 }),
    ]);
    expect(result).toBe(winner);
  });

  it("ignores candidates without a drop position", () => {
    expect(
      selectNativeDropCandidate([makeCandidate({ dropSeconds: null })]),
    ).toBeNull();
  });
});

describe("isAudioDeviceVisibleForBackend", () => {
  it("hides ASIO devices when no backend is selected", () => {
    expect(isAudioDeviceVisibleForBackend({ backend: "asio" }, null)).toBe(
      false,
    );
    expect(isAudioDeviceVisibleForBackend({ backend: "wasapi" }, null)).toBe(
      true,
    );
  });

  it("matches the selected backend exactly", () => {
    expect(isAudioDeviceVisibleForBackend({ backend: "asio" }, "asio")).toBe(
      true,
    );
    expect(isAudioDeviceVisibleForBackend({ backend: "wasapi" }, "asio")).toBe(
      false,
    );
  });
});

describe("formatAudioRouteLabel", () => {
  it("labels inherit, master, mono and stereo external routes", () => {
    expect(formatAudioRouteLabel("inherit", t)).toBe("Inherited (Folder)");
    expect(formatAudioRouteLabel("master", t)).toBe("Master");
    expect(formatAudioRouteLabel("ext:0", t)).toBe("Out 1");
    expect(formatAudioRouteLabel("ext:2-3", t)).toBe("Out 3/4");
  });

  it("passes through unknown routes verbatim", () => {
    expect(formatAudioRouteLabel("weird", t)).toBe("weird");
  });
});

describe("output channel filtering", () => {
  it("dedupes, floors, sorts, and bounds by output count", () => {
    expect(filterOutputChannelsForOutputCount([3, 1, 1, 0, 2.9], 4)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(filterOutputChannelsForOutputCount([0, 1, 8], 2)).toEqual([0, 1]);
  });

  it("falls back to provided fallback then to [0] when empty", () => {
    expect(normalizeEnabledOutputChannelsForOutputCount([99], 2)).toEqual([
      0, 1,
    ]);
    expect(normalizeEnabledOutputChannelsForOutputCount([99], 1, [5])).toEqual([
      0,
    ]);
  });
});

describe("buildAudioRoutingOptions", () => {
  it("always starts with master and pairs adjacent channels as stereo", () => {
    const options = buildAudioRoutingOptions([0, 1, 3], t);
    const values = options.map((o) => o.value);
    expect(values[0]).toBe("master");
    expect(values).toContain("ext:0-1");
    expect(values).toContain("ext:0");
    expect(values).toContain("ext:1");
    expect(values).toContain("ext:3");
    expect(values).not.toContain("ext:1-2");
  });

  // Regresión: interfaces multicanal tipo Behringer UMC204HD (4 salidas =
  // dos pares estéreo). El usuario debe ver tanto "Ext. Out 1/2" como
  // "Ext. Out 3/4" para poder enrutar multitracks en estéreo a la segunda
  // salida. Si el engine solo reporta 2 canales (WASAPI shared en vez de
  // ASIO), el par 3/4 desaparece — ese es el síntoma reportado.
  it("exposes both stereo pairs for a 4-output interface", () => {
    const values = buildAudioRoutingOptions([0, 1, 2, 3], t).map((o) => o.value);
    // Los dos pares físicos estéreo: Out 1/2 y Out 3/4.
    expect(values).toContain("ext:0-1");
    expect(values).toContain("ext:2-3");
    // Y los mono individuales siguen disponibles.
    expect(values).toContain("ext:0");
    expect(values).toContain("ext:3");
    // NOTA: el agrupador empareja CUALQUIER par adyacente, así que también
    // ofrece el par "cruzado" 2/3 (ext:1-2). No es un par físico de la
    // interfaz, pero hoy se expone — documentado aquí para que el cambio
    // sea deliberado si algún día solo queremos pares alineados a frontera.
    expect(values).toContain("ext:1-2");
  });

  it("hides the second stereo pair when only 2 channels are reported (the bug)", () => {
    // Reproduce lo que ve el usuario cuando el backend solo expone 1/2:
    // el desplegable jamás ofrece la segunda salida estéreo.
    const values = buildAudioRoutingOptions([0, 1], t).map((o) => o.value);
    expect(values).toContain("ext:0-1");
    expect(values).not.toContain("ext:2-3");
    expect(values).not.toContain("ext:2");
    expect(values).not.toContain("ext:3");
  });
});

describe("multichannel output filtering (UMC204HD scenario)", () => {
  it("keeps all 4 channels when the device reports 4 outputs", () => {
    expect(
      normalizeEnabledOutputChannelsForOutputCount([0, 1, 2, 3], 4),
    ).toEqual([0, 1, 2, 3]);
  });

  it("clamps a 3/4 routing back to stereo when the device only has 2 outputs", () => {
    // Si el usuario había enrutado a Out 3/4 y luego el backend reporta
    // solo 2 canales, los canales 2 y 3 se descartan y caemos al fallback.
    expect(
      normalizeEnabledOutputChannelsForOutputCount([2, 3], 2, [0, 1]),
    ).toEqual([0, 1]);
  });
});

describe("formatMidiBinding", () => {
  const binding = (overrides: Partial<MidiBinding>): MidiBinding => ({
    status: 0,
    data1: 0,
    isCc: false,
    ...overrides,
  });

  it("formats CC bindings with channel", () => {
    expect(formatMidiBinding(binding({ status: 0xb2, data1: 7 }))).toBe(
      "CC 7 (Ch 3)",
    );
  });

  it("formats note-on with the resolved note name", () => {
    expect(formatMidiBinding(binding({ status: 0x90, data1: 60 }))).toBe(
      "Note On 60 (C4) (Ch 1)",
    );
  });

  it("formats note-off", () => {
    const label = formatMidiBinding(binding({ status: 0x80, data1: 62 }));
    expect(label).toContain("Note Off 62");
    expect(label).toContain("(D4)");
  });

  it("falls back to a raw status description for other messages", () => {
    expect(formatMidiBinding(binding({ status: 0xf0, data1: 5 }))).toContain(
      "Status 0xF0",
    );
  });
});

describe("findMidiMappingKeyForMessage", () => {
  it("finds the action mapped to a status+data1 pair", () => {
    const mappings = {
      play: { status: 0x90, data1: 60, isCc: false },
      stop: { status: 0x90, data1: 62, isCc: false },
    };
    expect(
      findMidiMappingKeyForMessage(mappings, { status: 0x90, data1: 62 }),
    ).toBe("stop");
    expect(
      findMidiMappingKeyForMessage(mappings, { status: 0x90, data1: 99 }),
    ).toBeNull();
  });
});

describe("file name helpers", () => {
  it("extracts the basename across slash styles", () => {
    expect(libraryAssetFileName("C:/a/b/song.wav")).toBe("song.wav");
    expect(libraryAssetFileName("a\\b\\drum.mp3")).toBe("drum.mp3");
    expect(libraryAssetFileName("bare.flac")).toBe("bare.flac");
  });

  it("humanizes a file path into a title-cased name", () => {
    expect(humanizeLibraryTrackName("C:/loops/my_cool-LOOP.wav")).toBe(
      "My Cool Loop",
    );
    expect(humanizeLibraryTrackName("C:/x/___.wav")).toBe("Audio");
  });

  it("keeps accented letters instead of splitting on them", () => {
    expect(humanizeLibraryTrackName("C:/x/canción.wav")).toBe("Canción");
    expect(humanizeLibraryTrackName("C:/x/guitarra-española.wav")).toBe(
      "Guitarra Española",
    );
  });

  it("normalizes decomposed (NFD) accents to a single precomposed glyph", () => {
    // macOS filesystems hand back NFD: the o-acute is "o" + combining acute
    // (U+0301). The humanized name must be precomposed (NFC) so the accent has
    // a glyph in the canvas font subset; a bare combining mark renders missing.
    const nfd = "C:/x/canción.wav";
    const result = humanizeLibraryTrackName(nfd);
    expect(result.normalize("NFC")).toBe(result); // output is already NFC
    expect(result).toBe("Canción"); // single precomposed o-acute
  });

  it("uses the humanized clip name, falling back to track name", () => {
    expect(
      clipDisplayName({ filePath: "C:/x/verse.wav", trackName: "T" }),
    ).toBe("Verse");
  });
});

describe("resolveNativeAudioImportPayloads", () => {
  it("returns payloads when every file has a native path", () => {
    const files = [
      Object.assign(new File([], "a.wav"), { path: "C:/a.wav" }),
      Object.assign(new File([], "b.wav"), { path: "C:/b.wav" }),
    ];
    expect(resolveNativeAudioImportPayloads(files)).toEqual([
      { fileName: "a.wav", sourcePath: "C:/a.wav" },
      { fileName: "b.wav", sourcePath: "C:/b.wav" },
    ]);
  });

  it("returns null when any file lacks a path", () => {
    const files = [
      Object.assign(new File([], "a.wav"), { path: "C:/a.wav" }),
      new File([], "b.wav"),
    ];
    expect(resolveNativeAudioImportPayloads(files)).toBeNull();
  });
});

describe("time formatters", () => {
  it("formats the transport clock as mm:ss.mmm", () => {
    expect(formatClock(0)).toBe("00:00.000");
    expect(formatClock(75.5)).toBe("01:15.500");
    expect(formatClock(-3)).toBe("00:00.000");
  });

  it("formats compact time as m:ss", () => {
    expect(formatCompactTime(0)).toBe("0:00");
    expect(formatCompactTime(65)).toBe("1:05");
  });

  it("formats a bpm draft", () => {
    expect(formatBpmDraft(120)).toBe("120");
    expect(formatBpmDraft(96.413)).toBe("96.41");
    expect(formatBpmDraft(Number.NaN)).toBe("");
  });
});

describe("clamp", () => {
  it("bounds a value into [min, max]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe("keyboardDigit", () => {
  it("reads Digit and Numpad codes from a string", () => {
    expect(keyboardDigit("Digit3")).toBe(3);
    expect(keyboardDigit("Numpad7")).toBe(7);
    expect(keyboardDigit("KeyA")).toBeNull();
  });

  it("reads the resolved key from an event", () => {
    expect(
      keyboardDigit({ code: "KeyX", key: "5", location: 0 } as KeyboardEvent),
    ).toBe(5);
  });

  it("maps numpad navigation codes to digits under shift", () => {
    expect(
      keyboardDigit({
        code: "Home",
        key: "Home",
        location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
      } as KeyboardEvent),
    ).toBe(7);
  });
});

describe("marker / region shortcuts", () => {
  const markers: SectionMarkerSummary[] = [
    { id: "m2", name: "B", startSeconds: 10 },
    { id: "m1", name: "A", startSeconds: 0 },
    { id: "m3", name: "C", startSeconds: 20 },
  ];

  it("resolves the nth marker by start time", () => {
    expect(resolveMarkerShortcut(markers, 0)?.id).toBe("m1");
    expect(resolveMarkerShortcut(markers, 2)?.id).toBe("m3");
    expect(resolveMarkerShortcut(markers, 9)).toBeNull();
  });

  it("resolves the nth region by start time", () => {
    const regions: SongRegionSummary[] = [
      {
        id: "r2",
        name: "R2",
        startSeconds: 5,
        endSeconds: 10,
        transposeSemitones: 0,
        key: null,
        warpEnabled: false,
        warpSourceBpm: null,
        master: { gain: 1 },
      },
      {
        id: "r1",
        name: "R1",
        startSeconds: 0,
        endSeconds: 5,
        transposeSemitones: 0,
        key: null,
        warpEnabled: false,
        warpSourceBpm: null,
        master: { gain: 1 },
      },
    ];
    expect(resolveRegionShortcut(regions, 0)?.id).toBe("r1");
    expect(resolveRegionShortcut(regions, 1)?.id).toBe("r2");
  });
});

describe("track tree helpers", () => {
  const song = makeSong({
    tracks: [
      makeTrack({ id: "folder", kind: "folder", hasChildren: true }),
      makeTrack({ id: "child1", parentTrackId: "folder", depth: 1 }),
      makeTrack({ id: "child2", parentTrackId: "folder", depth: 1 }),
      makeTrack({ id: "top" }),
    ],
  });

  it("hides children of collapsed folders", () => {
    const visible = buildVisibleTracks(song, new Set(["folder"]));
    expect(visible.map((t) => t.id)).toEqual(["folder", "top"]);
  });

  it("shows all tracks when nothing is collapsed", () => {
    const visible = buildVisibleTracks(song, new Set());
    expect(visible).toHaveLength(4);
  });

  it("finds the previous folder track above a track", () => {
    expect(findPreviousFolderTrack(song, "child2")?.id).toBe("folder");
    expect(findPreviousFolderTrack(song, "folder")).toBeNull();
  });

  it("counts direct children", () => {
    expect(trackChildrenCount(song, "folder")).toBe(2);
    expect(trackChildrenCount(song, "top")).toBe(0);
  });

  it("detects descendants through the parent chain", () => {
    expect(isTrackDescendant(song, "child1", "folder")).toBe(true);
    expect(isTrackDescendant(song, "top", "folder")).toBe(false);
  });
});

describe("find helpers", () => {
  const song = makeSong({
    tracks: [makeTrack({ id: "t1" })],
    clips: [makeClip({ id: "c1" })],
    sectionMarkers: [{ id: "sec1", name: "Intro", startSeconds: 0 }],
  });

  it("finds tracks, clips, and sections by id and null-guards", () => {
    expect(findTrack(song, "t1")?.id).toBe("t1");
    expect(findTrack(song, "nope")).toBeNull();
    expect(findTrack(null, "t1")).toBeNull();
    expect(findClip(song, "c1")?.id).toBe("c1");
    expect(findClip(song, null)).toBeNull();
    expect(findSection(song, "sec1")?.id).toBe("sec1");
    expect(findSection(song, "x")).toBeNull();
  });
});

describe("buildMemoizedClipsByTrack", () => {
  it("buckets clips per track", () => {
    const song = makeSong({
      tracks: [makeTrack({ id: "t1" }), makeTrack({ id: "t2" })],
      clips: [
        makeClip({ id: "c1", trackId: "t1" }),
        makeClip({ id: "c2", trackId: "t2" }),
      ],
    });
    const result = buildMemoizedClipsByTrack(song, {});
    expect(result.t1.map((c) => c.id)).toEqual(["c1"]);
    expect(result.t2.map((c) => c.id)).toEqual(["c2"]);
  });

  it("reuses the previous reference when nothing changed", () => {
    const song = makeSong({
      tracks: [makeTrack({ id: "t1" })],
      clips: [makeClip({ id: "c1", trackId: "t1" })],
    });
    const first = buildMemoizedClipsByTrack(song, {});
    const second = buildMemoizedClipsByTrack(song, first);
    expect(second).toBe(first);
  });
});

describe("mergeOptimisticClipsByTrack", () => {
  it("returns the input untouched with no operations", () => {
    const base = { t1: [makeClip({ id: "c1" })] };
    expect(mergeOptimisticClipsByTrack(base, [])).toBe(base);
  });

  it("inserts a new optimistic clip sorted by start time", () => {
    const base = { t1: [makeClip({ id: "c1", timelineStartSeconds: 0 })] };
    const op: OptimisticClipOperation = {
      id: "op1",
      clearAfterProjectRevision: null,
      clips: [
        makeClip({
          id: "ghost",
          filePath: "C:/x/new.wav",
          timelineStartSeconds: 0,
          // distinct placement so it is not deduped against c1
        }),
      ],
    };
    const result = mergeOptimisticClipsByTrack(base, [op]);
    expect(result.t1.map((c) => c.id)).toContain("ghost");
  });

  it("skips clips that duplicate an existing placement", () => {
    const existing = makeClip({
      id: "c1",
      filePath: "C:/x/a.wav",
      timelineStartSeconds: 2,
    });
    const base = { t1: [existing] };
    const op: OptimisticClipOperation = {
      id: "op1",
      clearAfterProjectRevision: null,
      clips: [
        makeClip({
          id: "dupe",
          filePath: "C:/x/a.wav",
          timelineStartSeconds: 2,
        }),
      ],
    };
    const result = mergeOptimisticClipsByTrack(base, [op]);
    expect(result.t1).toHaveLength(1);
    expect(result.t1[0].id).toBe("c1");
  });
});
