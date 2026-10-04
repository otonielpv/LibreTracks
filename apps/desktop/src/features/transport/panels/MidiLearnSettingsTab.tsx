import { useTranslation } from "react-i18next";

import { formatMidiBinding } from "../helpers";
import type { MidiLearnCommandRow, MidiLearnFeedback } from "../types";

/**
 * The Settings modal's MIDI Learn tab.
 *
 * Extracted from SettingsPanel (size budget) when it gained a phone layout
 * (plan mobile-midi, paso 05). Desktop keeps the three-column table. On a
 * phone the table does not fit, so each command is a row with its name, the
 * current binding as a chip and a "Learn" button; the flow is the same: tap
 * Learn, move the hardware control, see the confirmation.
 */
export type MidiLearnSettingsTabProps = {
  layout: "table" | "list";
  isLoading: boolean;
  isSaving: boolean;
  hasMappings: boolean;
  midiLearnMode: string | null;
  midiLearnFeedback: MidiLearnFeedback | null;
  midiLearnFeedbackCommand: MidiLearnCommandRow | null;
  midiLearnView: "core" | "markers" | "songs";
  onMidiLearnViewChange: (view: "core" | "markers" | "songs") => void;
  midiLearnMarkerRows: MidiLearnCommandRow[];
  midiLearnSongRows: MidiLearnCommandRow[];
  visibleMidiLearnRows: MidiLearnCommandRow[];
  activeMidiLearnCommand: MidiLearnCommandRow | null;
  onMidiLearnToggle: (options?: { closePanels?: boolean }) => void;
  onResetMidiMappings: () => void;
  onMidiLearnCommandRelearn: (key: string) => void;
  onDynamicMidiLearnJump: (type: "marker" | "song") => void;
};

export function MidiLearnSettingsTab({
  layout,
  isLoading,
  isSaving,
  hasMappings,
  midiLearnMode,
  midiLearnFeedback,
  midiLearnFeedbackCommand,
  midiLearnView,
  onMidiLearnViewChange,
  midiLearnMarkerRows,
  midiLearnSongRows,
  visibleMidiLearnRows,
  activeMidiLearnCommand,
  onMidiLearnToggle,
  onResetMidiMappings,
  onMidiLearnCommandRelearn,
  onDynamicMidiLearnJump,
}: MidiLearnSettingsTabProps) {
  const { t } = useTranslation();
  const busy = isLoading || isSaving;

  const relearnLabel = (command: MidiLearnCommandRow, isTarget: boolean) => {
    if (isTarget) {
      return t("transport.settingsModal.midiLearnListeningShort");
    }
    return command.binding
      ? t("transport.settingsModal.midiLearnRelearn")
      : t("transport.settingsModal.midiLearnLearn");
  };

  const bindingCell = (command: MidiLearnCommandRow) =>
    command.binding ? (
      <span className="lt-midi-binding-pill">
        {formatMidiBinding(command.binding)}
      </span>
    ) : (
      <span className="lt-midi-binding-empty">
        {t("transport.settingsModal.midiLearnUnassigned")}
      </span>
    );

  return (
    <section
      className="lt-settings-tab-panel"
      role="tabpanel"
      id="lt-settings-panel-midiLearn"
      aria-labelledby="lt-settings-tab-midiLearn"
    >
      <section
        className={`lt-midi-learn-panel is-${layout}`}
        aria-labelledby="lt-midi-learn-panel-title"
      >
        <div className="lt-midi-learn-panel-header">
          <div>
            <span
              id="lt-midi-learn-panel-title"
              className="lt-settings-field-label"
            >
              {t("transport.settingsModal.midiLearnSectionTitle")}
            </span>
            <p>{t("transport.settingsModal.midiLearnSectionDescription")}</p>
          </div>
          <div className="lt-midi-learn-actions">
            <button
              type="button"
              className={`lt-midi-learn-activate ${midiLearnMode !== null ? "is-active" : ""}`}
              disabled={busy}
              onClick={() => onMidiLearnToggle({ closePanels: false })}
            >
              <span className="material-symbols-outlined">graphic_eq</span>
              {t("transport.shell.midiLearn")}
            </button>
            <button
              type="button"
              className="lt-midi-learn-reset"
              disabled={busy || !hasMappings}
              onClick={onResetMidiMappings}
            >
              {t("transport.settingsModal.midiLearnReset")}
            </button>
          </div>
        </div>

        <div className="lt-midi-learn-feedback" aria-live="polite">
          <strong>{t("transport.settingsModal.midiLearnLatest")}</strong>
          {midiLearnFeedback ? (
            <p>
              {midiLearnFeedbackCommand?.label ?? midiLearnFeedback.key}:{" "}
              {formatMidiBinding(midiLearnFeedback.binding)}
            </p>
          ) : (
            <p>{t("transport.settingsModal.midiLearnEmpty")}</p>
          )}
        </div>

        {midiLearnMode !== null ? (
          <div className="lt-midi-learn-live">
            <strong>{t("transport.settingsModal.midiLearnListening")}</strong>
            <p>
              {midiLearnMode === ""
                ? t("transport.settingsModal.midiLearnArmed")
                : t("transport.settingsModal.midiLearnTargeting", {
                    key: activeMidiLearnCommand?.label ?? midiLearnMode,
                  })}
            </p>
          </div>
        ) : null}

        <div className="lt-segmented-control lt-midi-learn-view-tabs">
          <button
            type="button"
            className={midiLearnView === "core" ? "is-active" : ""}
            onClick={() => onMidiLearnViewChange("core")}
          >
            {t("transport.settingsModal.midiLearnViewCore")}
          </button>
          <button
            type="button"
            className={midiLearnView === "markers" ? "is-active" : ""}
            onClick={() => onMidiLearnViewChange("markers")}
          >
            {t("transport.settingsModal.midiLearnViewMarkers", {
              count: midiLearnMarkerRows.length,
            })}
          </button>
          <button
            type="button"
            className={midiLearnView === "songs" ? "is-active" : ""}
            onClick={() => onMidiLearnViewChange("songs")}
          >
            {t("transport.settingsModal.midiLearnViewSongs", {
              count: midiLearnSongRows.length,
            })}
          </button>
        </div>

        {layout === "list" ? (
          <ul className="lt-midi-learn-list">
            {visibleMidiLearnRows.map((command) => {
              const isTarget = midiLearnMode === command.key;
              return (
                <li
                  key={command.key}
                  className={isTarget ? "is-midi-target" : undefined}
                >
                  <div className="lt-midi-learn-list-text">
                    <strong>{command.label}</strong>
                    {bindingCell(command)}
                  </div>
                  <button
                    type="button"
                    className={`lt-midi-learn-relearn ${isTarget ? "is-active" : ""}`}
                    aria-label={`${relearnLabel(command, isTarget)}: ${command.label}`}
                    disabled={busy}
                    onClick={() => onMidiLearnCommandRelearn(command.key)}
                  >
                    {relearnLabel(command, isTarget)}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="lt-midi-learn-table-wrap">
            <table className="lt-midi-learn-table">
              <thead>
                <tr>
                  <th scope="col">
                    {t("transport.settingsModal.midiLearnTableCommand")}
                  </th>
                  <th scope="col">
                    {t("transport.settingsModal.midiLearnTableBinding")}
                  </th>
                  <th scope="col">
                    {t("transport.settingsModal.midiLearnTableAction")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleMidiLearnRows.map((command) => {
                  const isTarget = midiLearnMode === command.key;
                  return (
                    <tr
                      key={command.key}
                      className={isTarget ? "is-midi-target" : undefined}
                    >
                      <td>
                        <strong>{command.label}</strong>
                        <code>{command.key}</code>
                      </td>
                      <td>{bindingCell(command)}</td>
                      <td>
                        <button
                          type="button"
                          className={`lt-midi-learn-relearn ${isTarget ? "is-active" : ""}`}
                          disabled={busy}
                          onClick={() => onMidiLearnCommandRelearn(command.key)}
                        >
                          {isTarget
                            ? t("transport.settingsModal.midiLearnListeningShort")
                            : t("transport.settingsModal.midiLearnRelearn")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="lt-midi-learn-dynamic-actions">
          {midiLearnView === "markers" ? (
            <button
              type="button"
              className="lt-midi-learn-map-jump"
              disabled={busy}
              onClick={() => onDynamicMidiLearnJump("marker")}
            >
              {t("transport.settingsModal.midiLearnMapMarkerJump")}
            </button>
          ) : null}
          {midiLearnView === "songs" ? (
            <button
              type="button"
              className="lt-midi-learn-map-jump"
              disabled={busy}
              onClick={() => onDynamicMidiLearnJump("song")}
            >
              {t("transport.settingsModal.midiLearnMapSongJump")}
            </button>
          ) : null}
        </div>
      </section>
    </section>
  );
}
