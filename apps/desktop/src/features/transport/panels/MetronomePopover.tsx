import { memo } from "react";
import { useTranslation } from "react-i18next";

import type { AppSettings } from "@libretracks/shared/models";
import {
  METRONOME_SOUND_PRESETS,
  METRONOME_SUBDIVISIONS,
} from "@libretracks/shared/models";
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
  routeOptions: RouteOption[];
  /** Live volume draft, committed on pointer-up/blur (kept in the parent). */
  volumeDraft: number;
  midiLearnMode: string | null;
  onClose: () => void;
  onEnabledChange: (checked: boolean) => void;
  onOutputChange: (value: string) => void;
  onVolumeDraftChange: (value: number) => void;
  onCommitVolume: (value: number) => void;
  onSoundChange: (patch: Partial<AppSettings>) => void;
  onMidiLearnTarget: (command: string) => void;
};

function MetronomePopoverImpl({
  open,
  anchorRef,
  settings,
  routeOptions,
  volumeDraft,
  midiLearnMode,
  onClose,
  onEnabledChange,
  onOutputChange,
  onVolumeDraftChange,
  onCommitVolume,
  onSoundChange,
  onMidiLearnTarget,
}: Props) {
  const { t } = useTranslation();

  return (
    <PopoverShell
      open={open}
      anchorRef={anchorRef}
      ariaLabel={t("transport.shell.metronome", { defaultValue: "Metrónomo" })}
      onClose={onClose}
    >
      <header className="lt-pads-popover-header">
        <span className="material-symbols-outlined" aria-hidden="true">
          music_note
        </span>
        <h3>{t("transport.shell.metronome", { defaultValue: "Metrónomo" })}</h3>
      </header>

      <div className="lt-pads-controls">
        <label className="lt-pads-toggle">
          <input
            type="checkbox"
            checked={settings.metronomeEnabled}
            onPointerDown={(event) => {
              if (midiLearnMode === null) return;
              event.preventDefault();
              event.stopPropagation();
              onMidiLearnTarget("action:toggle_metronome");
            }}
            onChange={(event) => onEnabledChange(event.target.checked)}
          />
          <span>
            {t("transport.settingsModal.metronomeStatusDescription", {
              defaultValue: "Activar metrónomo",
            })}
          </span>
        </label>

        <div className="lt-pads-field">
          <span className="lt-pads-field-label">
            {t("transport.settingsModal.metronomeOutput", {
              defaultValue: "Salida",
            })}
          </span>
          <select
            className="lt-pads-select"
            value={settings.metronomeOutput}
            onChange={(event) => onOutputChange(event.target.value)}
          >
            {routeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="lt-pads-field">
          <span className="lt-pads-field-label">
            {t("transport.settingsModal.metronomeVolume")}
            <span className="lt-pads-volume-value">
              {formatGainDb(volumeDraft)} dB
            </span>
          </span>
          <input
            type="range"
            className="lt-pads-fader"
            min={0}
            max={1}
            step={0.001}
            value={gainToPosition(volumeDraft, AUX_FADER_SCALE)}
            aria-label={t("transport.settingsModal.metronomeVolume")}
            onPointerDown={(event) => {
              if (midiLearnMode === null) return;
              event.preventDefault();
              event.stopPropagation();
              onMidiLearnTarget("param:metronome_volume");
            }}
            onChange={(event) =>
              onVolumeDraftChange(
                positionToGain(Number(event.target.value), AUX_FADER_SCALE),
              )
            }
            onPointerUp={(event) =>
              onCommitVolume(
                positionToGain(
                  Number(event.currentTarget.value),
                  AUX_FADER_SCALE,
                ),
              )
            }
            onBlur={(event) =>
              onCommitVolume(
                positionToGain(
                  Number(event.currentTarget.value),
                  AUX_FADER_SCALE,
                ),
              )
            }
          />
        </div>

        <div className="lt-pads-field">
          <span className="lt-pads-field-label">
            {t("transport.settingsModal.metronomeAccentSound", {
              defaultValue: "Accent sound",
            })}
          </span>
          <select
            className="lt-pads-select"
            value={settings.metronomeAccentPreset}
            onChange={(event) =>
              onSoundChange({
                metronomeAccentPreset: Number(event.target.value),
              })
            }
          >
            {METRONOME_SOUND_PRESETS.map((preset, index) => (
              <option key={preset} value={index}>
                {t(`transport.settingsModal.metronomePreset.${preset}`, {
                  defaultValue: preset,
                })}
              </option>
            ))}
          </select>
        </div>

        <div className="lt-pads-field">
          <span className="lt-pads-field-label">
            {t("transport.settingsModal.metronomeAccentPitch", {
              defaultValue: "Accent pitch",
            })}
            <span className="lt-pads-volume-value">
              {t("transport.settingsModal.metronomePitchValue", {
                defaultValue: "{{value}} st",
                value: settings.metronomeAccentPitch,
              })}
            </span>
          </span>
          <input
            type="range"
            className="lt-pads-fader"
            min={-24}
            max={24}
            step={1}
            value={settings.metronomeAccentPitch}
            onChange={(event) =>
              onSoundChange({
                metronomeAccentPitch: Number(event.target.value),
              })
            }
          />
        </div>

        <div className="lt-pads-field">
          <span className="lt-pads-field-label">
            {t("transport.settingsModal.metronomeBeatSound", {
              defaultValue: "Beat sound",
            })}
          </span>
          <select
            className="lt-pads-select"
            value={settings.metronomeBeatPreset}
            onChange={(event) =>
              onSoundChange({
                metronomeBeatPreset: Number(event.target.value),
              })
            }
          >
            {METRONOME_SOUND_PRESETS.map((preset, index) => (
              <option key={preset} value={index}>
                {t(`transport.settingsModal.metronomePreset.${preset}`, {
                  defaultValue: preset,
                })}
              </option>
            ))}
          </select>
        </div>

        <div className="lt-pads-field">
          <span className="lt-pads-field-label">
            {t("transport.settingsModal.metronomeBeatPitch", {
              defaultValue: "Beat pitch",
            })}
            <span className="lt-pads-volume-value">
              {t("transport.settingsModal.metronomePitchValue", {
                defaultValue: "{{value}} st",
                value: settings.metronomeBeatPitch,
              })}
            </span>
          </span>
          <input
            type="range"
            className="lt-pads-fader"
            min={-24}
            max={24}
            step={1}
            value={settings.metronomeBeatPitch}
            onChange={(event) =>
              onSoundChange({
                metronomeBeatPitch: Number(event.target.value),
              })
            }
          />
        </div>

        <div className="lt-pads-field">
          <span className="lt-pads-field-label">
            {t("transport.settingsModal.metronomeSubdivision", {
              defaultValue: "Subdivision",
            })}
          </span>
          <select
            className="lt-pads-select"
            value={settings.metronomeSubdivision}
            onChange={(event) =>
              onSoundChange({
                metronomeSubdivision: Number(event.target.value),
              })
            }
          >
            {METRONOME_SUBDIVISIONS.map((value) => (
              <option key={value} value={value}>
                {t(
                  `transport.settingsModal.metronomeSubdivisionOption.${value}`,
                  {
                    defaultValue: value === 1 ? "Off" : `1/${value}`,
                  },
                )}
              </option>
            ))}
          </select>
        </div>

        {settings.metronomeSubdivision > 1 ? (
          <>
            <div className="lt-pads-field">
              <span className="lt-pads-field-label">
                {t("transport.settingsModal.metronomeSubdivisionSound", {
                  defaultValue: "Subdivision sound",
                })}
              </span>
              <select
                className="lt-pads-select"
                value={settings.metronomeSubdivisionPreset}
                onChange={(event) =>
                  onSoundChange({
                    metronomeSubdivisionPreset: Number(event.target.value),
                  })
                }
              >
                {METRONOME_SOUND_PRESETS.map((preset, index) => (
                  <option key={preset} value={index}>
                    {t(`transport.settingsModal.metronomePreset.${preset}`, {
                      defaultValue: preset,
                    })}
                  </option>
                ))}
              </select>
            </div>

            <div className="lt-pads-field">
              <span className="lt-pads-field-label">
                {t("transport.settingsModal.metronomeSubdivisionPitch", {
                  defaultValue: "Subdivision pitch",
                })}
                <span className="lt-pads-volume-value">
                  {t("transport.settingsModal.metronomePitchValue", {
                    defaultValue: "{{value}} st",
                    value: settings.metronomeSubdivisionPitch,
                  })}
                </span>
              </span>
              <input
                type="range"
                className="lt-pads-fader"
                min={-24}
                max={24}
                step={1}
                value={settings.metronomeSubdivisionPitch}
                onChange={(event) =>
                  onSoundChange({
                    metronomeSubdivisionPitch: Number(event.target.value),
                  })
                }
              />
            </div>

            <div className="lt-pads-field">
              <span className="lt-pads-field-label">
                {t("transport.settingsModal.metronomeSubdivisionGain", {
                  defaultValue: "Subdivision volume",
                })}
                <span className="lt-pads-volume-value">
                  {formatGainDb(settings.metronomeSubdivisionGain)} dB
                </span>
              </span>
              <input
                type="range"
                className="lt-pads-fader"
                min={0}
                max={1}
                step={0.001}
                value={gainToPosition(
                  settings.metronomeSubdivisionGain,
                  AUX_FADER_SCALE,
                )}
                onChange={(event) =>
                  onSoundChange({
                    metronomeSubdivisionGain: positionToGain(
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

export const MetronomePopover = memo(MetronomePopoverImpl);
