import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Editor for a MIDI track's routing.
 *
 * Two separate facts, easy to conflate, so each gets its own hint: the *port*
 * is the cable the messages leave by, and the *channel* is which of the 16
 * addresses inside that cable they are tagged with.
 */
export type MidiRouteDraft = {
  trackId: string;
  trackName: string;
  port: string | null;
  channel: number;
};

type MidiRouteModalProps = {
  draft: MidiRouteDraft | null;
  /** Ports currently offered by the OS. */
  availablePorts: string[];
  /** Re-scan the OS for ports, for when a device is plugged in mid-dialog. */
  onRefreshPorts: () => void;
  onCancel: () => void;
  onConfirm: (result: { port: string | null; channel: number }) => void;
};

const CHANNELS = Array.from({ length: 16 }, (_, index) => index + 1);

export function MidiRouteModal({
  draft,
  availablePorts,
  onRefreshPorts,
  onCancel,
  onConfirm,
}: MidiRouteModalProps) {
  const { t } = useTranslation();
  const [port, setPort] = useState<string>(() => draft?.port ?? "");
  const [channel, setChannel] = useState<number>(() => draft?.channel ?? 1);

  if (!draft) {
    return null;
  }

  // A saved port that the OS no longer offers still has to be selectable, or
  // opening this dialog would silently reset the track's routing.
  const portMissing = Boolean(port) && !availablePorts.includes(port);

  return (
    <div className="lt-modal-backdrop" onClick={onCancel}>
      <section
        className="lt-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-midi-route-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">
              {t("transport.midi.modalEyebrow")}
            </span>
            <h2 id="lt-midi-route-title">{t("transport.midi.routeModalTitle")}</h2>
            <p>{draft.trackName}</p>
          </div>
        </header>

        <div className="lt-settings-modal-body">
          <div className="lt-settings-section-grid">
            <label className="lt-settings-field">
              <span className="lt-settings-field-label">
                {t("transport.midi.routePort")}
              </span>
              <div className="lt-settings-field-control-row">
              <select value={port} onChange={(event) => setPort(event.target.value)}>
                <option value="">
                  {t("transport.midi.outputDeviceDefault")}
                </option>
                {portMissing ? (
                  <option value={port}>
                    {t("transport.settingsModal.midiDeviceUnavailable", {
                      name: port,
                    })}
                  </option>
                ) : null}
                {availablePorts.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="lt-settings-icon-button"
                aria-label={t("transport.settingsModal.midiDeviceRefresh")}
                title={t("transport.settingsModal.midiDeviceRefresh")}
                onClick={onRefreshPorts}
              >
                <span className="material-symbols-outlined">refresh</span>
              </button>
              </div>
              <small>{t("transport.midi.routePortHint")}</small>
            </label>

            <label className="lt-settings-field">
              <span className="lt-settings-field-label">
                {t("transport.midi.routeChannel")}
              </span>
              <select
                value={channel}
                onChange={(event) => setChannel(Number(event.target.value) || 1)}
              >
                {CHANNELS.map((value) => (
                  <option key={value} value={value}>
                    {t("transport.midi.channelShort", { channel: value })}
                  </option>
                ))}
              </select>
              <small>{t("transport.midi.routeChannelHint")}</small>
            </label>
          </div>
        </div>

        <div className="lt-inline-actions lt-automation-modal-actions">
          <button type="button" className="lt-secondary-button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="is-primary"
            onClick={() => onConfirm({ port: port || null, channel })}
          >
            {t("common.save")}
          </button>
        </div>
      </section>
    </div>
  );
}
