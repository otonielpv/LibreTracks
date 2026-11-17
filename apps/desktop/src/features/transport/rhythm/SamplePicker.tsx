// Selector de muestras (plan drum-loops, paso 09): agrupadas por origen
// (Incluido, cada pack, Propios) e «Importar archivo…». En móvil, el
// selector de documentos del sistema, como el import de audio.
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DrumSampleRef, RhythmSampleEntry, UserSampleKind } from "@libretracks/shared/models";

import { importUserSample, isMobileApp, listRhythmSamples } from "../desktopApi";
import { pickFilesViaWebView, stageFileForImport } from "../library/mobileFilePicker";
import { formatRhythmError } from "./rhythmErrors";

const AUDIO_EXTENSIONS = ["wav", "flac", "mp3", "ogg", "m4a", "aac"];

export function sampleKey(sample: DrumSampleRef | null | undefined): string {
  if (!sample) return "";
  const source = sample.source.kind === "pack" ? `pack:${sample.source.packId}` : sample.source.kind;
  return `${source}/${sample.file}`;
}

/** Ruta elegida por el usuario: diálogo nativo o, en móvil, el de documentos. */
async function pickAudioPath(filterName: string): Promise<string | null> {
  if (isMobileApp) {
    const [file] = await pickFilesViaWebView(undefined, false);
    return file ? stageFileForImport(file, true) : null;
  }
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: filterName, extensions: AUDIO_EXTENSIONS }],
  });
  return typeof picked === "string" ? picked : null;
}

type SamplePickerProps = {
  kind: UserSampleKind;
  value: DrumSampleRef | null;
  onPick: (sample: DrumSampleRef, name: string) => void;
  /** Para tests: sustituye al diálogo de ficheros. */
  pickPath?: () => Promise<string | null>;
};

export function SamplePicker({ kind, value, onPick, pickPath }: SamplePickerProps) {
  const { t } = useTranslation();
  const [samples, setSamples] = useState<RhythmSampleEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    listRhythmSamples()
      .then(setSamples)
      .catch(() => setSamples([]));
  useEffect(() => {
    void refresh();
  }, []);

  const groups = new Map<string, RhythmSampleEntry[]>();
  for (const entry of samples) {
    const label =
      entry.sample.source.kind === "builtin"
        ? t("rhythm.picker.builtin")
        : entry.sample.source.kind === "user"
          ? t("rhythm.picker.user")
          : entry.sample.source.packId;
    groups.set(label, [...(groups.get(label) ?? []), entry]);
  }

  const importFile = async () => {
    setError(null);
    const path = await (pickPath ?? (() => pickAudioPath(t("rhythm.picker.audioFilter"))))();
    if (!path) return;
    setBusy(true);
    try {
      const sample = await importUserSample(path, kind);
      await refresh();
      onPick(sample, sample.file.replace(/\.[^.]+$/, ""));
    } catch (e) {
      setError(formatRhythmError(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lt-sample-picker" data-testid="sample-picker">
      <select
        aria-label={t("rhythm.picker.sample")}
        value={sampleKey(value)}
        onChange={(event) => {
          const entry = samples.find((s) => sampleKey(s.sample) === event.target.value);
          if (entry) onPick(entry.sample, entry.name);
        }}
      >
        <option value="">{t("rhythm.picker.none")}</option>
        {[...groups.entries()].map(([label, entries]) => (
          <optgroup key={label} label={label}>
            {entries.map((entry) => (
              <option key={sampleKey(entry.sample)} value={sampleKey(entry.sample)}>
                {entry.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <button type="button" disabled={busy} onClick={() => void importFile()}>
        {t("rhythm.picker.import")}
      </button>
      {error ? (
        <p className="lt-sample-picker__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
