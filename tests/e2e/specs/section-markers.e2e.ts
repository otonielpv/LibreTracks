import { browser, expect } from "@wdio/globals";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";

/**
 * Section-marker attribute flows (kind/variant, colour, quick-jump digit), in
 * their own clean session. Section markers are pure Rust-model metadata (the
 * C++ engine doesn't read them), so these assert against the backend song model
 * (song.sectionMarkers) — the same discipline as the other flows.
 *
 * Key backend semantics these assert (state/regions.rs):
 *   - set_section_marker_kind updates kind + numbered variant.
 *   - set_section_marker_color sets a colour override; null clears it.
 *   - assign_section_marker_digit is EXCLUSIVE: assigning a digit already held
 *     by another marker steals it from that marker (the previous holder's digit
 *     is cleared); null clears the digit.
 */
describe("Section marker attributes (isolated session)", () => {
  let workDir = "";
  let markerA = "";
  let markerB = "";

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();

    workDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-marker-"));
    await AppPage.createSession("E2E Marker Session", workDir);
    const createdSessionPath = (await AppPage.transportSnapshot()).songFilePath;
    if (!createdSessionPath) {
      throw new Error("The engine did not report the created session path");
    }

    // Two markers at distinct positions to work with across the cases.
    markerA = await AppPage.createSectionMarker(8);
    markerB = await AppPage.createSectionMarker(16);
    if (!markerA || !markerB || markerA === markerB) {
      throw new Error("Two distinct section markers were not created");
    }
  });

  after(async () => {
    const snapshot = await AppPage.transportSnapshot();
    if (snapshot.playbackState !== "stopped") {
      await (await AppPage.stopButton).click();
      await browser.waitUntil(
        async () =>
          (await AppPage.transportSnapshot()).playbackState === "stopped",
        { timeoutMsg: "Engine did not stop before marker teardown" },
      );
    }
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  const markerById = async (id: string) =>
    (await AppPage.songView())?.sectionMarkers.find((m) => m.id === id);

  it("sets a section marker's kind and numbered variant", async () => {
    await AppPage.setSectionMarkerKind(markerA, "chorus", 2);
    await browser.waitUntil(
      async () => {
        const marker = await markerById(markerA);
        return marker?.kind === "chorus" && marker?.variant === 2;
      },
      {
        timeout: 30_000,
        timeoutMsg: "The marker kind/variant did not reach the backend model",
      },
    );

    // Changing to an unnumbered kind clears the variant.
    await AppPage.setSectionMarkerKind(markerA, "intro", null);
    await browser.waitUntil(
      async () => {
        const marker = await markerById(markerA);
        return marker?.kind === "intro" && (marker?.variant ?? null) === null;
      },
      { timeout: 30_000, timeoutMsg: "The marker kind did not change to intro" },
    );
  });

  it("sets and clears a section marker's colour override", async () => {
    await AppPage.setSectionMarkerColor(markerA, "#ff8800");
    await browser.waitUntil(
      async () => (await markerById(markerA))?.color === "#ff8800",
      {
        timeout: 30_000,
        timeoutMsg: "The marker colour did not reach the backend model",
      },
    );

    await AppPage.setSectionMarkerColor(markerA, null);
    await browser.waitUntil(
      async () => ((await markerById(markerA))?.color ?? null) === null,
      { timeout: 30_000, timeoutMsg: "The marker colour was not cleared" },
    );
  });

  it("assigns a quick-jump digit exclusively across markers", async () => {
    // Give marker A digit 3.
    await AppPage.assignSectionMarkerDigit(markerA, 3);
    await browser.waitUntil(
      async () => (await markerById(markerA))?.digit === 3,
      {
        timeout: 30_000,
        timeoutMsg: "Digit 3 was not assigned to marker A",
      },
    );

    // Now give marker B the SAME digit — it must steal it from A.
    await AppPage.assignSectionMarkerDigit(markerB, 3);
    await browser.waitUntil(
      async () => {
        const a = await markerById(markerA);
        const b = await markerById(markerB);
        return b?.digit === 3 && (a?.digit ?? null) === null;
      },
      {
        timeout: 30_000,
        timeoutMsg:
          "Reassigning digit 3 did not steal it from the previous holder",
      },
    );

    // Clearing marker B's digit leaves neither marker holding 3.
    await AppPage.assignSectionMarkerDigit(markerB, null);
    await browser.waitUntil(
      async () => {
        const a = await markerById(markerA);
        const b = await markerById(markerB);
        return (a?.digit ?? null) === null && (b?.digit ?? null) === null;
      },
      { timeout: 30_000, timeoutMsg: "Clearing marker B's digit did not persist" },
    );
  });
});
