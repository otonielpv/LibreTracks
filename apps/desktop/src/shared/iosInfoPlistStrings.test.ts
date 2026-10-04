import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The iOS permission texts exist three times: the fallback in Info.ios.plist
 * and one InfoPlist.strings per language (plan mobile-midi, pasos 06 y 07).
 * A permission added to the plist but forgotten in a language shows the
 * English fallback to Spanish users, and App Review reads those texts.
 */
const srcTauri = resolve(dirname(fileURLToPath(import.meta.url)), "../../src-tauri");
const localizationDir = join(srcTauri, "ios-localization");

function usageKeysInPlist(): string[] {
  const plist = readFileSync(join(srcTauri, "Info.ios.plist"), "utf8");
  return [...plist.matchAll(/<key>(NS\w+UsageDescription)<\/key>/g)]
    .map((match) => match[1])
    .sort();
}

function stringsFile(language: string): Map<string, string> {
  const text = readFileSync(
    join(localizationDir, `${language}.lproj`, "InfoPlist.strings"),
    "utf8",
  );
  const entries = new Map<string, string>();
  for (const match of text.matchAll(/^"(\w+)"\s*=\s*"((?:[^"\\]|\\.)*)";\s*$/gm)) {
    entries.set(match[1], match[2]);
  }
  return entries;
}

const languages = readdirSync(localizationDir)
  .filter((name) => name.endsWith(".lproj"))
  .map((name) => name.replace(/\.lproj$/, ""))
  .sort();

describe("iOS permission texts", () => {
  it("ship in English and Spanish", () => {
    expect(languages).toEqual(["en", "es"]);
    const plist = readFileSync(join(srcTauri, "Info.ios.plist"), "utf8");
    expect(plist).toMatch(
      /<key>CFBundleLocalizations<\/key>\s*<array>\s*<string>en<\/string>\s*<string>es<\/string>/,
    );
  });

  it.each(languages)("%s has every usage description of Info.ios.plist", (language) => {
    const entries = stringsFile(language);
    expect([...entries.keys()].sort()).toEqual(usageKeysInPlist());
    for (const [key, value] of entries) {
      expect(value.length, key).toBeGreaterThan(40);
    }
  });

  it("the Spanish texts are actually translated", () => {
    const english = stringsFile("en");
    for (const [key, value] of stringsFile("es")) {
      expect(value, key).not.toBe(english.get(key));
    }
  });
});
