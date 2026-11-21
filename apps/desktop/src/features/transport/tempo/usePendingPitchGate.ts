import { useCallback, useEffect, useRef } from "react";

import type { SongRegionSummary } from "@libretracks/shared/models";

import { usePreparationStatusStore } from "../preparationStatusStore";
import { usePendingPitchStore } from "./pendingPitchStore";

type Deps = {
  /** El ajuste «Cambio de tono preparado». Apagado, todo pasa al momento. */
  enabled: boolean;
  selectedRegion: SongRegionSummary | null;
  applyTranspose: (nextTransposeSemitones: number) => void;
  applyTempo: (region: SongRegionSummary, nextBpm: number) => void;
  /** Tempo efectivo de cada región: lo que «Cancelar» restaura. */
  bpmByRegion: Record<string, number>;
};

/**
 * Pone «Aplicar» delante del tono y el tempo cuando el ajuste está activo.
 * Devuelve los handlers que reciben los controles de las vistas: con el
 * ajuste apagado son los de siempre; encendido, guardan el valor en
 * `usePendingPitchStore` y `apply` (registrado aquí) los envía de una vez.
 *
 * Los atajos de teclado y MIDI siguen usando los handlers directos: un pedal
 * no tiene botón de aplicar.
 */
export function usePendingPitchGate({
  enabled,
  selectedRegion,
  applyTranspose,
  applyTempo,
  bpmByRegion,
}: Deps) {
  const latest = useRef({ enabled, selectedRegion, applyTranspose, applyTempo, bpmByRegion });
  latest.current = { enabled, selectedRegion, applyTranspose, applyTempo, bpmByRegion };

  // Lo pendiente es de una región: cambiar de canción o apagar el ajuste lo
  // descarta, para no aplicar luego un tono elegido para otra.
  const selectedRegionId = selectedRegion?.id ?? null;
  useEffect(() => {
    const state = usePendingPitchStore.getState();
    if (!enabled || (state.regionId !== null && state.regionId !== selectedRegionId)) {
      state.clear();
    }
    if (!enabled || (state.undo && state.undo.regionId !== selectedRegionId)) {
      usePendingPitchStore.setState({ undo: null });
    }
  }, [enabled, selectedRegionId]);

  // Terminada la preparación ya no hay nada que cancelar: sin esto, otra
  // preparación posterior ofrecería deshacer un tono aplicado hace rato.
  useEffect(
    () =>
      usePreparationStatusStore.subscribe((state, prev) => {
        if (prev.pitch.active && !state.pitch.active) {
          usePendingPitchStore.setState({ undo: null });
        }
      }),
    [],
  );

  useEffect(() => {
    usePendingPitchStore.setState({
      apply: () => {
        const { regionId, transpose, bpm, clear } = usePendingPitchStore.getState();
        const { selectedRegion: region, applyTranspose: transposeNow, applyTempo: tempoNow } =
          latest.current;
        clear();
        if (!region || region.id !== regionId) return;
        usePendingPitchStore.setState({
          undo: {
            regionId: region.id,
            transpose: transpose !== null ? region.transposeSemitones : null,
            bpm: bpm !== null ? (latest.current.bpmByRegion[region.id] ?? null) : null,
          },
        });
        if (transpose !== null) transposeNow(transpose);
        if (bpm !== null) tempoNow(region, bpm);
      },
      revert: () => {
        const { undo } = usePendingPitchStore.getState();
        const { selectedRegion: region, applyTranspose: transposeNow, applyTempo: tempoNow } =
          latest.current;
        usePendingPitchStore.setState({ undo: null });
        if (!undo || !region || region.id !== undo.regionId) return;
        // Volver al tono anterior basta: el backend descarta de la cola (y
        // cancela en curso) lo que ya no hace falta.
        if (undo.transpose !== null) transposeNow(undo.transpose);
        if (undo.bpm !== null) tempoNow(region, undo.bpm);
      },
    });
    return () => usePendingPitchStore.setState({ apply: null, revert: null });
  }, []);

  const onTransposeChange = useCallback((nextTransposeSemitones: number) => {
    const { enabled: gated, selectedRegion: region, applyTranspose: transposeNow } =
      latest.current;
    if (!gated) {
      transposeNow(nextTransposeSemitones);
      return;
    }
    if (!region) return;
    const clamped = Math.max(-12, Math.min(12, Math.round(nextTransposeSemitones)));
    // Volver al tono que ya suena no deja nada pendiente.
    usePendingPitchStore
      .getState()
      .setTranspose(region.id, clamped === region.transposeSemitones ? null : clamped);
  }, []);

  const onTempoChange = useCallback((region: SongRegionSummary, nextBpm: number) => {
    const { enabled: gated, applyTempo: tempoNow } = latest.current;
    if (!gated) {
      tempoNow(region, nextBpm);
      return;
    }
    if (!Number.isFinite(nextBpm)) return;
    usePendingPitchStore.getState().setBpm(region.id, nextBpm);
  }, []);

  return { onTransposeChange, onTempoChange };
}
