import { describe, expect, it } from "vitest";

import {
  LIBRARY_ASSET_DRAG_MIME,
  classifyDroppedFiles,
  classifyDroppedPaths,
  getDroppedFiles,
  isAcceptedDroppedFileName,
  findOverlappingSongs,
  isExternalFileDrag,
  isInternalLibraryDrag,
  resolveFolderDropLayout,
  resolveFolderSongDurationSeconds,
} from "./dragDrop";

function buildTransfer(args?: { files?: File[]; items?: DataTransferItem[]; types?: string[] }) {
  const files = args?.files ?? [];
  const indexedFiles = files.reduce<Record<number, File>>((accumulator, file, index) => {
    accumulator[index] = file;
    return accumulator;
  }, {});
  const fileList = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    ...indexedFiles,
  } as unknown as FileList;

  return {
    files: fileList,
    items: args?.items ?? [],
    types: args?.types ?? [],
  } as unknown as DataTransfer;
}

describe("dragDrop helpers", () => {
  it("detects internal library drags from the custom MIME type", () => {
    expect(isInternalLibraryDrag(buildTransfer({ types: [LIBRARY_ASSET_DRAG_MIME] }))).toBe(true);
    expect(isExternalFileDrag(buildTransfer({ types: [LIBRARY_ASSET_DRAG_MIME] }))).toBe(false);
  });

  it("classifies a package drop", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "demo.ltpkg");
    expect(classifyDroppedFiles([file]).kind).toBe("package");
  });

  it("classifies supported audio drops", () => {
    const files = [
      new File([new Uint8Array([1])], "drums.wav"),
      new File([new Uint8Array([2])], "bass.flac"),
    ];
    const classification = classifyDroppedFiles(files);
    expect(classification.kind).toBe("audio");
    expect(classification.audioFiles).toHaveLength(2);
  });

  it("classifies package and audio combinations as mixed", () => {
    const files = [
      new File([new Uint8Array([1])], "song.ltpkg"),
      new File([new Uint8Array([2])], "guide.wav"),
    ];
    expect(classifyDroppedFiles(files).kind).toBe("mixed");
  });

  it("classifies unsupported files", () => {
    const files = [new File([new Uint8Array([1])], "notes.txt")];
    expect(classifyDroppedFiles(files).kind).toBe("unsupported");
  });

  it("classifies a Reaper/Ableton project drop as external", () => {
    const rpp = classifyDroppedFiles([
      new File([new Uint8Array([1])], "song.rpp"),
    ]);
    expect(rpp.kind).toBe("external");
    expect(rpp.externalFile?.name).toBe("song.rpp");

    const als = classifyDroppedPaths(["C:/songs/track.als"]);
    expect(als.kind).toBe("external");
    expect(als.kind === "external" && als.externalPath).toBe(
      "C:/songs/track.als",
    );

    // A project mixed with audio is rejected (single-file only).
    expect(
      classifyDroppedFiles([
        new File([new Uint8Array([1])], "song.als"),
        new File([new Uint8Array([2])], "stem.wav"),
      ]).kind,
    ).toBe("mixed");

    // .rpp/.als are accepted by the drop gate.
    expect(isAcceptedDroppedFileName("a.rpp")).toBe(true);
    expect(isAcceptedDroppedFileName("a.als")).toBe(true);
  });

  it("returns dropped files from the transfer payload", () => {
    const files = [new File([new Uint8Array([1])], "drums.wav")];
    expect(getDroppedFiles(buildTransfer({ files, types: ["Files"] }))).toHaveLength(1);
    expect(isExternalFileDrag(buildTransfer({ files, types: ["Files"] }))).toBe(true);
  });

  it("falls back to DataTransfer.items during hover classification", () => {
    const items = [
      {
        kind: "file",
        getAsFile: () => new File([new Uint8Array([1])], "song.ltpkg"),
      },
      {
        kind: "file",
        getAsFile: () => new File([new Uint8Array([2])], "guide.wav"),
      },
    ] as DataTransferItem[];

    const files = getDroppedFiles(buildTransfer({ items, types: ["Files"] }));
    expect(files).toHaveLength(2);
    expect(classifyDroppedFiles(files).kind).toBe("mixed");
  });
});

describe("library folder drop", () => {
  it("stacks a folder on separate tracks by default", () => {
    // The inverse of a loose multi-asset drag: a folder is a set of stems, so
    // plain-drop must never chain them onto one track.
    expect(resolveFolderDropLayout(false, false)).toBe("vertical");
  });

  it("chains the folder in one track while Ctrl/Cmd is held", () => {
    expect(resolveFolderDropLayout(true, false)).toBe("horizontal");
    expect(resolveFolderDropLayout(false, true)).toBe("horizontal");
  });

  it("sizes a stacked song to its longest stem, not the sum", () => {
    // Stems start together, so summing would leave the song running long past
    // the audio and swallow whatever the user drops next.
    expect(resolveFolderSongDurationSeconds([12, 30, 7], "vertical")).toBe(30);
  });

  it("sizes a chained song to the total of its takes", () => {
    expect(resolveFolderSongDurationSeconds([12, 30, 7], "horizontal")).toBe(49);
  });

  it("reports zero length for an empty folder so the caller can substitute a placeholder width", () => {
    expect(resolveFolderSongDurationSeconds([], "vertical")).toBe(0);
    expect(resolveFolderSongDurationSeconds([], "horizontal")).toBe(0);
  });
});

describe("findOverlappingSongs", () => {
  const songs = [
    { name: "first", startSeconds: 0, endSeconds: 100 },
    { name: "second", startSeconds: 200, endSeconds: 300 },
  ];

  it("accepts a drop in empty space past the last song", () => {
    // The bug this replaced: getSongRegionAtPosition resolves the NEAREST song
    // and never returns null once one exists, so dropping in open space was
    // reported as landing inside the last song.
    expect(findOverlappingSongs(songs, 400, 450)).toEqual([]);
  });

  it("accepts a drop flush against the end of a song", () => {
    // Touching edges must not count as overlap, otherwise you could never
    // butt a new song up against the previous one.
    expect(findOverlappingSongs(songs, 100, 200)).toEqual([]);
  });

  it("accepts a song that exactly fills the gap between two songs", () => {
    expect(findOverlappingSongs(songs, 100, 200)).toEqual([]);
    // ...but one second longer no longer fits.
    expect(findOverlappingSongs(songs, 100, 201).map((s) => s.name)).toEqual([
      "second",
    ]);
  });

  it("rejects a drop whose span runs into a later song even though its start is free", () => {
    // Start at 150 is empty, but a 100s song would plough through "second".
    expect(findOverlappingSongs(songs, 150, 250).map((s) => s.name)).toEqual([
      "second",
    ]);
  });

  it("rejects a drop starting inside a song", () => {
    expect(findOverlappingSongs(songs, 50, 80).map((s) => s.name)).toEqual([
      "first",
    ]);
  });

  it("reports every song a long drop would swallow", () => {
    expect(findOverlappingSongs(songs, 0, 500).map((s) => s.name)).toEqual([
      "first",
      "second",
    ]);
  });

  it("accepts any drop when the project has no songs yet", () => {
    expect(findOverlappingSongs([], 0, 120)).toEqual([]);
  });
});
