import { memo, useState } from "react";
import type { SongRegionSummary } from "@libretracks/shared/models";

import { LiveChartPanel } from "../charts/LiveChartPanel";
import type { PerformanceBindings } from "../songs/songViewBindings";

type SetlistLyricsProps = {
  performance: Pick<PerformanceBindings, "song" | "positionSecondsRef" | "pendingMarkerId" | "onChartChange">;
  /** The song the view shows (the selected one). */
  region: SongRegionSummary | null;
  onClose: () => void;
  /** Edit → Lyrics: open with the editor showing. */
  startEditing?: boolean;
};

/**
 * Lyrics and chords in the Setlist view: Live's own panel (import, edit,
 * record line times, follow the sections) on the song the view shows, with
 * Live's `onChartChange` — one definition. Nothing of the panel is rewritten.
 */
function SetlistLyricsComponent({ performance, region, onClose, startEditing = false }: SetlistLyricsProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`lt-setlist-lyrics${expanded ? " is-expanded" : ""}`}>
      <LiveChartPanel
        key={region?.id ?? "none"}
        song={performance.song}
        region={region}
        positionSecondsRef={performance.positionSecondsRef}
        pendingMarkerId={performance.pendingMarkerId}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((value) => !value)}
        onClose={onClose}
        onChartChange={performance.onChartChange}
        startEditing={startEditing}
      />
    </div>
  );
}

export const SetlistLyrics = memo(SetlistLyricsComponent);
