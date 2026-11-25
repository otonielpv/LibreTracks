// «Descargar sonidos» (plan drum-loops, paso 11): catálogo de packs gratuitos
// con su progreso de descarga. Desinstalar un pack en uso avisa.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { RhythmPackProgress, RhythmPacksCatalog } from "@libretracks/shared/models";

import {
  deleteRhythmPack,
  downloadRhythmPack,
  getRhythmPacksCatalog,
  listenToRhythmPackProgress,
} from "../desktopApi";
import { formatRhythmError } from "./rhythmErrors";
import { useRhythmStore } from "./rhythmStore";

function megabytes(bytes: number) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export function PackCatalog({ onInstalled, confirm }: { onInstalled?: () => void; confirm?: (message: string) => boolean }) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<RhythmPacksCatalog | null>(null);
  const [progress, setProgress] = useState<Record<string, RhythmPackProgress>>({});
  const [error, setError] = useState<string | null>(null);
  const library = useRhythmStore((s) => s.library);
  const setLibrary = useRhythmStore((s) => s.setLibrary);

  const refresh = () =>
    getRhythmPacksCatalog()
      .then(setCatalog)
      .catch(() => setCatalog({ packs: [], offline: true }));

  useEffect(() => {
    void refresh();
    let alive = true;
    let unlisten: (() => void) | null = null;
    void listenToRhythmPackProgress((p) => setProgress((all) => ({ ...all, [p.packId]: p }))).then((stop) => {
      if (alive) unlisten = stop;
      else stop();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const download = async (packId: string) => {
    setError(null);
    try {
      setLibrary(await downloadRhythmPack(packId));
      await refresh();
      onInstalled?.();
    } catch (e) {
      setError(formatRhythmError(e, t));
    }
  };

  const remove = async (packId: string) => {
    const used = library?.patterns.filter((p) => p.kit.kind === "library" && p.kit.kitId === packId).length ?? 0;
    if (used > 0) {
      const message = t("rhythm.packs.removeUsed", { count: used });
      if (!(confirm ? confirm(message) : window.confirm(message))) return;
    }
    setLibrary(await deleteRhythmPack(packId));
    await refresh();
  };

  if (!catalog) return null;
  return (
    <div className="lt-pack-catalog" data-testid="pack-catalog">
      <span className="lt-rhythm-field__label">{t("rhythm.packs.title")}</span>
      {catalog.offline ? (
        <p className="lt-pack-catalog__note">{t("rhythm.packs.offline")}</p>
      ) : catalog.packs.length === 0 ? (
        <p className="lt-pack-catalog__note">{t("rhythm.packs.none")}</p>
      ) : null}
      {catalog.packs.map((pack) => {
        const p = progress[pack.id];
        const busy = p !== undefined && !p.done;
        const percent = p && p.total > 0 ? Math.round((p.received / p.total) * 100) : 0;
        return (
          <div key={pack.id} className="lt-pack-catalog__item" data-testid={`pack-${pack.id}`}>
            <div className="lt-pack-catalog__text">
              <strong>{pack.name}</strong>
              <span>
                {t(`rhythm.packs.kind.${pack.kind}`)} · {megabytes(pack.sizeBytes)} MB
              </span>
            </div>
            {busy ? (
              <progress max={100} value={percent} aria-label={t("rhythm.packs.downloading", { name: pack.name })} />
            ) : pack.installed ? (
              <button type="button" onClick={() => void remove(pack.id)}>
                {t("rhythm.packs.remove")}
              </button>
            ) : (
              <button type="button" className="is-primary" onClick={() => void download(pack.id)}>
                {t("rhythm.packs.download")}
              </button>
            )}
          </div>
        );
      })}
      {error ? (
        <p className="lt-sample-picker__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
