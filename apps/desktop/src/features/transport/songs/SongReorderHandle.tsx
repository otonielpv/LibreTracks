import { useTranslation } from "react-i18next";

import type { useSongReorder } from "./useSongReorder";
import "./songReorder.css";

export type SongReorderHandleProps = ReturnType<
  ReturnType<typeof useSongReorder>["handleProps"]
>;

/**
 * Asa para arrastrar una canción a otra posición de la lista. Es la única
 * forma de hacerlo con el dedo: lleva `touch-action: none` para que el gesto
 * no se convierta en scroll. Enfocada, las flechas la mueven un puesto.
 */
export function SongReorderHandle({
  name,
  handleProps,
  className = "",
}: {
  name: string;
  handleProps: SongReorderHandleProps;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = t("liveView.reorderSong", { name });
  return (
    <span
      role="button"
      tabIndex={0}
      className={`lt-song-reorder-handle ${className}`}
      aria-label={label}
      title={label}
      {...handleProps}
    >
      <span className="material-symbols-outlined" aria-hidden="true">
        drag_indicator
      </span>
    </span>
  );
}
