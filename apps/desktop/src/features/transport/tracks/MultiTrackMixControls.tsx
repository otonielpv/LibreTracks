import { useTranslation } from "react-i18next";

import type { TrackSummary } from "@libretracks/shared/models";

import { TrackMixControls } from "./TrackMixControls";
import { useTransportStore } from "../store";

/** Volumen, paneo, salida y transposicion, tal cual los aplica una pista. */
export type MultiTrackMixActions = {
  setVolume: (trackId: string, volume: number) => void;
  commitVolume: (trackId: string) => void;
  setPan: (trackId: string, pan: number) => void;
  commitPan: (trackId: string) => void;
  setAudioTo: (trackId: string, audioTo: string) => void;
  toggleTranspose: (trackId: string) => void;
};

export type MultiTrackMixControlsProps = {
  tracks: TrackSummary[];
  routingOptions: Array<{ value: string; label: string }>;
  mix: MultiTrackMixActions;
};

/**
 * El panel de una pista, para una seleccion entera.
 *
 * Es la MISMA fila de controles que despliega una cabecera al tocarla, no un
 * sucedaneo: en un telefono la cabecera se queda en el nombre y el par
 * mute/solo, asi que sin esto no hay forma de tocar el volumen, el paneo o la
 * salida de varias pistas a la vez.
 *
 * No hace falta nada especial para repartir: se le habla a UNA pista de la
 * seleccion —la primera— y los handlers de la cabecera ya fanean al resto,
 * porque es literalmente el mismo camino que arrastrar su fader en la columna
 * de pistas. Volumen y paneo van en RELATIVO (el grupo conserva su equilibrio
 * en vez de aplanarse a un valor); salida y transposicion en absoluto, que es
 * lo unico que tiene sentido igualar.
 */
export function MultiTrackMixControls({
  tracks,
  routingOptions,
  mix,
}: MultiTrackMixControlsProps) {
  const { t } = useTranslation();
  const leader = tracks[0];
  // La mezcla optimista es la que se mueve mientras se arrastra; sin ella el
  // numero y el pulgar se quedarian en el valor persistido.
  const optimistic = useTransportStore((state) =>
    leader ? state.optimisticMix[leader.id] ?? null : null,
  );

  if (!leader) {
    return null;
  }

  // "Heredada" solo existe dentro de una carpeta, y aplicarla a una pista de
  // primer nivel se descarta en silencio: no se ofrece si alguna no cabe.
  const routeOptions = tracks.every((track) => track.parentTrackId)
    ? [
        {
          value: "inherit",
          label: t("trackHeader.inherited", {
            defaultValue: "Inherited (Folder)",
          }),
        },
        ...routingOptions,
      ]
    : routingOptions;

  return (
    <>
      <div className="lt-track-control-row">
        <div className="lt-track-toggle-group">
          <button
            type="button"
            className={`lt-track-toggle-transpose ${
              leader.transposeEnabled ? "is-active" : ""
            }`}
            aria-label={
              leader.transposeEnabled
                ? t("trackHeader.transposeDisableAria", { name: leader.name })
                : t("trackHeader.transposeEnableAria", { name: leader.name })
            }
            aria-pressed={leader.transposeEnabled}
            onClick={() => mix.toggleTranspose(leader.id)}
          >
            T
          </button>
        </div>
        <TrackMixControls
          trackId={leader.id}
          trackName={leader.name}
          volumeValue={optimistic?.volume ?? leader.volume}
          panValue={optimistic?.pan ?? leader.pan}
          audioTo={leader.audioTo}
          routeOptions={routeOptions}
          onVolumeChange={mix.setVolume}
          onCommitVolume={mix.commitVolume}
          onPanChange={mix.setPan}
          onCommitPan={mix.commitPan}
          onAudioToChange={mix.setAudioTo}
        />
      </div>
      <small className="lt-mobile-selection-mix-hint">
        {t("transport.menu.mixAppliesTo", { count: tracks.length })}
      </small>
    </>
  );
}
