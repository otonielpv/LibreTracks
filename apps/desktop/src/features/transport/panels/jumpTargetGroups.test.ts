import { describe, expect, it } from "vitest";

import type {
  SectionMarkerSummary,
  SongRegionSummary,
} from "@libretracks/shared/models";

import { duplicateMarkerNames, groupMarkersBySong } from "./jumpTargetGroups";

function region(
  id: string,
  startSeconds: number,
  endSeconds: number,
): SongRegionSummary {
  return {
    id,
    name: id,
    startSeconds,
    endSeconds,
    transposeSemitones: 0,
    key: null,
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1 },
    compactColumnWidthRem: null,
  };
}

function marker(
  id: string,
  startSeconds: number,
  name = id,
): SectionMarkerSummary {
  return { id, name, startSeconds };
}

describe("groupMarkersBySong", () => {
  it("reparte cada marca en la cancion que la contiene", () => {
    const groups = groupMarkersBySong(
      [region("a", 0, 100), region("b", 100, 200)],
      [marker("m2", 120), marker("m1", 10), marker("m3", 150)],
    );

    expect(groups.map((g) => g.region?.id)).toEqual(["a", "b"]);
    expect(groups[0].markers.map((m) => m.id)).toEqual(["m1"]);
    expect(groups[1].markers.map((m) => m.id)).toEqual(["m2", "m3"]);
  });

  it("manda al grupo sin cancion las marcas que caen fuera de toda region", () => {
    const groups = groupMarkersBySong(
      [region("a", 10, 20)],
      [marker("antes", 5), marker("dentro", 15), marker("despues", 500)],
    );

    expect(groups).toHaveLength(2);
    expect(groups[0].region?.id).toBe("a");
    expect(groups[1].region).toBeNull();
    expect(groups[1].markers.map((m) => m.id)).toEqual(["antes", "despues"]);
  });

  it("el final de una region pertenece a la siguiente, no a la que acaba", () => {
    const groups = groupMarkersBySong(
      [region("a", 0, 100), region("b", 100, 200)],
      [marker("frontera", 100)],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].region?.id).toBe("b");
  });

  it("no emite grupos vacios ni el grupo sin cancion cuando no hace falta", () => {
    const groups = groupMarkersBySong(
      [region("a", 0, 100), region("vacia", 100, 200)],
      [marker("m1", 10)],
    );

    expect(groups.map((g) => g.region?.id)).toEqual(["a"]);
  });

  it("sin regiones, todas las marcas quedan fuera de cancion", () => {
    const groups = groupMarkersBySong([], [marker("m1", 10)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].region).toBeNull();
  });

  it("ordena las canciones por timeline aunque lleguen desordenadas", () => {
    const groups = groupMarkersBySong(
      [region("b", 100, 200), region("a", 0, 100)],
      [marker("m1", 10), marker("m2", 120)],
    );

    expect(groups.map((g) => g.region?.id)).toEqual(["a", "b"]);
  });
});

describe("duplicateMarkerNames", () => {
  it("solo devuelve los nombres repetidos", () => {
    const names = duplicateMarkerNames([
      marker("1", 0, "Coro"),
      marker("2", 10, "Verso 1"),
      marker("3", 20, "Coro"),
    ]);

    expect([...names]).toEqual(["Coro"]);
  });
});
