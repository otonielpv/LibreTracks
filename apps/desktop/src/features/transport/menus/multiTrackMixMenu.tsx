import type { TrackSummary } from "@libretracks/shared/models";

import {
  MultiTrackMixControls,
  type MultiTrackMixActions,
} from "../tracks/MultiTrackMixControls";
import type { ContextMenuAction } from "../types";

export type { MultiTrackMixActions };

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type MultiTrackMixMenuArgs = {
  tracks: TrackSummary[];
  t: Translate;
  routingOptions: Array<{ value: string; label: string }>;
  mix: MultiTrackMixActions;
};

/**
 * Volumen, paneo y salida de una multiseleccion: los faders de siempre, dentro
 * del menu.
 *
 * Eran tres submenus de saltos fijos (+3 dB, −1 dB, «centrar»…) porque en un
 * telefono la cabecera de pista se queda en el nombre y no hay fader que
 * arrastrar. Pero un DAW se mezcla con faders, no eligiendo escalones de una
 * lista: aqui va la misma fila de controles que tiene una pista, aplicada al
 * grupo entero. Ver MultiTrackMixControls para el reparto.
 */
export function multiTrackMixActions({
  tracks,
  t,
  routingOptions,
  mix,
}: MultiTrackMixMenuArgs): ContextMenuAction[] {
  if (!tracks.length) {
    return [];
  }

  return [
    {
      label: t("transport.menu.mixOfTracks", { count: tracks.length }),
      content: (
        <MultiTrackMixControls
          tracks={tracks}
          routingOptions={routingOptions}
          mix={mix}
        />
      ),
      onSelect: () => {},
    },
  ];
}
