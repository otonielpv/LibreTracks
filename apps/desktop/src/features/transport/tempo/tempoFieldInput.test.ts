import { describe, expect, it } from "vitest";

import {
  parseBpmDraft,
  parseTimeSignatureDraft,
  sanitizeBpmDraft,
  sanitizeTimeSignatureDraft,
} from "./tempoFieldInput";

describe("sanitizeBpmDraft", () => {
  it("quita letras, signos y la e de la notación científica", () => {
    expect(sanitizeBpmDraft("1e3")).toBe("13");
    expect(sanitizeBpmDraft("-120+")).toBe("120");
    expect(sanitizeBpmDraft("abc")).toBe("");
  });

  it("acepta punto o coma, pero un solo separador y dos decimales", () => {
    expect(sanitizeBpmDraft("148,40")).toBe("148,40");
    expect(sanitizeBpmDraft("130.555")).toBe("130.55");
    expect(sanitizeBpmDraft("1.2.3")).toBe("1.23");
  });

  it("no pasa de tres cifras enteras", () => {
    expect(sanitizeBpmDraft("12000")).toBe("120");
  });
});

describe("parseBpmDraft", () => {
  it("lee coma decimal", () => {
    expect(parseBpmDraft("148,40")).toBeCloseTo(148.4);
  });

  it("devuelve null para vacío o a medias en vez de 0", () => {
    expect(parseBpmDraft("")).toBeNull();
    expect(parseBpmDraft(",")).toBeNull();
    expect(parseBpmDraft("1e3")).toBeNull();
    expect(parseBpmDraft("0")).toBeNull();
  });

  it("recorta al rango de la sesión", () => {
    expect(parseBpmDraft("5")).toBe(20);
    expect(parseBpmDraft("999")).toBe(300);
  });
});

describe("sanitizeTimeSignatureDraft", () => {
  it("deja cifras y una sola barra", () => {
    expect(sanitizeTimeSignatureDraft("6/8abc/")).toBe("6/8");
    expect(sanitizeTimeSignatureDraft("hola")).toBe("");
    expect(sanitizeTimeSignatureDraft("123/456")).toBe("12/45");
  });
});

describe("parseTimeSignatureDraft", () => {
  it("acepta compases reales y los normaliza", () => {
    expect(parseTimeSignatureDraft("4/4")).toBe("4/4");
    expect(parseTimeSignatureDraft(" 07/8 ")).toBe("7/8");
    expect(parseTimeSignatureDraft("12/16")).toBe("12/16");
  });

  it("rechaza lo que no es un compás", () => {
    expect(parseTimeSignatureDraft("")).toBeNull();
    expect(parseTimeSignatureDraft("4")).toBeNull();
    expect(parseTimeSignatureDraft("4/")).toBeNull();
    expect(parseTimeSignatureDraft("0/4")).toBeNull();
    expect(parseTimeSignatureDraft("5/7")).toBeNull();
    expect(parseTimeSignatureDraft("33/4")).toBeNull();
    expect(parseTimeSignatureDraft("abc")).toBeNull();
  });
});
