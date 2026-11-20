import { useMemo } from "react";
import { create } from "zustand";

import { eqTranslator, type EqLanguage } from "@libretracks/shared/eq/eqTexts";
import {
  TrackEqEditor,
  type TrackEqEditorHandlers,
} from "@libretracks/shared/eq/TrackEqEditor";
import { defaultTrackEq, sanitizeTrackEq, trackEqIsActive } from "@libretracks/shared/eq/trackEqModel";
import type { TrackEq, TrackSummary } from "@libretracks/shared/models";

/**
 * EQ desde el remote (plan track-eq-2, E7): el MISMO editor que el
 * escritorio (`packages/shared/src/eq`) con acciones por WebSocket.
 *
 * - En vivo (`updateTrackEqLive`): solo motor, como mucho un envío por
 *   frame aunque el editor pida más.
 * - Al soltar (`commitTrackEq`): modelo + un paso de deshacer en el
 *   escritorio. La canción del remote se parchea en el acto (`onLocalCommit`)
 *   para que el editor no vuelva al valor viejo hasta que llegue el songView.
 */

type Send = (command: Record<string, unknown>) => void;

export const useRemoteEqStore = create<{
  openTrackId: string | null;
  setOpenTrackId: (trackId: string | null) => void;
}>()((set) => ({
  openTrackId: null,
  setOpenTrackId: (openTrackId) => set({ openTrackId }),
}));

type FrameApi = {
  request: (callback: () => void) => number;
  cancel: (handle: number) => void;
};

const browserFrames: FrameApi = {
  request: (callback) =>
    typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame(callback)
      : (setTimeout(callback, 16) as unknown as number),
  cancel: (handle) =>
    typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function"
      ? window.cancelAnimationFrame(handle)
      : clearTimeout(handle),
};

export function createRemoteEqHandlers(
  send: Send,
  onLocalCommit: (trackId: string, eq: TrackEq | null) => void,
  frames: FrameApi = browserFrames,
): TrackEqEditorHandlers {
  let pending: { trackId: string; eq: TrackEq | null } | null = null;
  let handle: number | null = null;
  const flush = () => {
    handle = null;
    if (!pending) return;
    send({ cmd: "updateTrackEqLive", trackId: pending.trackId, eq: pending.eq });
    pending = null;
  };
  const commit = (trackId: string, eq: TrackEq | null) => {
    // Lo que quedara en vivo ya no hace falta: el commit lleva la curva final.
    if (handle !== null) frames.cancel(handle);
    handle = null;
    pending = null;
    const clean = eq ? sanitizeTrackEq(eq) : null;
    onLocalCommit(trackId, clean);
    send({ cmd: "commitTrackEq", trackId, eq: clean });
    return Promise.resolve();
  };
  return {
    close: () => useRemoteEqStore.getState().setOpenTrackId(null),
    applyLive: (trackId, eq) => {
      pending = { trackId, eq: eq ? sanitizeTrackEq(eq) : null };
      if (handle === null) handle = frames.request(flush);
    },
    commit,
    reset: (trackId) => commit(trackId, defaultTrackEq()),
    remove: (trackId) => {
      const done = commit(trackId, null);
      useRemoteEqStore.getState().setOpenTrackId(null);
      return done;
    },
    // El RTA del remote llega en el paso 07.
    startAnalyzer: () => undefined,
    stopAnalyzer: () => undefined,
    readSpectrum: () => Promise.resolve([]),
  };
}

function isCoarsePointer() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;
}

/** El editor abierto, si lo hay. Montado una vez en la app. */
export function RemoteTrackEqHost({
  tracks,
  send,
  onLocalCommit,
  language,
}: {
  tracks: TrackSummary[];
  send: Send;
  onLocalCommit: (trackId: string, eq: TrackEq | null) => void;
  language: EqLanguage;
}) {
  const openTrackId = useRemoteEqStore((state) => state.openTrackId);
  const handlers = useMemo(() => createRemoteEqHandlers(send, onLocalCommit), [send, onLocalCommit]);
  const t = useMemo(() => eqTranslator(language), [language]);
  const track = openTrackId ? tracks.find((candidate) => candidate.id === openTrackId) : null;
  if (!track || track.kind !== "audio") return null;
  return (
    <TrackEqEditor
      key={track.id}
      track={track}
      handlers={handlers}
      t={t}
      isMobile={isCoarsePointer()}
    />
  );
}

/** Botón «EQ» de la tira: solo en pistas de audio, encendido si suena. */
export function RemoteEqButton({ track, language }: { track: TrackSummary; language: EqLanguage }) {
  if (track.kind !== "audio") return null;
  const t = eqTranslator(language);
  const active = trackEqIsActive(track.eq);
  return (
    <button
      type="button"
      className={`is-eq ${active ? "is-active" : ""}`}
      aria-pressed={active}
      aria-label={t("eq.openFor", { name: track.name })}
      title={t("eq.openFor", { name: track.name })}
      onClick={() => useRemoteEqStore.getState().setOpenTrackId(track.id)}
    >
      {t("eq.open")}
    </button>
  );
}
