import { afterEach, describe, expect, it, vi } from "vitest";

import { getRemoteStrings } from "./i18n";

/**
 * `detectLanguage` is private; we exercise it through `getRemoteStrings` by
 * stubbing the browser signals it reads (document lang + navigator languages).
 */
function setLanguageSignals(options: {
  documentLang?: string;
  languages?: string[];
  language?: string;
}) {
  document.documentElement.lang = options.documentLang ?? "";
  vi.stubGlobal("navigator", {
    languages: options.languages ?? [],
    language: options.language ?? "",
  });
}

describe("remote i18n", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.lang = "";
  });

  it("defaults to English when no signal hints Spanish", () => {
    setLanguageSignals({ languages: ["en-US"], language: "en-US" });
    expect(getRemoteStrings().play).toBe("Play");
  });

  it("selects Spanish when the document lang is es", () => {
    setLanguageSignals({ documentLang: "es" });
    expect(getRemoteStrings().play).toBe("Reproducir");
  });

  it("selects Spanish from navigator.languages regional variants", () => {
    setLanguageSignals({ languages: ["es-419", "en"] });
    expect(getRemoteStrings().play).toBe("Reproducir");
  });

  it("selects Spanish from navigator.language fallback", () => {
    setLanguageSignals({ language: "ES-es" });
    expect(getRemoteStrings().play).toBe("Reproducir");
  });

  it("prefers no Spanish match when only English variants are present", () => {
    setLanguageSignals({ languages: ["en-GB", "fr-FR"], language: "en-GB" });
    expect(getRemoteStrings().stop).toBe("Stop");
  });

  it("exposes a matching key set for both languages", () => {
    setLanguageSignals({ documentLang: "en" });
    const en = getRemoteStrings();
    setLanguageSignals({ documentLang: "es" });
    const es = getRemoteStrings();
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
  });
});
