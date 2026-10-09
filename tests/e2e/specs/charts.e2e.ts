import { $, $$, browser, expect } from "@wdio/globals";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AppPage from "../pageobjects/app.page.js";
import { removeWorkDir } from "../utils/workdir.js";

/**
 * Lyrics and chords in the REAL WebView: what the unit tests cannot show is
 * that pdf.js and its worker load from the app's own origin and read the text
 * of a PDF, and that the result shows up in the live view following the song.
 *
 * The PDF is generated here: two columns, a section header, a chord line over
 * a lyric line — the shape of a typical one-page chord sheet — in the standard
 * Helvetica font, so no font file is involved.
 */
function chordSheetPdf(): Buffer {
  const text = (x: number, y: number, size: number, value: string) =>
    `BT /F1 ${size} Tf ${x} ${y} Td (${value}) Tj ET`;
  const content = [
    text(50, 760, 18, "Cancion de Prueba [G]"),
    text(36, 700, 12, "VERSO 1"),
    text(36, 686, 12, "G"),
    text(120, 686, 12, "D"),
    text(36, 672, 12, "Camino por la senda del Senor"),
    text(36, 646, 12, "Em"),
    text(36, 632, 12, "Con paso firme voy"),
    text(320, 700, 12, "CORO"),
    text(320, 686, 12, "C"),
    text(400, 686, 12, "G"),
    text(320, 672, 12, "Santo eres tu Senor"),
    text(320, 646, 12, "Am"),
    text(320, 632, 12, "Digno de honor"),
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

type ChartRegion = {
  id: string;
  chart?: { text: string; links: Array<{ markerId: string; section: number }> } | null;
};

async function regions(): Promise<ChartRegion[]> {
  const view = (await AppPage.songView()) as unknown as { regions: ChartRegion[] } | null;
  return view?.regions ?? [];
}

describe("Lyrics and chords in the live view", () => {
  let workDir = "";
  let verseId = "";
  let chorusId = "";

  before(async () => {
    await AppPage.waitUntilBooted();
    await AppPage.resetShell();
    workDir = mkdtempSync(path.join(tmpdir(), "lt-e2e-chart-"));
    await AppPage.createSession("E2E Chart Session", workDir);

    await AppPage.createSongRegion(0, 40);
    await browser.waitUntil(async () => (await regions()).length === 1, {
      timeoutMsg: "The song was not created",
    });
    verseId = await AppPage.createSectionMarker(0);
    chorusId = await AppPage.createSectionMarker(20);
    await AppPage.setSectionMarkerKind(verseId, "verse", null);
    await AppPage.setSectionMarkerKind(chorusId, "chorus", null);
  });

  after(async () => {
    await browser.execute(() => (window as any).__ltE2E.setViewMode("daw"));
    removeWorkDir(workDir);
  });

  it("converts a two-column PDF into lyrics linked to the song's markers", async () => {
    await browser.execute(() => {
      window.localStorage.removeItem("lt.liveView.chartOpen");
      (window as any).__ltE2E.setViewMode("live");
    });
    // The song must have reached the view: before that the panel says
    // "select a song" and offers no import.
    await (await $(".lt-live-chart-action.is-primary")).waitForDisplayed({ timeout: 15_000 });

    // tauri-driver cannot attach a file to an <input type="file">, so the
    // file is handed to the input from the page, through the same `change`
    // event the native picker fires. Everything after — pdf.js, the converter,
    // the save — is the real path.
    const pdfBase64 = chordSheetPdf().toString("base64");
    await browser.execute((base64: string) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const file = new File([bytes], "hoja.pdf", { type: "application/pdf" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = document.querySelector<HTMLInputElement>("[data-testid='live-chart-file-input']")!;
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, pdfBase64);
    await browser.waitUntil(async () => Boolean((await regions())[0]?.chart), {
      timeout: 30_000,
      timeoutMsg: "pdf.js did not turn the PDF into a chart",
    });
    const chart = (await regions())[0].chart!;
    expect(chart.text).toContain("{title: Cancion de Prueba}");
    expect(chart.text).toContain("{key: G}");
    expect(chart.text).toContain("{section: Verso 1}");
    expect(chart.text).toContain("{section: Coro}");
    // The left column is read before the right one.
    expect(chart.text.indexOf("Camino")).toBeLessThan(chart.text.indexOf("Santo"));
    expect(chart.text).toMatch(/\[G\]Camino por la /);
    expect(chart.links).toEqual([
      { markerId: verseId, section: 0 },
      { markerId: chorusId, section: 1 },
    ]);

    await browser.waitUntil(async () => (await $$(".lt-live-chart .lt-chart-line").length) === 4, {
      timeoutMsg: "The lyrics did not render in the live view",
    });
    expect(await (await $(".lt-chart-section.is-current .lt-chart-section-label")).getText()).toMatch(/verso 1/i);
    await browser.saveScreenshot(path.join(tmpdir(), "lt-e2e-live-chart.png"));
  });

  it("opens the editor with its buttons below the scrolling form", async () => {
    await (await $(".lt-live-chart button[aria-label='Editar letra y sincronía'], .lt-live-chart button[aria-label='Edit lyrics and sync']")).click();
    const dialog = await $(".lt-chart-editor");
    await dialog.waitForDisplayed();
    const layout = await browser.execute(() => {
      const body = document.querySelector(".lt-chart-editor-body")!.getBoundingClientRect();
      const actions = document.querySelector(".lt-chart-editor-actions")!.getBoundingClientRect();
      return { bodyBottom: body.bottom, actionsTop: actions.top };
    });
    expect(layout.actionsTop).toBeGreaterThanOrEqual(layout.bodyBottom - 1);
    await browser.saveScreenshot(path.join(tmpdir(), "lt-e2e-chart-editor.png"));
    await (await $(".lt-chart-editor-actions .lt-secondary-button:not(.lt-chart-editor-remove)")).click();
    await dialog.waitForExist({ reverse: true });
  });

  it("hides the lyrics panel from the header", async () => {
    await (await $(".lt-live-chart-toggle")).click();
    await browser.waitUntil(async () => !(await $(".lt-live-chart").isExisting()), {
      timeoutMsg: "The lyrics panel did not hide",
    });
    await (await $(".lt-live-chart-toggle")).click();
    await (await $(".lt-live-chart")).waitForDisplayed();
  });
});
