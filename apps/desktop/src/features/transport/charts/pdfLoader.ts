import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * pdf.js, loaded the first time a chart is opened: ~400 KB of library plus a
 * 1.4 MB worker that nobody who never uses charts should pay for at startup.
 *
 * The LEGACY build because the desktop floor is Safari 13 (macOS WebView) and
 * the modern build uses syntax and APIs that WebKit lacks.
 */
type PdfJs = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<PdfJs>,
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ])
    .then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
      return pdfjs;
    })
    .catch((error: unknown) => {
      // A failed chunk load must not poison every later attempt.
      pdfjsPromise = null;
      throw error;
    });
  return pdfjsPromise;
}

export type ChartDocument = PDFDocumentProxy;

/** Parses a PDF. The caller owns the document and must `destroy()` it. */
export async function openChartDocument(bytes: Uint8Array): Promise<ChartDocument> {
  const pdfjs = await loadPdfJs();
  return pdfjs.getDocument({
    data: bytes,
    // Fonts the PDF does not embed are drawn with system fonts; fetching the
    // standard ones from a CDN would fail offline on stage.
    disableFontFace: false,
    isEvalSupported: false,
  }).promise;
}
