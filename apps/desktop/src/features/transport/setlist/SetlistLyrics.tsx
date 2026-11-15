import { memo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SongRegionSummary } from "@libretracks/shared/models";

import { LiveChartPanel } from "../charts/LiveChartPanel";
import { useNetworkPermissions } from "../../network/useNetworkPermissions";
import type { PerformanceBindings } from "../songs/songViewBindings";
import { useSetlistStore } from "./setlistStore";

type SetlistLyricsProps = {
  performance: Pick<PerformanceBindings, "song" | "positionSecondsRef" | "pendingMarkerId" | "activeVamp" | "onChartChange">;
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
  const { canEdit } = useNetworkPermissions();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`lt-setlist-lyrics${expanded ? " is-expanded" : ""}`}>
      <LiveChartPanel
        key={region?.id ?? "none"}
        song={performance.song}
        region={region}
        positionSecondsRef={performance.positionSecondsRef}
        pendingMarkerId={performance.pendingMarkerId}
        activeVamp={performance.activeVamp}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((value) => !value)}
        onClose={onClose}
        onChartChange={performance.onChartChange}
        canEdit={canEdit}
        startEditing={startEditing}
      />
    </div>
  );
}

export const SetlistLyrics = memo(SetlistLyricsComponent);

/**
 * Phone, lyrics pane: the lyrics with the view rail on their right, like the
 * console's, or the waveform or the console beside them, as in Live
 * (`lyricsSide`, the Wave/Mix buttons); beside the waveform the buttons go
 * in its dock.
 */
export function SetlistLyricsPane({
  overview,
  mixer,
  lyrics,
  buttons,
}: {
  overview: ReactNode;
  mixer: ReactNode;
  lyrics: ReactNode;
  buttons: ReactNode;
}) {
  const { t } = useTranslation();
  const side = useSetlistStore((state) => state.lyricsSide);
  return (
    <div className={`lt-setlist-lyrics-pane${side !== "none" ? ` has-side is-side-${side}` : ""}`}>
      {side === "song" ? overview : side === "mixer" ? <div className="lt-setlist-bottom">{mixer}</div> : null}
      {lyrics}
      {/* With the waveform beside the lyrics the buttons ride in its dock (a
          rail here cost the waveform width); with the console, at the far right. */}
      {side !== "song" ? (
        <div className="lt-setlist-view-rail" role="toolbar" aria-label={t("setlistView.pane.rail")}>
          {buttons}
        </div>
      ) : null}
    </div>
  );
}
