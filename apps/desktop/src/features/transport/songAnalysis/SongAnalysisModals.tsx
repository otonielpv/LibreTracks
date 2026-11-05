import type { TransportSnapshot } from "../desktopApi";
import { BatchSongAnalysisModal } from "./BatchSongAnalysisModal";
import { SongAnalysisModal } from "./SongAnalysisModal";

/** "Analizar canción" and "Analizar todas las canciones", mounted together. */
export function SongAnalysisModals({
  onApplied,
}: {
  onApplied: (snapshot: TransportSnapshot) => void;
}) {
  return (
    <>
      <SongAnalysisModal onApplied={onApplied} />
      <BatchSongAnalysisModal onApplied={onApplied} />
    </>
  );
}
