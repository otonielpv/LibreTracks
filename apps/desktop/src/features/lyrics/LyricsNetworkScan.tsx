import { useState } from "react";
import { useTranslation } from "react-i18next";

import { isIOSApp } from "@libretracks/shared/desktopApi";

import type { FoundProgram } from "./lyricsApi";

type Props = {
  /** iOS: an empty result may be the Local Network permission (denied, or
   * its prompt still open during the first sweep). Defaults to the app's
   * platform; tests set it. */
  ios?: boolean;
  /** Program being set up (its name in the texts). */
  programName: string;
  /** Holyrics asks for a token; FreeShow for a key. */
  tokenWord: "token" | "key";
  /** Runs the sweep; never throws. */
  scan: () => Promise<FoundProgram[]>;
  onPick: (found: FoundProgram) => void;
};

/**
 * «Buscar en la red»: sweeps this computer and the local network for the
 * lyrics program and lists what answered, so nobody has to read an IP off
 * the projection computer. Picking one fills the address and port.
 */
export function LyricsNetworkScan({ programName, tokenWord, scan, onPick, ios = isIOSApp }: Props) {
  const { t } = useTranslation();
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<FoundProgram[] | null>(null);

  const run = async () => {
    setScanning(true);
    setFound(null);
    const list = await scan();
    setFound(list);
    setScanning(false);
  };

  return (
    <div className="lt-lyrics-scan">
      <div className="lt-lyrics-row">
        <button className="lt-lyrics-btn" type="button" disabled={scanning} onClick={() => void run()}>
          {scanning ? t("lyrics.scan.scanning") : t("lyrics.scan.button")}
        </button>
      </div>
      {found !== null && found.length === 0 ? (
        <p className="lt-lyrics-probe is-error" role="status">
          {t("lyrics.scan.none", { program: programName })}
          {ios ? ` ${t("lyrics.scan.noneIos")}` : null}
        </p>
      ) : null}
      {found !== null && found.length > 0 ? (
        <ul className="lt-lyrics-found" aria-label={t("lyrics.scan.results")}>
          {found.map((entry) => (
            <li key={`${entry.host}:${entry.port}`}>
              <button type="button" className="lt-lyrics-found-item" onClick={() => onPick(entry)}>
                <strong>{entry.label}</strong>
                <span>
                  {entry.thisDevice ? t("lyrics.scan.thisDevice") : entry.host}
                  {` · ${t("lyrics.scan.port", { port: entry.port })}`}
                </span>
                {entry.needsToken ? (
                  <small>{t(tokenWord === "token" ? "lyrics.scan.needsToken" : "lyrics.scan.needsKey")}</small>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
