import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { AppSettings, PadCatalogEntry } from "@libretracks/shared/models";
import {
  AUX_FADER_SCALE,
  formatGainDb,
  gainToPosition,
  positionToGain,
} from "@libretracks/shared/faderScale";
import {
  deletePad,
  downloadPad,
  getPadsCatalog,
  listenToPadDownloadProgress,
  type PadDownloadProgressEvent,
} from "../desktopApi";
import { AudioRouteCombobox } from "../tracks/AudioRouteCombobox";

type RouteOption = { value: string; label: string };

type Props = {
  open: boolean;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  settings: AppSettings;
  routeOptions: RouteOption[];
  onClose: () => void;
  /** Toggle the pad on/off. */
  onToggleEnabled: (next: boolean) => void;
  /** Apply a pad settings patch (key/volume/route/pad id). */
  onPadChange: (patch: Partial<AppSettings>) => void;
};

// The 12 keys, in chromatic order. Display uses the sharp glyph; the stored
// value is the index 0..11 (matches padKey and the engine key_stem mapping).
const KEY_LABELS = [
  "C",
  "C♯",
  "D",
  "D♯",
  "E",
  "F",
  "F♯",
  "G",
  "G♯",
  "A",
  "A♯",
  "B",
];

function PadsPopoverImpl({
  open,
  anchorRef,
  settings,
  routeOptions,
  onClose,
  onToggleEnabled,
  onPadChange,
}: Props) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [catalog, setCatalog] = useState<PadCatalogEntry[] | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [offline, setOffline] = useState(false);
  // Download progress keyed by pad id.
  const [downloads, setDownloads] = useState<
    Record<string, PadDownloadProgressEvent>
  >({});

  const installedPads = useMemo(
    () => (catalog ?? []).filter((p) => p.installed),
    [catalog],
  );
  const availablePads = useMemo(
    () => (catalog ?? []).filter((p) => !p.installed),
    [catalog],
  );
  const hasInstalled = installedPads.length > 0;

  const refreshCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    try {
      const result = await getPadsCatalog();
      setCatalog(result.pads);
      setOffline(result.offline);
    } catch {
      setCatalog([]);
      setOffline(true);
    } finally {
      setLoadingCatalog(false);
    }
  }, []);

  // Anchor the portalled panel under the trigger; reposition on scroll/resize.
  const updateAnchor = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ top: rect.bottom + 6, left: rect.left });
  }, [anchorRef]);

  useEffect(() => {
    if (!open) return;
    updateAnchor();
    void refreshCatalog();
    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      // The routing combobox portals its listbox to <body>, i.e. OUTSIDE our
      // panel. Without this guard, clicking a route option counts as an
      // outside click and closes the popover before the option's click can
      // commit — so the route never changes. Treat clicks inside any portalled
      // route dropdown as inside the popover.
      const el = target instanceof Element ? target : (target as Node).parentElement;
      if (el?.closest(".lt-audio-route-list, .lt-audio-route-combobox")) {
        return;
      }
      if (
        !panelRef.current?.contains(target) &&
        !anchorRef.current?.contains(target)
      ) {
        onClose();
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const reposition = () => updateAnchor();
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, updateAnchor, refreshCatalog, anchorRef, onClose]);

  // Subscribe to download progress while the popover is open. On completion,
  // clear the entry and refresh the catalog so the pad flips to "installed".
  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined;
    let active = true;
    void (async () => {
      unlisten = await listenToPadDownloadProgress((event) => {
        if (!active) return;
        setDownloads((prev) => ({ ...prev, [event.padId]: event }));
        if (event.done) {
          // Give the UI a beat to show 100%, then clear + refresh.
          window.setTimeout(() => {
            setDownloads((prev) => {
              const next = { ...prev };
              delete next[event.padId];
              return next;
            });
            void refreshCatalog();
          }, 400);
        }
      });
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, [open, refreshCatalog]);

  const startDownload = useCallback((padId: string) => {
    setDownloads((prev) => ({
      ...prev,
      [padId]: {
        padId,
        percent: 0,
        message: "",
        done: false,
      },
    }));
    // Errors surface via the terminal progress event (done + error).
    void downloadPad(padId).catch(() => {});
  }, []);

  const handleDelete = useCallback(
    (padId: string) => {
      void deletePad(padId)
        .then(() => refreshCatalog())
        .catch(() => {});
    },
    [refreshCatalog],
  );

  if (!open || !anchor) return null;

  const faderPosition = gainToPosition(settings.padVolume, AUX_FADER_SCALE);
  const volumeLabel = formatGainDb(settings.padVolume);

  const body = (
    <div
      ref={panelRef}
      className="lt-pads-popover"
      role="dialog"
      aria-label={t("pads.title", { defaultValue: "Ambient pads" })}
      style={{ position: "fixed", top: `${anchor.top}px`, left: `${anchor.left}px` }}
      onClick={(event) => event.stopPropagation()}
    >
      <header className="lt-pads-popover-header">
        <span className="material-symbols-outlined" aria-hidden="true">
          graphic_eq
        </span>
        <h3>{t("pads.title", { defaultValue: "Pads de ambiente" })}</h3>
      </header>

      {!hasInstalled ? (
        <div className="lt-pads-empty">
          <p className="lt-pads-empty-text">
            {t("pads.emptyHint", {
              defaultValue:
                "Descarga un pack de pads para empezar. Cada pack trae las 12 tonalidades.",
            })}
          </p>
          {loadingCatalog && !catalog ? (
            <p className="lt-pads-loading">
              {t("pads.loading", { defaultValue: "Cargando catálogo…" })}
            </p>
          ) : offline ? (
            <p className="lt-pads-offline">
              {t("pads.offline", {
                defaultValue:
                  "No se pudo cargar el catálogo. Revisa tu conexión.",
              })}
            </p>
          ) : availablePads.length === 0 ? (
            <p className="lt-pads-offline">
              {t("pads.none", { defaultValue: "No hay pads disponibles." })}
            </p>
          ) : (
            <ul className="lt-pads-download-list">
              {availablePads.map((pad) => (
                <PadDownloadRow
                  key={pad.id}
                  pad={pad}
                  progress={downloads[pad.id]}
                  onDownload={() => startDownload(pad.id)}
                  t={t}
                />
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="lt-pads-controls">
          <label className="lt-pads-toggle">
            <input
              type="checkbox"
              checked={settings.padEnabled}
              onChange={(event) => onToggleEnabled(event.target.checked)}
            />
            <span>{t("pads.enable", { defaultValue: "Activar pad" })}</span>
          </label>

          <div className="lt-pads-field">
            <span className="lt-pads-field-label">
              {t("pads.pack", { defaultValue: "Pack" })}
            </span>
            <select
              className="lt-pads-select"
              value={settings.padId}
              onChange={(event) => onPadChange({ padId: event.target.value })}
            >
              {settings.padId === "" && (
                <option value="">
                  {t("pads.choosePack", { defaultValue: "Elegir pack…" })}
                </option>
              )}
              {installedPads.map((pad) => (
                <option key={pad.id} value={pad.id}>
                  {pad.name}
                </option>
              ))}
            </select>
          </div>

          <label className="lt-pads-toggle lt-pads-follow-toggle">
            <input
              type="checkbox"
              checked={settings.padFollowSongKey}
              onChange={(event) =>
                onPadChange({ padFollowSongKey: event.target.checked })
              }
            />
            <span>
              {t("pads.followSongKey", {
                defaultValue: "Seguir tonalidad de la canción",
              })}
            </span>
          </label>

          <div className="lt-pads-field">
            <span className="lt-pads-field-label">
              {t("pads.key", { defaultValue: "Tonalidad" })}
              {settings.padFollowSongKey && (
                <span className="lt-pads-follow-hint">
                  {t("pads.followingSong", { defaultValue: "sigue la canción" })}
                </span>
              )}
            </span>
            <div className="lt-pads-key-grid" role="group">
              {KEY_LABELS.map((label, index) => (
                <button
                  key={label}
                  type="button"
                  className={
                    settings.padKey === index
                      ? "lt-pads-key is-active"
                      : "lt-pads-key"
                  }
                  aria-pressed={settings.padKey === index}
                  // While following the song key the grid reflects the current
                  // tonic but is read-only; the manual override is disabled.
                  disabled={settings.padFollowSongKey}
                  onClick={() => onPadChange({ padKey: index })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="lt-pads-field">
            <span className="lt-pads-field-label">
              {t("pads.volume", { defaultValue: "Volumen" })}
              <span className="lt-pads-volume-value">{volumeLabel} dB</span>
            </span>
            <input
              type="range"
              className="lt-pads-fader"
              min={0}
              max={1}
              step={0.001}
              value={faderPosition}
              aria-label={t("pads.volume", { defaultValue: "Volumen" })}
              onChange={(event) =>
                onPadChange({
                  padVolume: positionToGain(
                    Number(event.target.value),
                    AUX_FADER_SCALE,
                  ),
                })
              }
            />
          </div>

          <PadFadeField
            kind="in"
            seconds={settings.padFadeInSeconds}
            onChange={(padFadeInSeconds) => onPadChange({ padFadeInSeconds })}
            t={t}
          />

          <PadFadeField
            kind="out"
            seconds={settings.padFadeOutSeconds}
            onChange={(padFadeOutSeconds) => onPadChange({ padFadeOutSeconds })}
            t={t}
          />

          <div className="lt-pads-field">
            <span className="lt-pads-field-label">
              {t("pads.output", { defaultValue: "Salida" })}
            </span>
            <AudioRouteCombobox
              value={settings.padOutput}
              options={routeOptions}
              ariaLabel={t("pads.output", { defaultValue: "Salida" })}
              onChange={(value) => onPadChange({ padOutput: value })}
            />
          </div>

          {(availablePads.length > 0 || installedPads.length > 0) && (
            <details className="lt-pads-manage">
              <summary>
                {t("pads.manage", { defaultValue: "Gestionar packs" })}
              </summary>
              <ul className="lt-pads-download-list">
                {availablePads.map((pad) => (
                  <PadDownloadRow
                    key={pad.id}
                    pad={pad}
                    progress={downloads[pad.id]}
                    onDownload={() => startDownload(pad.id)}
                    t={t}
                  />
                ))}
                {installedPads.map((pad) => (
                  <li key={pad.id} className="lt-pads-installed-row">
                    <span className="lt-pads-installed-name">{pad.name}</span>
                    <button
                      type="button"
                      className="lt-pads-delete"
                      onClick={() => handleDelete(pad.id)}
                    >
                      {t("pads.delete", { defaultValue: "Eliminar" })}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );

  return createPortal(body, document.body);
}

// A soft entrance/exit control: a checkbox that arms the fade plus a slider for
// its duration. `seconds === 0` means "no fade" (the checkbox is off and the
// slider hidden). Enabling defaults to a musical 2 s; the slider spans 0.5–8 s.
const PAD_FADE_DEFAULT_SECONDS = 2;
const PAD_FADE_MIN_SECONDS = 0.5;
const PAD_FADE_MAX_SECONDS = 8;

function PadFadeField({
  kind,
  seconds,
  onChange,
  t,
}: {
  kind: "in" | "out";
  seconds: number;
  onChange: (seconds: number) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const enabled = seconds > 0;
  const label =
    kind === "in"
      ? t("pads.fadeIn", { defaultValue: "Entrada suave" })
      : t("pads.fadeOut", { defaultValue: "Salida suave" });
  const sliderLabel =
    kind === "in"
      ? t("pads.fadeInDuration", { defaultValue: "Duración de entrada" })
      : t("pads.fadeOutDuration", { defaultValue: "Duración de salida" });
  return (
    <div className="lt-pads-field lt-pads-fade-field">
      <label className="lt-pads-toggle lt-pads-fade-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) =>
            onChange(event.target.checked ? PAD_FADE_DEFAULT_SECONDS : 0)
          }
        />
        <span>{label}</span>
        {enabled && (
          <span className="lt-pads-fade-value">{seconds.toFixed(1)} s</span>
        )}
      </label>
      {enabled && (
        <input
          type="range"
          className="lt-pads-fader lt-pads-fade-slider"
          min={PAD_FADE_MIN_SECONDS}
          max={PAD_FADE_MAX_SECONDS}
          step={0.1}
          value={seconds}
          aria-label={sliderLabel}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      )}
    </div>
  );
}

function PadDownloadRow({
  pad,
  progress,
  onDownload,
  t,
}: {
  pad: PadCatalogEntry;
  progress: PadDownloadProgressEvent | undefined;
  onDownload: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const downloading = Boolean(progress) && !progress?.done;
  const failed = Boolean(progress?.done && progress?.error);
  const sizeMb = pad.sizeBytes > 0 ? Math.round(pad.sizeBytes / 1_000_000) : 0;

  return (
    <li className="lt-pads-download-row">
      <div className="lt-pads-download-info">
        <span className="lt-pads-download-name">{pad.name}</span>
        {sizeMb > 0 && (
          <span className="lt-pads-download-size">{sizeMb} MB</span>
        )}
      </div>
      {downloading ? (
        <div
          className="lt-pads-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress?.percent ?? 0)}
        >
          <div className="lt-pads-progress-track">
            <div
              className="lt-pads-progress-fill"
              style={{
                width: `${Math.max(0, Math.min(100, progress?.percent ?? 0))}%`,
              }}
            />
          </div>
          <span className="lt-pads-progress-label">
            {progress?.message || t("pads.downloading", { defaultValue: "Descargando…" })}{" "}
            {Math.round(progress?.percent ?? 0)}%
          </span>
        </div>
      ) : (
        <button
          type="button"
          className="lt-pads-download-btn"
          onClick={onDownload}
        >
          {failed
            ? t("pads.retry", { defaultValue: "Reintentar" })
            : t("pads.download", { defaultValue: "Descargar" })}
        </button>
      )}
      {failed && (
        <span className="lt-pads-download-error">{progress?.error}</span>
      )}
    </li>
  );
}

export const PadsPopover = memo(PadsPopoverImpl);
