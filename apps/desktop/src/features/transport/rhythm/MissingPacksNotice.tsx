// «Falta el pack X» (plan drum-loops, paso 12): el loop de una canción que usa
// sonidos de un pack no instalado conserva su patrón (las filas de ese pack
// callan) y ofrece descargarlo. Los packs instalados se sacan del listado de
// muestras, que funciona sin red.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { RegionLoop } from "@libretracks/shared/models";

import { downloadRhythmPack, listRhythmSamples } from "../desktopApi";
import { formatRhythmError } from "./rhythmErrors";
import { useRhythmStore } from "./rhythmStore";

export function packsUsedByLoop(songLoop: RegionLoop | null | undefined): string[] {
  const kit = songLoop?.pattern.kit;
  if (!kit || kit.kind !== "embedded") return [];
  const packs = new Set<string>();
  for (const sound of kit.kit.sounds) if (sound.sample.source.kind === "pack") packs.add(sound.sample.source.packId);
  return [...packs];
}

export function MissingPacksNotice({ songLoop }: { songLoop: RegionLoop | null | undefined }) {
  const { t } = useTranslation();
  const used = packsUsedByLoop(songLoop);
  const usedKey = used.join("|");
  const [installed, setInstalled] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setLibrary = useRhythmStore((s) => s.setLibrary);

  const refresh = () =>
    listRhythmSamples()
      .then((samples) =>
        setInstalled(
          new Set(samples.flatMap((s) => (s.sample.source.kind === "pack" ? [s.sample.source.packId] : []))),
        ),
      )
      .catch(() => setInstalled(new Set()));

  useEffect(() => {
    if (usedKey) void refresh();
  }, [usedKey]);

  if (!installed) return null;
  const missing = used.filter((id) => !installed.has(id));
  if (missing.length === 0) return null;
  return (
    <div className="lt-missing-packs" role="status" data-testid="missing-packs">
      {missing.map((packId) => (
        <div key={packId} className="lt-missing-packs__item">
          <span>{t("rhythm.packs.missing", { name: packId })}</span>
          <button
            type="button"
            className="lt-rhythm-chip is-active"
            disabled={busy !== null}
            onClick={async () => {
              setBusy(packId);
              setError(null);
              try {
                setLibrary(await downloadRhythmPack(packId));
                await refresh();
              } catch (e) {
                setError(formatRhythmError(e, t));
              } finally {
                setBusy(null);
              }
            }}
          >
            {t("rhythm.packs.download")}
          </button>
        </div>
      ))}
      {error ? <span className="lt-sample-picker__error">{error}</span> : null}
    </div>
  );
}
