import { describe, expect, it } from "vitest";
import {
  musicalPositionToSeconds,
  parseMusicalPosition,
} from "./musicalPosition";
import { formatMusicalPosition } from "../helpers";
import type { SongView } from "../desktopApi";

function songAt(bpm: number, timeSignature: string, extras: object = {}) {
  return {
    id: "s",
    title: "Sesion",
    bpm,
    timeSignature,
    durationSeconds: 600,
    tempoMarkers: [],
    timeSignatureMarkers: [],
    regions: [],
    sectionMarkers: [],
    clips: [],
    tracks: [],
    projectRevision: 1,
    ...extras,
  } as unknown as SongView;
}

describe("leer un compas escrito a mano", () => {
  it("acepta compas, compas.tiempo y compas.tiempo.subdivision", () => {
    expect(parseMusicalPosition("5")).toEqual({
      barNumber: 5,
      beatInBar: 1,
      subBeat: 0,
    });
    expect(parseMusicalPosition("5.3")).toEqual({
      barNumber: 5,
      beatInBar: 3,
      subBeat: 0,
    });
    expect(parseMusicalPosition("5.3.25")).toEqual({
      barNumber: 5,
      beatInBar: 3,
      subBeat: 25,
    });
  });

  it("no mueve nada con un valor a medias o imposible", () => {
    // Escribir a medias en un campo de texto es lo normal.
    for (const input of ["", " ", ".", "0", "-3", "abc", "1.2.3.4"]) {
      expect(parseMusicalPosition(input), input).toBeNull();
    }
  });
});

describe("compas -> segundos es la inversa de segundos -> compas", () => {
  const cases = [
    { name: "120 bpm 4/4", song: songAt(120, "4/4") },
    { name: "90 bpm 3/4", song: songAt(90, "3/4") },
    { name: "140 bpm 6/8", song: songAt(140, "6/8") },
    {
      name: "con marca de tempo a mitad",
      song: songAt(120, "4/4", {
        tempoMarkers: [{ id: "t1", startSeconds: 8, bpm: 75 }],
      }),
    },
    {
      name: "con cambio de compas a mitad",
      song: songAt(120, "4/4", {
        timeSignatureMarkers: [{ id: "ts1", startSeconds: 8, signature: "3/4" }],
      }),
    },
  ];

  for (const entry of cases) {
    it(`vuelve al mismo compas (${entry.name})`, () => {
      // Tiempos 1-3: existen en los tres compases probados (4/4, 3/4 y 6/8).
      for (const display of ["1.1.00", "2.1.00", "5.3.00", "9.2.50", "17.1.00"]) {
        const target = parseMusicalPosition(display)!;
        const seconds = musicalPositionToSeconds(target, entry.song, 600);
        expect(formatMusicalPosition(seconds, entry.song), display).toBe(
          display,
        );
      }
    });
  }

  it("el compas 1.1 es el segundo cero", () => {
    expect(
      musicalPositionToSeconds(
        parseMusicalPosition("1.1.00")!,
        songAt(120, "4/4"),
        600,
      ),
    ).toBeCloseTo(0, 6);
  });

  it("a 120 bpm 4/4 el compas 3 cae en el segundo 4", () => {
    // Dos compases de cuatro negras a 0,5 s cada una.
    expect(
      musicalPositionToSeconds(
        parseMusicalPosition("3.1.00")!,
        songAt(120, "4/4"),
        600,
      ),
    ).toBeCloseTo(4, 3);
  });

  it("un tiempo que no existe cae en el siguiente que si", () => {
    // 3/4 no tiene un cuarto tiempo. Es mas util llevar la marca al 18.1 que
    // dejarla donde estaba sin decir nada.
    const song = songAt(90, "3/4");
    const seconds = musicalPositionToSeconds(
      parseMusicalPosition("17.4.00")!,
      song,
      600,
    );
    expect(formatMusicalPosition(seconds, song)).toBe("18.1.00");
  });

  it("no se sale del final del espacio de trabajo", () => {
    expect(
      musicalPositionToSeconds(
        parseMusicalPosition("9999.1.00")!,
        songAt(120, "4/4"),
        30,
      ),
    ).toBe(30);
  });
});
