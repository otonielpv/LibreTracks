import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import en from "../../../shared/i18n/en";
import es from "../../../shared/i18n/es";

const setlistDir = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every literal `setlistView.*` key the view's code asks for. */
function usedKeys(): string[] {
  const keys = new Set<string>();
  for (const file of sourceFiles(setlistDir)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/["'`](setlistView\.[A-Za-z0-9_.]+)["'`]/g)) {
      keys.add(match[1]);
    }
  }
  return [...keys].sort();
}

function lookup(messages: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>(
    (node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined),
    messages,
  );
}

// A whole block once landed inside another one (setlistView.mixer.edit
// instead of setlistView.edit) and every edit label showed its raw key.
describe("Setlist texts", () => {
  const keys = usedKeys();

  it("finds the keys the view uses", () => {
    expect(keys.length).toBeGreaterThan(50);
  });

  it.each([
    ["es", es],
    ["en", en],
  ])("every key used by the view is a text in %s", (_lang, messages) => {
    const missing = keys.filter((key) => typeof lookup(messages, key) !== "string");
    expect(missing).toEqual([]);
  });
});
