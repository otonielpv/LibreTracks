import { analyzeSongSheet, chordProFromText, type MeasureText } from "./chartImport";
import { serializeChordPro } from "./chordChart";
import { extractPdfText } from "./pdfLoader";
import { pdfTextToSourceLines } from "./pdfTextLines";

/** What the file picker offers: PDFs and the text formats chart apps export. */
export const CHART_FILE_ACCEPT =
  "application/pdf,.pdf,.cho,.crd,.chopro,.chordpro,.pro,.txt,text/plain";

/** Larger than any song sheet; refuses a book scanned by mistake. */
export const MAX_CHART_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Character offsets measured with a real sans-serif font, scaled to the width
 * the PDF gives the run. Proportional fonts make uniform widths drift by a
 * syllable over a long line; this keeps chords on the syllable they sit on.
 */
function canvasMeasure(): MeasureText | undefined {
  if (typeof document === "undefined") return undefined;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return undefined;
  context.font = "100px Helvetica, Arial, sans-serif";
  return (text, width) => {
    const total = context.measureText(text).width;
    if (!total || !text) return Array.from({ length: text.length }, () => 0);
    const scale = width / total;
    const offsets: number[] = [];
    for (let index = 0; index < text.length; index += 1) {
      offsets.push(context.measureText(text.slice(0, index)).width * scale);
    }
    return offsets;
  };
}

/** Any supported file → ChordPro text. */
export async function chordProFromFile(file: File): Promise<string> {
  if (file.size > MAX_CHART_FILE_BYTES) {
    throw new Error(`chart-file-too-large:${Math.round(file.size / 1048576)}`);
  }
  const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
  if (isPdf) {
    const pages = await extractPdfText(new Uint8Array(await file.arrayBuffer()));
    const doc = analyzeSongSheet(pdfTextToSourceLines(pages), canvasMeasure());
    if (doc.sections.every((section) => section.lines.length === 0)) {
      // A scanned sheet is a picture: there is no text to read.
      throw new Error("chart-pdf-no-text");
    }
    return serializeChordPro(doc);
  }
  return chordProFromText(await file.text());
}
