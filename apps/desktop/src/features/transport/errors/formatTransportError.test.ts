import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import en from "../../../shared/i18n/en";
import es from "../../../shared/i18n/es";
import { formatTransportError } from "./formatTransportError";

type Dictionary = Record<string, unknown>;

function translator(dictionary: Dictionary): TFunction {
  return ((key: string, options?: Record<string, unknown>) => {
    const template = key
      .split(".")
      .reduce<unknown>(
        (value, part) =>
          typeof value === "object" && value !== null
            ? (value as Dictionary)[part]
            : undefined,
        dictionary,
      );
    if (typeof template !== "string") return key;
    return template.replace(/{{(\w+)}}/g, (_, name: string) =>
      String(options?.[name] ?? ""),
    );
  }) as TFunction;
}

const song = {
  regions: [
    { id: "region_a", name: "Pueblos todos" },
    { id: "region_b", name: "Santo por siempre" },
  ],
} as SongView;

describe("formatTransportError", () => {
  it("explains a varispeed duration collision in Spanish using song names", () => {
    const message = formatTransportError(
      "region duration change would overlap: region_a with region_b",
      translator(es),
      song,
    );

    expect(message).toContain("Pueblos todos");
    expect(message).toContain("Santo por siempre");
    expect(message).toContain("Warp");
    expect(message).not.toContain("region_a");
  });

  it("localizes the legacy engine overlap error in English", () => {
    expect(
      formatTransportError(
        "audio engine error: song is invalid: regions are out of order or overlap: region_a before region_b",
        translator(en),
        song,
      ),
    ).toBe(
      'The operation would make “Pueblos todos” overlap “Santo por siempre”. Move one of the songs to leave enough space and try again.',
    );
  });

  it("keeps unknown diagnostic details in the translated fallback", () => {
    expect(formatTransportError("unexpected detail", translator(es), song)).toBe(
      "Error: unexpected detail",
    );
    expect(
      formatTransportError(new Error("unexpected detail"), translator(en), song),
    ).toBe("Error: unexpected detail");
  });

  it.each([
    [
      "audio command failed: no se puede mover la canción antes del inicio del proyecto",
      "No se puede mover la canción antes del inicio del proyecto.",
    ],
    [
      "audio command failed: cannot delete a library asset that is already used on the timeline",
      "No se puede eliminar este audio porque se está usando en el timeline. Elimina primero sus clips.",
    ],
    [
      "audio command failed: midi channel must be 1-16, got 17",
      "El canal MIDI debe estar entre 1 y 16.",
    ],
    [
      "audio command failed: warp source bpm must be between 20 and 300",
      "Introduce un BPM original entre 20 y 300 antes de activar Warp.",
    ],
    [
      "download request failed: connection reset",
      "No se pudo descargar el pad. Comprueba la conexión a Internet y vuelve a intentarlo.",
    ],
  ])("translates a frequent backend error: %s", (raw, expected) => {
    expect(formatTransportError(raw, translator(es))).toBe(expected);
  });

  it("translates backend messages that were hard-coded in Spanish for English users", () => {
    expect(
      formatTransportError(
        "audio command failed: no se puede mover la canción ahí: solaparía con 'Second song'",
        translator(en),
      ),
    ).toBe(
      "The song cannot be moved there because it would overlap “Second song”. Leave enough space between both songs and try again.",
    );
  });

  it("adds localized context while preserving unknown engine details", () => {
    expect(
      formatTransportError(
        "audio engine error: device stopped unexpectedly",
        translator(es),
      ),
    ).toBe(
      "El motor de audio no pudo completar la operación. Detalles: audio engine error: device stopped unexpectedly",
    );
  });
});
