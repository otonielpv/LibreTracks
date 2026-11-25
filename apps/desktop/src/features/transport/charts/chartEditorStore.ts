import { create } from "zustand";

import type { SectionMarkerSummary, SongChart, SongRegionSummary } from "@libretracks/shared/models";

import type { AdjustInput } from "../../chartSources/chartImportStore";
import type { ChartEditorMode } from "./simple/editorMode";

/**
 * El editor de letra y acordes abierto, fuera del panel que lo abre.
 *
 * Vivía como `useState` dentro de `LiveChartPanel`. En el teléfono el editor
 * gira la app a vertical (plan portrait-text-modals) y, al girar, la vista de
 * detrás cambia de disposición (Setlist pasa de `short` a otra) y vuelve a
 * montar el panel: el editor se cerraba nada más abrirse y la pantalla volvía
 * a horizontal. Abrir el teclado también cambia el alto. Con la sesión aquí y
 * el editor montado en `ChartEditorHost` (desde `LyricsRoot`), sobrevive a
 * que el panel se desmonte.
 */
export type ChartEditorSession = {
  region: SongRegionSummary;
  markers: SectionMarkerSummary[];
  chart: SongChart | null;
  secondsPerBeatAt: (seconds: number) => number;
  /** Guarda (o borra con `null`); el host cierra el editor al terminar. */
  onSave: (next: SongChart | null) => Promise<void>;
  /** Una hoja recién traída tal cual (Planning Center desde el menú de la
   * canción): el editor la muestra y abre «Ajustar a la secuencia». */
  initialImport?: AdjustInput;
  /** "Write lyrics" opens the simple editor whatever was used last. */
  initialMode?: ChartEditorMode;
};

type ChartEditorState = {
  session: ChartEditorSession | null;
  open: (session: ChartEditorSession) => void;
  close: () => void;
};

export const useChartEditorStore = create<ChartEditorState>((set) => ({
  session: null,
  open: (session) => set({ session }),
  close: () => set({ session: null }),
}));
