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
import { getPadsCatalog } from "../desktopApi";
import { AudioRouteCombobox } from "../tracks/AudioRouteCombobox";
import { PadManagerModal } from "./PadManagerModal";

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
  const [managerOpen, setManagerOpen] = useState(false);

  // A pad counts as usable in the picker/grid once it has at least one key. User
  // pads may be partial; the key grid disables the tonalities they lack.
  const usablePads = useMemo(
    () => (catalog ?? []).filter((p) => p.keysPresent > 0),
    [catalog],
  );
  const installedPads = usablePads;
  const hasInstalled = installedPads.length > 0;

  // The pad currently selected in the picker, for the key grid's presence mask.
  const activePad = useMemo(
    () => usablePads.find((p) => p.id === settings.padId) ?? null,
    [usablePads, settings.padId],
  );
  const keyPresent = useCallback(
    (index: number) => activePad?.keysPresentMask?.[index] ?? true,
    [activePad],
  );

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
  // The pads trigger sits far right in the topbar, so clamp the left edge to
  // keep the panel within the viewport instead of clipping off the right side.
  const updateAnchor = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 12;
    const width = panelRef.current?.offsetWidth ?? 300;
    const maxLeft = window.innerWidth - width - margin;
    const left = Math.max(margin, Math.min(rect.left, maxLeft));
    setAnchor({ top: rect.bottom + 6, left });
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
      // The trigger is a split control (main toggle + caret). The caret sits
      // outside anchorRef, so treat OUR OWN split wrapper as "inside" — else
      // clicking the caret to close would close-then-reopen (a flicker). Only
      // ours, though: clicking a sibling popover's trigger must still close this
      // one (otherwise opening metronome/guide leaves pads open).
      const ownSplit = anchorRef.current?.closest(".lt-topbar-split") ?? null;
      const clickedSplit = el?.closest(".lt-topbar-split") ?? null;
      if (clickedSplit && clickedSplit === ownSplit) {
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

  // Opening the manager closes the popover: the modal is a full-screen overlay,
  // and leaving the popover (and its portalled route dropdown) mounted on top
  // would obscure the manager and eat clicks. Downloading, deleting and creating
  // pads all live in the manager now — the popover only picks/plays a pad.
  const openManager = useCallback(() => {
    setManagerOpen(true);
    onClose();
  }, [onClose]);

  const faderPosition = gainToPosition(settings.padVolume, AUX_FADER_SCALE);
  const volumeLabel = formatGainDb(settings.padVolume);

  // The popover panel (only rendered while open + anchored). The manager modal
  // below renders regardless, since opening it closes the popover.
  const body = open && anchor ? (
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
          {loadingCatalog && !catalog && (
            <p className="lt-pads-loading">
              {t("pads.loading", { defaultValue: "Cargando catálogo…" })}
            </p>
          )}
          <button
            type="button"
            className="lt-pads-manage-btn"
            onClick={openManager}
          >
            {t("pads.managePads", { defaultValue: "Gestor de pads…" })}
          </button>
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
              {KEY_LABELS.map((label, index) => {
                const present = keyPresent(index);
                return (
                  <button
                    key={label}
                    type="button"
                    className={
                      settings.padKey === index
                        ? "lt-pads-key is-active"
                        : present
                          ? "lt-pads-key"
                          : "lt-pads-key is-missing"
                    }
                    aria-pressed={settings.padKey === index}
                    // A key is disabled when the selected pad doesn't include it
                    // (chiefly for partial user pads), and while following the
                    // song key (the grid then reflects the tonic read-only).
                    disabled={settings.padFollowSongKey || !present}
                    title={
                      present
                        ? undefined
                        : t("pads.keyMissing", {
                            defaultValue: "Esta tonalidad no está en el pad",
                          })
                    }
                    onClick={() => onPadChange({ padKey: index })}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {settings.padFollowSongKey && !keyPresent(settings.padKey) && (
              <p className="lt-pads-key-missing-hint">
                {t("pads.followMissing", {
                  defaultValue:
                    "El pad no tiene esta tonalidad de la canción, así que enmudece aquí.",
                })}
              </p>
            )}
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

          <button
            type="button"
            className="lt-pads-manage-btn"
            onClick={openManager}
          >
            {t("pads.managePads", { defaultValue: "Gestor de pads…" })}
          </button>
        </div>
      )}
    </div>
  ) : null;

  return createPortal(
    <>
      {body}
      {/* The manager modal renders independently of the popover's open state —
          opening it closes the popover, so it can't live inside `body`. */}
      <PadManagerModal
        open={managerOpen}
        onClose={() => setManagerOpen(false)}
        onCatalogChanged={refreshCatalog}
      />
    </>,
    document.body,
  );
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

export const PadsPopover = memo(PadsPopoverImpl);
