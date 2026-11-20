import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { isMobileApp } from "@libretracks/shared/desktopApi";
import {
  TrackEqEditor as SharedTrackEqEditor,
  type EqMappable,
  type TrackEqEditorHandlers,
  type TrackEqEditorTrack,
} from "@libretracks/shared/eq/TrackEqEditor";

import { MidiMappable } from "../midi/MidiMappable";
import { trackTarget, type EqControl } from "../midi/controllerTargets";
import { useDismissOnBack } from "../mobile/backNavigation";
import { useTrackEqStore } from "./trackEqStore";

/**
 * El editor de EQ compartido (`packages/shared/src/eq`, plan track-eq-2 E6)
 * montado en el escritorio: los textos de react-i18next, la plataforma, el
 * botón Atrás del móvil, el aviso de varias pistas y el MIDI learn.
 */
export function TrackEqEditor({
  track,
  handlers,
  sampleRate,
  midiLearn = true,
}: {
  track: TrackEqEditorTrack;
  handlers: TrackEqEditorHandlers;
  sampleRate?: number;
  /** El EQ de máster no tiene destinos MIDI: los de pista llevan su id. */
  midiLearn?: boolean;
}) {
  const { t } = useTranslation();
  const close = useCallback(() => handlers.close(), [handlers]);
  useDismissOnBack(close, true);
  const targetCount = useTrackEqStore((state) =>
    state.openTrackId === track.id ? state.targetTrackIds.length : 1,
  );
  const mappable = useCallback<EqMappable>(
    (control, label, element) => (
      <MidiMappable target={trackTarget(track.id, control as EqControl)} label={label}>
        {element as Parameters<typeof MidiMappable>[0]["children"]}
      </MidiMappable>
    ),
    [track.id],
  );
  return (
    <SharedTrackEqEditor
      track={track}
      handlers={handlers}
      t={t}
      isMobile={isMobileApp}
      sampleRate={sampleRate}
      targetCount={targetCount}
      mappable={midiLearn ? mappable : undefined}
    />
  );
}
