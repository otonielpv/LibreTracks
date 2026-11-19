// Una zona con nombre de la vista Setlist (canciones, banda, consola…).
import type { ReactNode, RefObject } from "react";

import { SONG_DROP_CLASS, type songDropHandlers } from "./songDrop";

/** "overview" is the song band: the waveform with the sections on it. */
export type SetlistZone = "songs" | "overview" | "mixer" | "drawer" | "lyrics";

/** A named, empty slot the later steps fill without stepping on each other. */
export function Zone({
  name,
  children,
  zoneRef,
  drop,
}: {
  name: SetlistZone;
  children?: ReactNode;
  zoneRef?: RefObject<HTMLElement | null>;
  /** Makes the zone a "drop audio into this song" target. */
  drop?: { regionId: string; active: boolean; handlers: ReturnType<typeof songDropHandlers> };
}) {
  return (
    <section
      ref={zoneRef}
      className={`lt-setlist-zone is-${name}${drop ? ` ${SONG_DROP_CLASS}` : ""}${drop?.active ? " is-drop-target" : ""}`}
      data-setlist-zone={name}
      data-region-id={drop?.regionId}
      onDragOver={drop?.handlers.onDragOver}
      onDrop={drop?.handlers.onDrop}
    >
      {children}
    </section>
  );
}
