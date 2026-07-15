import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { AppSettings } from "@libretracks/shared/models";
import {
  AUX_FADER_SCALE,
  formatGainDb,
  gainToPosition,
  positionToGain,
} from "@libretracks/shared/faderScale";
import { PopoverShell } from "./PopoverShell";

type RouteOption = { value: string; label: string };

type Props = {
  open: boolean;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  settings: AppSettings;
  /** Base audio routing options; a "Monitor" entry is prepended internally. */
  routeOptions: RouteOption[];
  onClose: () => void;
  onChange: (patch: Partial<AppSettings>) => void;
};

function VoiceGuidePopoverImpl({
  open,
  anchorRef,
  settings,
  routeOptions,
  onClose,
  onChange,
}: Props) {
  const { t } = useTranslation();

  // Voice guide can route to the local monitor; mirror the ordering the old
  // settings tab used (Monitor first, then the shared routing options).
  const outputOptions = useMemo(
    () => [
      {
        value: "monitor",
        label: t("trackHeader.monitor", { defaultValue: "Monitor" }),
      },
      ...routeOptions.filter((option) => option.value !== "monitor"),
    ],
    [routeOptions, t],
  );

  return (
    <PopoverShell
      open={open}
      anchorRef={anchorRef}
      ariaLabel={t("transport.settingsModal.voiceGuide", {
        defaultValue: "Voice guide",
      })}
      onClose={onClose}
    >
      <header className="lt-pads-popover-header">
        <span className="material-symbols-outlined" aria-hidden="true">
          campaign
        </span>
        <h3>
          {t("transport.settingsModal.voiceGuide", {
            defaultValue: "Voz guía",
          })}
        </h3>
      </header>

      <div className="lt-pads-controls">
        <label className="lt-pads-toggle">
          <input
            type="checkbox"
            checked={settings.voiceGuideEnabled}
            onChange={(event) =>
              onChange({ voiceGuideEnabled: event.target.checked })
            }
          />
          <span>
            {t("transport.settingsModal.voiceGuideDescription", {
              defaultValue: "Anunciar la sección y contar antes de cada marca.",
            })}
          </span>
        </label>

        {settings.voiceGuideEnabled ? (
          <>
            <div className="lt-pads-field">
              <span className="lt-pads-field-label">
                {t("transport.settingsModal.voiceGuideLanguage", {
                  defaultValue: "Language",
                })}
              </span>
              <select
                className="lt-pads-select"
                value={settings.voiceGuideLanguage}
                onChange={(event) =>
                  onChange({ voiceGuideLanguage: event.target.value })
                }
              >
                <option value="es">Español</option>
                <option value="en">English</option>
              </select>
            </div>

            <div className="lt-pads-field">
              <span className="lt-pads-field-label">
                {t("transport.settingsModal.voiceGuideOutput", {
                  defaultValue: "Voice guide output",
                })}
              </span>
              <select
                className="lt-pads-select"
                value={settings.voiceGuideOutput}
                onChange={(event) =>
                  onChange({ voiceGuideOutput: event.target.value })
                }
              >
                {outputOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="lt-pads-field">
              <span className="lt-pads-field-label">
                {t("transport.settingsModal.voiceGuideLeadBars", {
                  defaultValue: "Lead-in bars",
                })}
              </span>
              <select
                className="lt-pads-select"
                value={settings.voiceGuideLeadBars}
                onChange={(event) =>
                  onChange({ voiceGuideLeadBars: Number(event.target.value) })
                }
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </div>

            <label className="lt-pads-toggle">
              <input
                type="checkbox"
                checked={settings.voiceGuideCountInEnabled}
                onChange={(event) =>
                  onChange({ voiceGuideCountInEnabled: event.target.checked })
                }
              />
              <span>
                {t("transport.settingsModal.voiceGuideCountInDescription", {
                  defaultValue:
                    "Contar los tiempos restantes tras el nombre de la sección.",
                })}
              </span>
            </label>

            <div className="lt-pads-field">
              <span className="lt-pads-field-label">
                {t("transport.settingsModal.voiceGuideVolume", {
                  defaultValue: "Voice volume",
                })}
                <span className="lt-pads-volume-value">
                  {formatGainDb(settings.voiceGuideVolume)} dB
                </span>
              </span>
              <input
                type="range"
                className="lt-pads-fader"
                min={0}
                max={1}
                step={0.001}
                value={gainToPosition(settings.voiceGuideVolume, AUX_FADER_SCALE)}
                aria-label={t("transport.settingsModal.voiceGuideVolume", {
                  defaultValue: "Voice volume",
                })}
                onChange={(event) =>
                  onChange({
                    voiceGuideVolume: positionToGain(
                      Number(event.target.value),
                      AUX_FADER_SCALE,
                    ),
                  })
                }
              />
            </div>
          </>
        ) : null}
      </div>
    </PopoverShell>
  );
}

export const VoiceGuidePopover = memo(VoiceGuidePopoverImpl);
