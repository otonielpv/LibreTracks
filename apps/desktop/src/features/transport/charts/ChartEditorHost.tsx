import { useCallback } from "react";

import type { SongChart } from "@libretracks/shared/models";

import { ChartEditorModal } from "./ChartEditorModal";
import { useChartEditorStore } from "./chartEditorStore";
import "./LiveChartPanel.css";

/**
 * El único sitio donde se monta el editor de letra y acordes, fuera de las
 * vistas (ver `chartEditorStore`). Lo monta `LyricsRoot`.
 */
export function ChartEditorHost() {
  const session = useChartEditorStore((state) => state.session);
  const close = useChartEditorStore((state) => state.close);
  const onSave = session?.onSave;
  const save = useCallback(
    async (next: SongChart | null) => {
      if (!onSave) return;
      await onSave(next);
      close();
    },
    [onSave, close],
  );
  if (!session) return null;
  return (
    <ChartEditorModal
      key={session.region.id}
      region={session.region}
      markers={session.markers}
      chart={session.chart}
      secondsPerBeatAt={session.secondsPerBeatAt}
      onSave={save}
      onClose={close}
      initialImport={session.initialImport}
      initialMode={session.initialMode}
    />
  );
}
