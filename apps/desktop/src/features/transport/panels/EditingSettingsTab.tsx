import { useTranslation } from "react-i18next";
import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";
import type { AppSettings } from "@libretracks/shared/models";
import { AUTO_SAVE_INTERVAL_PRESETS, isSongTrackLayout } from "@libretracks/shared/models";
import { isMobileApp } from "@libretracks/shared/desktopApi";
import { DefaultSongTemplateField } from "../templates/DefaultSongTemplateField";
import { TemplateLibraryField } from "../templates/TemplateLibraryField";
import { SettingsTabSection } from "./SettingsTabSection";

type Props = {
  appSettings: AppSettings;
  disabled: boolean;
  onSongTrackLayoutChange: (value: AppSettings["songTrackLayout"]) => void;
  onDefaultSongTemplateChange: (value: string | null) => void;
  onReferenceImportedAudioChange: (value: boolean) => void;
  onAutoColorNewTracksChange: (value: boolean) => void;
  onAutoWarpChange: (value: boolean) => void;
  onAutoSaveEnabledChange: (value: boolean) => void;
  onAutoSaveIntervalMinutesChange: (value: number) => void;
};

/**
 * Settings › Editing: how songs are laid out and created (track layout,
 * templates, import), what happens to new tracks and clips, and auto-save.
 * Hidden from network guests: none of it is theirs to change.
 */
export function EditingSettingsTab({
  appSettings,
  disabled,
  onSongTrackLayoutChange,
  onDefaultSongTemplateChange,
  onReferenceImportedAudioChange,
  onAutoColorNewTracksChange,
  onAutoWarpChange,
  onAutoSaveEnabledChange,
  onAutoSaveIntervalMinutesChange,
}: Props) {
  const { t } = useTranslation();

  return (
    <SettingsTabSection id="editing">
      <label className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.songTrackLayout")}
        </span>
        <select
          value={appSettings.songTrackLayout}
          disabled={disabled}
          onChange={(event) => {
            if (isSongTrackLayout(event.target.value)) {
              onSongTrackLayoutChange(event.target.value);
            }
          }}
        >
          <option value="shared">
            {t("transport.settingsModal.songTrackLayoutShared")}
          </option>
          {FEATURE_FLAGS.songTemplates ||
          appSettings.songTrackLayout === "songFolder" ? (
            <option value="songFolder">
              {t("transport.settingsModal.songTrackLayoutSongFolder")}
            </option>
          ) : null}
          <option value="separate">
            {t("transport.settingsModal.songTrackLayoutSeparate")}
          </option>
        </select>
        <small>
          {t(
            `transport.settingsModal.songTrackLayoutHint_${appSettings.songTrackLayout}`,
          )}
        </small>
      </label>

      {FEATURE_FLAGS.songTemplates ? (
        <DefaultSongTemplateField
          value={appSettings.defaultSongTemplate}
          disabled={disabled}
          onChange={onDefaultSongTemplateChange}
        />
      ) : null}

      <TemplateLibraryField disabled={disabled} />

      {/* Solo móvil: escritorio referencia desde siempre y
          no tiene nada que elegir aqui. */}
      {isMobileApp ? (
        <label className="lt-settings-toggle">
          <input
            type="checkbox"
            checked={appSettings.referenceImportedAudio}
            disabled={disabled}
            onChange={(event) =>
              onReferenceImportedAudioChange(event.target.checked)
            }
          />
          <span className="lt-settings-toggle-copy">
            <span>
              {t("transport.settingsModal.referenceImportedAudio", {
                defaultValue:
                  "Importar sin copiar el audio a la sesión",
              })}
            </span>
            <small>
              {t("transport.settingsModal.referenceImportedAudioHint", {
                defaultValue:
                  "La sesión apunta a tus archivos originales en vez de duplicarlos, como en escritorio. Ocupa mucho menos. Si mueves o borras un original, la pista deja de sonar y aparece en «Archivos que faltan».",
              })}
            </small>
          </span>
        </label>
      ) : null}

      <label className="lt-settings-toggle">
        <input
          type="checkbox"
          checked={appSettings.autoColorNewTracks}
          disabled={disabled}
          onChange={(event) =>
            onAutoColorNewTracksChange(event.target.checked)
          }
        />
        <span className="lt-settings-toggle-copy">
          <span>
            {t("transport.settingsModal.autoColorNewTracks", {
              defaultValue:
                "Colorear las pistas nuevas automáticamente",
            })}
          </span>
          <small>
            {t("transport.settingsModal.autoColorNewTracksHint", {
              defaultValue:
                "Cada pista nueva toma un color de la paleta, recorriéndola en orden, para distinguirlas de un vistazo. Desactívalo si prefieres colorearlas a mano. No repinta las pistas que ya existen.",
            })}
          </small>
        </span>
      </label>

      <label className="lt-settings-toggle">
        <input
          type="checkbox"
          checked={appSettings.autoWarp}
          disabled={disabled}
          onChange={(event) => onAutoWarpChange(event.target.checked)}
        />
        <span className="lt-settings-toggle-copy">
          <span>{t("transport.settingsModal.autoWarp")}</span>
          <small>{t("transport.settingsModal.autoWarpHint")}</small>
        </span>
      </label>

      <label className="lt-settings-toggle">
        <input
          type="checkbox"
          checked={appSettings.autoSaveEnabled}
          disabled={disabled}
          onChange={(event) =>
            onAutoSaveEnabledChange(event.target.checked)
          }
        />
        <span className="lt-settings-toggle-copy">
          <span>
            {t("transport.settingsModal.autoSave", {
              defaultValue: "Guardar automáticamente",
            })}
          </span>
          <small>
            {t("transport.settingsModal.autoSaveHint", {
              defaultValue:
                "Guarda la sesión abierta cada cierto tiempo para que un fallo inesperado no se lleve tu trabajo. Solo guarda si has cambiado algo, y nunca durante la reproducción.",
            })}
          </small>
        </span>
      </label>

      <label className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.autoSaveInterval", {
            defaultValue: "Guardar cada",
          })}
        </span>
        <select
          value={appSettings.autoSaveIntervalMinutes}
          disabled={
            disabled || !appSettings.autoSaveEnabled
          }
          onChange={(event) =>
            onAutoSaveIntervalMinutesChange(
              Number(event.target.value),
            )
          }
        >
          {/* A settings file may hold a value that is not one of
              the presets (hand-edited, or a preset we dropped);
              surface it so the select still shows the truth. */}
          {!AUTO_SAVE_INTERVAL_PRESETS.includes(
            appSettings.autoSaveIntervalMinutes,
          ) ? (
            <option value={appSettings.autoSaveIntervalMinutes}>
              {t("transport.settingsModal.autoSaveIntervalMinutes", {
                defaultValue: "{{count}} min",
                count: appSettings.autoSaveIntervalMinutes,
              })}
            </option>
          ) : null}
          {AUTO_SAVE_INTERVAL_PRESETS.map((minutes) => (
            <option key={minutes} value={minutes}>
              {t("transport.settingsModal.autoSaveIntervalMinutes", {
                defaultValue: "{{count}} min",
                count: minutes,
              })}
            </option>
          ))}
        </select>
      </label>
    </SettingsTabSection>
  );
}
