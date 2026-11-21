import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LyricsConfig, LyricsSoftware } from "@libretracks/shared/models";

import { LeadTimeField } from "../transport/panels/LeadTimeField";
import { DEFAULT_PORTS, LYRICS_PROGRAMS, usesToken, type FoundProgram, type LyricsError } from "./lyricsApi";
import { DEFAULT_LYRICS_CONFIG, withSoftware } from "./lyricsEdits";
import type { LyricsApi, ProbeOutcome } from "./lyricsHandlers";
import { LyricsNetworkScan } from "./LyricsNetworkScan";
import { LyricsSetupTutorial } from "./LyricsSetupTutorial";
import { useLyricsStore } from "./lyricsStore";
import { useLyricsHandlers } from "./useLyricsHandlers";
import "./lyrics.css";

type Program = Exclude<LyricsSoftware, "unknown">;

/** A lyrics error in plain words. */
export function lyricsErrorText(
  error: LyricsError,
  t: (key: string, options?: Record<string, unknown>) => string,
  port?: number | null,
): string {
  switch (error.kind) {
    case "unreachable":
      return t("lyrics.errors.unreachable", { port: port ?? "?" });
    case "timeout":
      return t("lyrics.errors.timeout");
    case "unauthorized":
      return error.missing.length > 0
        ? t("lyrics.errors.missingPermissions")
        : t("lyrics.errors.badToken");
    case "notFound":
      return t("lyrics.errors.notFound");
    default:
      return error.detail === "port" ? t("lyrics.errors.noPort") : t("lyrics.errors.unexpected", { detail: error.detail });
  }
}

/**
 * Settings › Lyrics: switch the sync on, pick the program, follow its setup
 * tutorial (or skip it), set where it is and try the connection.
 */
export function LyricsSettingsTab({ api }: { api?: LyricsApi } = {}) {
  const { t } = useTranslation();
  const handlers = useLyricsHandlers(api);
  const view = useLyricsStore((state) => state.configView);
  const config = view?.config ?? DEFAULT_LYRICS_CONFIG;
  const [portTouched, setPortTouched] = useState(false);
  const [token, setToken] = useState("");
  const [probe, setProbe] = useState<ProbeOutcome | null>(null);
  const [probing, setProbing] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);

  useEffect(() => {
    void handlers.loadConfig().catch(() => {});
  }, [handlers]);

  const save = (next: LyricsConfig, nextToken?: string) => {
    setProbe(null);
    void handlers.saveConfig(next, nextToken).catch(() => {});
  };

  const software = config.software && config.software !== "unknown" ? (config.software as Program) : null;
  const tutorialPending =
    config.enabled && software !== null && (showTutorial || !config.tutorialDone.includes(software));

  const runProbe = async (host = config.host, port = config.port) => {
    if (!software) return;
    setProbing(true);
    const outcome = await handlers.probe(
      software,
      host,
      port,
      token.trim() ? token.trim() : undefined,
    );
    setProbe(outcome);
    setProbing(false);
  };

  /** A program picked from «Buscar en la red»: fill it in and try it. */
  const pickFound = (found: FoundProgram) => {
    if (!software) return;
    if (found.port !== DEFAULT_PORTS[software]) setPortTouched(true);
    save({ ...config, host: found.host, port: found.port });
    void runProbe(found.host, found.port);
  };

  return (
    <div className="lt-settings-section lt-lyrics-settings">
      <label className="lt-settings-toggle">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(event) => save({ ...config, enabled: event.target.checked })}
        />
        <span className="lt-settings-toggle-copy">
          <strong>{t("lyrics.settings.enable")}</strong>
          <small>{t("lyrics.settings.enableHelp")}</small>
        </span>
      </label>

      {config.enabled ? (
        <>
          <div className="lt-settings-field" role="radiogroup" aria-label={t("lyrics.settings.program")}>
            <span>{t("lyrics.settings.program")}</span>
            <div className="lt-lyrics-programs">
              {LYRICS_PROGRAMS.map((program) => (
                <button
                  key={program}
                  type="button"
                  role="radio"
                  aria-checked={software === program}
                  className={`lt-lyrics-btn ${software === program ? "is-selected" : ""}`}
                  onClick={() => {
                    setShowTutorial(false);
                    save(withSoftware(config, program, portTouched));
                  }}
                >
                  {t(`lyrics.programs.${program}`)}
                </button>
              ))}
            </div>
          </div>

          {software && tutorialPending ? (
            <LyricsSetupTutorial
              key={software}
              software={software}
              onDone={() => {
                setShowTutorial(false);
                void handlers.tutorialDone(software).catch(() => {});
              }}
            />
          ) : null}

          {software && !tutorialPending ? (
            <div className="lt-lyrics-howto">
              <p>{t(`lyrics.howTo.${software}`)}</p>
              <button type="button" className="lt-lyrics-link-button" onClick={() => setShowTutorial(true)}>
                {t("lyrics.tutorial.reopen")}
              </button>
            </div>
          ) : null}

          {software ? (
            <>
              <div className="lt-lyrics-fields">
                <label className="lt-settings-field">
                  <span>{t("lyrics.settings.host")}</span>
                  <input className="lt-lyrics-input"
                    aria-label={t("lyrics.settings.host")}
                    defaultValue={config.host}
                    key={`host-${config.host}`}
                    placeholder="127.0.0.1"
                    onBlur={(event) => {
                      const host = event.target.value.trim() || "127.0.0.1";
                      if (host !== config.host) save({ ...config, host });
                    }}
                  />
                  <small>{t("lyrics.settings.hostHelp")}</small>
                </label>
                <label className="lt-settings-field">
                  <span>{t("lyrics.settings.port")}</span>
                  <input className="lt-lyrics-input"
                    aria-label={t("lyrics.settings.port")}
                    inputMode="numeric"
                    defaultValue={config.port ?? ""}
                    key={`port-${config.port ?? ""}`}
                    placeholder={software === "proPresenter" ? "50001" : undefined}
                    onBlur={(event) => {
                      const text = event.target.value.trim();
                      const port = text === "" ? null : Number(text);
                      if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return;
                      if (port !== config.port) {
                        setPortTouched(true);
                        save({ ...config, port });
                      }
                    }}
                  />
                  {software === "proPresenter" ? <small>{t("lyrics.settings.portHelpProPresenter")}</small> : null}
                </label>
              </div>

              <LyricsNetworkScan
                key={software}
                programName={t(`lyrics.programs.${software}`)}
                tokenWord={software === "holyrics" ? "token" : "key"}
                scan={() => handlers.scan(software, config.port)}
                onPick={pickFound}
              />

              {usesToken(software) ? (
                <label className="lt-settings-field">
                  <span>{t(software === "holyrics" ? "lyrics.settings.token" : "lyrics.settings.key")}</span>
                  <input className="lt-lyrics-input"
                    type="password"
                    autoComplete="off"
                    aria-label={t(software === "holyrics" ? "lyrics.settings.token" : "lyrics.settings.key")}
                    value={token}
                    placeholder={view?.hasToken ? t("lyrics.settings.tokenSaved") : ""}
                    onChange={(event) => setToken(event.target.value)}
                    onBlur={() => {
                      if (token.trim()) {
                        save(config, token.trim());
                        setToken("");
                      }
                    }}
                  />
                  <small>
                    {t(software === "holyrics" ? "lyrics.settings.tokenHelp" : "lyrics.settings.keyHelp")}
                  </small>
                </label>
              ) : null}

              <div className="lt-lyrics-row">
                <button className="lt-lyrics-btn" type="button" disabled={probing} onClick={() => void runProbe()}>
                  {probing ? t("lyrics.settings.probing") : t("lyrics.settings.probe")}
                </button>
              </div>
              {probe?.ok ? (
                <p className="lt-lyrics-probe is-ok" role="status">
                  {t("lyrics.settings.probeOk", {
                    version: probe.info.version,
                    count: probe.info.presentations,
                  })}
                </p>
              ) : null}
              {probe && !probe.ok ? (
                <div className="lt-lyrics-probe is-error" role="alert">
                  <p>{lyricsErrorText(probe.error, t, probe.port)}</p>
                  {probe.error.kind === "unauthorized" && probe.error.missing.length > 0 ? (
                    <ul className="lt-lyrics-missing">
                      {probe.error.missing.map((action) => (
                        <li key={action}>
                          <code>{action}</code>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              <LeadTimeField
                value={config.lead}
                onChange={(lead) => save({ ...config, lead: lead ?? { unit: "beats", count: 0 } })}
              />
              <label className="lt-settings-toggle">
                <input
                  type="checkbox"
                  checked={config.clearOnSongEnd}
                  onChange={(event) => save({ ...config, clearOnSongEnd: event.target.checked })}
                />
                <span className="lt-settings-toggle-copy">
                  <strong>{t("lyrics.settings.clearOnSongEnd")}</strong>
                </span>
              </label>
              <label className="lt-settings-toggle">
                <input
                  type="checkbox"
                  checked={config.clearOnStop}
                  onChange={(event) => save({ ...config, clearOnStop: event.target.checked })}
                />
                <span className="lt-settings-toggle-copy">
                  <strong>{t("lyrics.settings.clearOnStop")}</strong>
                  <small>{t("lyrics.settings.clearOnStopHelp")}</small>
                </span>
              </label>
              <div className="lt-lyrics-row">
                <button className="lt-lyrics-btn" type="button" onClick={handlers.openLinker}>
                  {t("lyrics.pill.link")}
                </button>
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
