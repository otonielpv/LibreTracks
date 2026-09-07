import type { MutableRefObject } from "react";
import type { AutomationCueSummary, LibraryAssetSummary, SongView, TransportSnapshot } from "../desktopApi";

export type MobilePreparationProps = {
  positionRef: MutableRefObject<number>;
  assets: LibraryAssetSummary[];
  importing: boolean;
  importMessage?: string;
  routes: Array<{ value: string; label: string }>;
  /** Zoom que encuadra toda la sesión, ya medido por el panel de transporte. */
  fitZoomLevel: number;
  /** Ancho útil de lanes (viewport de scroll menos la columna de cabeceras). */
  laneViewportWidth: number;
  onImport: (options?: { placeAfterImport?: boolean }) => unknown;
  onLibrary: () => void;
  onSettings: () => void;
  onSave: () => unknown;
  onSnapshot: (snapshot: TransportSnapshot | null) => void;
  refreshSong: (options?: { includeWaveforms?: boolean }) => Promise<unknown>;
  onCreateCue: (seconds: number) => void;
  onEditCue: (cue: AutomationCueSummary) => void;
  normalizeSeconds: (seconds: number, duration: number) => number;
};
export type MobileRun = (work: () => Promise<TransportSnapshot>) => Promise<boolean>;
export type MobilePanelProps = {
  song: SongView;
  regionId: string;
  run: MobileRun;
  positionRef: MutableRefObject<number>;
};
