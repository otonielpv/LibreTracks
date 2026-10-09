import type { PdfPageText } from "./pdfTextLines";

/**
 * pdf.js, loaded the first time a PDF is imported: ~400 KB of library plus a
 * 1.4 MB worker that nobody who never imports a chart should pay for at
 * startup. Only its TEXT extraction is used — the PDF is never drawn.
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

/** The positioned text of every page. */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfPageText[]> {
  const pdfjs = await loadPdfJs();
  const document = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  try {
    const pages: PdfPageText[] = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push({
        width: viewport.width,
        height: viewport.height,
        items: content.items.flatMap((item) => {
          if (!("str" in item) || !item.str) return [];
          const [, , , d, x, y] = item.transform as number[];
          return [{ str: item.str, x, y, width: item.width, size: Math.abs(d) || item.height }];
        }),
      });
    }
    return pages;
  } finally {
    void document.destroy();
  }
}
