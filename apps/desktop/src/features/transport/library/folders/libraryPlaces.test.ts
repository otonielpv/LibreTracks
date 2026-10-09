import { describe, expect, it } from "vitest";

import type { LibraryDirEntry } from "../../desktopApi";
import { addPlace, audioPathsOf, filterEntries, placeLabel, removePlace } from "./libraryPlaces";

const entry = (name: string, kind: LibraryDirEntry["kind"] = "audio"): LibraryDirEntry => ({
  name,
  path: `D:/Stems/${name}`,
  kind,
});

describe("library places", () => {
  it("does not add the same folder twice, whatever the case or separators", () => {
    const places = ["D:\\Stems"];
    expect(addPlace(places, "d:/stems/")).toBe(places);
    expect(addPlace(places, "E:\\Pads")).toEqual(["D:\\Stems", "E:\\Pads"]);
  });

  it("removes a place matched the same way", () => {
    expect(removePlace(["D:\\Stems", "E:\\Pads"], "d:/stems")).toEqual(["E:\\Pads"]);
  });

  it("labels a place by its folder name, and a drive by its path", () => {
    expect(placeLabel("D:\\Music\\Stems\\")).toBe("Stems");
    expect(placeLabel("/Users/me/Stems")).toBe("Stems");
    expect(placeLabel("D:\\")).toBe("D:\\");
  });

  it("searches without case or accents", () => {
    const entries = [entry("Batería.wav"), entry("Bajo.wav")];
    expect(filterEntries(entries, "bateria").map((e) => e.name)).toEqual(["Batería.wav"]);
    expect(filterEntries(entries, "  ")).toBe(entries);
  });

  it("takes only the audio of a listing for a folder song", () => {
    const entries = [entry("Song", "folder"), entry("Drums.wav"), entry("Clip.mp4", "video")];
    expect(audioPathsOf(entries)).toEqual(["D:/Stems/Drums.wav"]);
  });
});
