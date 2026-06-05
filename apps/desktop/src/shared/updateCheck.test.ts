import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearSkippedVersion,
  clearSnooze,
  compareVersions,
  extractReleaseNotesForLanguage,
  isNewerVersion,
  setSkippedVersion,
  shouldNotify,
  snoozeUntil,
  type ReleaseInfo,
} from "./updateCheck";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  clearSkippedVersion();
  clearSnooze();
});

describe("compareVersions", () => {
  it("compares semver triplets", () => {
    expect(compareVersions("0.0.9", "0.0.8")).toBeGreaterThan(0);
    expect(compareVersions("0.0.8", "0.0.9")).toBeLessThan(0);
    expect(compareVersions("v0.1.0", "0.0.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("treats malformed input as equal", () => {
    expect(compareVersions("nightly", "0.0.8")).toBe(0);
  });
});

describe("extractReleaseNotesForLanguage", () => {
  const body = `## Novedades de v0.0.8

- Mejora ES uno
- Mejora ES dos

## What's New in v0.0.8

- EN improvement one
- EN improvement two
`;

  it("returns the Spanish section when language is es", () => {
    const out = extractReleaseNotesForLanguage(body, "es");
    expect(out).toContain("Novedades de v0.0.8");
    expect(out).toContain("Mejora ES uno");
    expect(out).not.toContain("What's New");
  });

  it("returns the English section when language is en", () => {
    const out = extractReleaseNotesForLanguage(body, "en");
    expect(out).toContain("What's New in v0.0.8");
    expect(out).toContain("EN improvement one");
    expect(out).not.toContain("Novedades de v0.0.8");
  });

  it("falls back to the entire body when no heading matches", () => {
    const generic = "- a\n- b\n";
    expect(extractReleaseNotesForLanguage(generic, "es")).toBe("- a\n- b");
  });
});

describe("shouldNotify", () => {
  const release: ReleaseInfo = {
    tag: "v0.0.9",
    version: "0.0.9",
    url: "https://example.test",
    publishedAt: null,
    body: "",
  };

  it("notifies when remote is newer and no flags set", () => {
    expect(shouldNotify({ currentVersion: "0.0.8", release })).toBe(true);
  });

  it("does not notify when remote is the same or older", () => {
    expect(shouldNotify({ currentVersion: "0.0.9", release })).toBe(false);
    expect(shouldNotify({ currentVersion: "1.0.0", release })).toBe(false);
  });

  it("does not notify when the version has been skipped", () => {
    setSkippedVersion("0.0.9");
    expect(shouldNotify({ currentVersion: "0.0.8", release })).toBe(false);
  });

  it("notifies again when a newer version than the skipped one is released", () => {
    setSkippedVersion("0.0.9");
    const newer = { ...release, tag: "v0.1.0", version: "0.1.0" };
    expect(shouldNotify({ currentVersion: "0.0.8", release: newer })).toBe(true);
  });

  it("suppresses the popup for the current session after Remind me later", () => {
    snoozeUntil();
    expect(shouldNotify({ currentVersion: "0.0.8", release })).toBe(false);
    // A forced check (manual "Check for updates") bypasses the session snooze.
    expect(
      shouldNotify({ currentVersion: "0.0.8", release, bypassSnooze: true }),
    ).toBe(true);
  });

  it("clears the snooze when the session resets", () => {
    snoozeUntil();
    clearSnooze();
    expect(shouldNotify({ currentVersion: "0.0.8", release })).toBe(true);
  });
});

describe("isNewerVersion", () => {
  it("strips the leading v before comparing", () => {
    expect(isNewerVersion("v0.0.9", "0.0.8")).toBe(true);
    expect(isNewerVersion("0.0.8", "v0.0.9")).toBe(false);
  });
});
