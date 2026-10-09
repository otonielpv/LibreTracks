import { useEffect, useState } from "react";

import { readSongRegionChart } from "../desktopApi";
import { openChartDocument, type ChartDocument } from "./pdfLoader";

export type ChartDocumentState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ready"; document: ChartDocument; aspects: number[] }
  | { status: "error"; message: string };

/**
 * The PDF of one song, parsed. Only ONE document is alive at a time: changing
 * song destroys the previous one, so a 30-song setlist never holds 30 parsed
 * PDFs in a phone's memory.
 *
 * `filePath` is part of the key so replacing the chart reloads it even though
 * the song is the same.
 */
export function useChartDocument(
  regionId: string | null,
  filePath: string | null,
): ChartDocumentState {
  const [state, setState] = useState<ChartDocumentState>({ status: "none" });

  useEffect(() => {
    if (!regionId || !filePath) {
      setState({ status: "none" });
      return;
    }
    let cancelled = false;
    let opened: ChartDocument | null = null;
    setState({ status: "loading" });

    void (async () => {
      try {
        const bytes = await readSongRegionChart(regionId);
        if (cancelled) return;
        opened = await openChartDocument(bytes);
        if (cancelled) {
          void opened.destroy();
          return;
        }
        // Page proportions up front: the layout needs every page's height
        // before any is drawn, or the scroll position of an anchor would move
        // as pages render.
        const aspects: number[] = [];
        for (let index = 1; index <= opened.numPages; index += 1) {
          const page = await opened.getPage(index);
          const viewport = page.getViewport({ scale: 1 });
          aspects.push(viewport.height / viewport.width);
          if (cancelled) return;
        }
        setState({ status: "ready", document: opened, aspects });
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      if (opened) void opened.destroy();
    };
  }, [regionId, filePath]);

  return state;
}
