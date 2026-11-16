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

  it("shows a space check with both figures, not as an audio decode failure", () => {
    const GB = 1024 ** 3;
    expect(
      formatTransportError(
        `audio decode error: insufficient disk space: needs ${3 * GB} bytes, ${2.5 * GB} available`,
        translator(es),
      ),
    ).toBe(
      "No hay espacio suficiente: hacen falta 3.0 GB y solo quedan 2.5 GB libres. Libera espacio y vuelve a intentarlo.",
    );
  });

  it("translates the OS's disk-full error instead of leaking it in English", () => {
    for (const raw of [
      "io error: No space left on device (os error 28)",
      "io error: There is not enough space on the disk. (os error 112)",
      // Windows words it in the system language: only the code is reliable.
      "io error: No hay suficiente espacio en el disco. (os error 112)",
      "copy failed (os error 28)",
    ]) {
      expect(formatTransportError(raw, translator(es))).toBe(
        "El dispositivo se quedó sin espacio mientras se escribía. Libera espacio y vuelve a intentarlo.",
      );
    }
  });

  it("names the FAT32 cap instead of calling it a full disk", () => {
    const GB = 1024 ** 3;
    expect(
      formatTransportError(
        `io error: file too large for this volume: ${5 * GB} bytes, limit ${4 * GB - 1}`,
        translator(es),
      ),
    ).toBe(
      "Este archivo ocupa unos 5.0 GB y el destino solo admite archivos de hasta 4.0 GB (un pendrive o tarjeta SD en FAT32). Guárdalo en otro disco o formatea la unidad en exFAT.",
    );
  });

  it("calls a corrupt package damaged, not undecodable audio", () => {
    expect(
      formatTransportError("invalid package: invalid Zip archive: Could not find EOCD", translator(en)),
    ).toBe(
      "The file is damaged or incomplete. If it came from the cloud or a transfer, download it again and try again.",
    );
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

  it.each([
    [es, "markers are out of order: section_19 before section_20", "sección o de aviso"],
    [en, "markers are out of order: section_19 before section_20", "Section or cue"],
    [es, "time signature markers are out of order: a before b", "marcas de compás"],
    [en, "time signature markers are out of order: a before b", "Time signature markers"],
  ])("explains ordering conflicts without exposing IDs", (locale, error, expected) => {
    const message = formatTransportError(`audio engine error: song is invalid: ${error}`, translator(locale));
    expect(message).toContain(expected);
    expect(message).not.toContain("section_19");
    expect(message).toContain(locale === es ? "misma posición" : "same position");
  });
});
