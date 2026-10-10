import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";

import {
  getNetworkSessionSettings,
  joinHost,
  kickGuest,
  leaveHost,
  revokeTrustedDevice,
  saveNetworkSessionSettings,
  setGuestRole,
  startHosting,
  stopHosting,
  type NetworkRole,
  type NetworkSessionSettings,
} from "@libretracks/shared/networkApi";

import { useDismissOnBack } from "../transport/mobile/backNavigation";
import { useNetworkSessionStore } from "./networkSessionStore";
import "./network.css";

type Tab = "host" | "join";

const ROLES: NetworkRole[] = ["viewer", "controller", "editor"];

function errorCode(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function NetworkSessionModal() {
  const { t } = useTranslation();
  const isOpen = useNetworkSessionStore((state) => state.isModalOpen);
  const closeModal = useNetworkSessionStore((state) => state.closeModal);
  const host = useNetworkSessionStore((state) => state.host);
  const guest = useNetworkSessionStore((state) => state.guest);
  useDismissOnBack(closeModal, isOpen);

  const [tab, setTab] = useState<Tab>("host");
  const [settings, setSettings] = useState<NetworkSessionSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [pin, setPin] = useState("");
  const [remember, setRemember] = useState(true);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    void getNetworkSessionSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, [isOpen]);

  // Open on the tab that matches what this device is doing.
  useEffect(() => {
    if (isOpen && guest.joined) setTab("join");
  }, [isOpen, guest.joined]);

  const joinUrl = host?.hosting ? host.joinUrl : null;
  useEffect(() => {
    if (!joinUrl) {
      setQr(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(joinUrl, { margin: 1, width: 220 })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => setQr(null));
    return () => {
      cancelled = true;
    };
  }, [joinUrl]);

  if (!isOpen) return null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorCode(caught));
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = (next: NetworkSessionSettings) =>
    run(async () => setSettings(await saveNetworkSessionSettings(next)));

  const hosting = Boolean(host?.hosting);
  const errorText = error
    ? t(`networkSession.errors.${error}`, {
        defaultValue: t("networkSession.errors.generic", { detail: error }),
      })
    : null;

  return (
    <div className="lt-modal-backdrop" onClick={closeModal}>
      <section
        className="lt-settings-modal lt-network-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-network-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">{t("networkSession.eyebrow")}</span>
            <h2 id="lt-network-modal-title">{t("networkSession.title")}</h2>
            <p>{t("networkSession.description")}</p>
          </div>
          <button type="button" className="lt-settings-modal-close" onClick={closeModal}>
            <span className="material-symbols-outlined">close</span>
            {t("common.close")}
          </button>
        </header>

        <div className="lt-settings-modal-body">
          <div className="lt-settings-tablist" role="tablist">
            {(["host", "join"] as Tab[]).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`lt-settings-tab-button ${tab === id ? "is-active" : ""}`}
                onClick={() => setTab(id)}
              >
                {t(`networkSession.tabs.${id}`)}
              </button>
            ))}
          </div>

          {errorText ? (
            <p className="lt-network-error" role="alert">
              {errorText}
            </p>
          ) : null}

          {tab === "host" ? (
            <section className="lt-network-panel" role="tabpanel">
              {settings ? (
                <HostSettingsForm
                  settings={settings}
                  disabled={busy}
                  onSave={(next) => void saveSettings(next)}
                />
              ) : null}

              <div className="lt-network-actions">
                {hosting ? (
                  <button
                    type="button"
                    className="lt-secondary-button"
                    disabled={busy}
                    onClick={() => void run(stopHosting)}
                  >
                    {t("networkSession.host.stop")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="lt-primary-button"
                    disabled={busy || guest.joined}
                    onClick={() => void run(startHosting)}
                  >
                    {t("networkSession.host.start")}
                  </button>
                )}
                {guest.joined && !hosting ? (
                  <span className="lt-settings-field-hint">
                    {t("networkSession.host.leaveFirst")}
                  </span>
                ) : null}
              </div>

              {hosting && host ? (
                <>
                  <div className="lt-network-address">
                    {qr ? (
                      <img className="lt-network-qr" src={qr} alt={t("networkSession.host.qrAlt")} />
                    ) : null}
                    <div>
                      <span className="lt-settings-field-label">
                        {t("networkSession.host.addresses")}
                      </span>
                      {host.addresses.length ? (
                        host.addresses.map((address) => (
                          <strong key={address} className="lt-network-address-value">
                            {address}
                          </strong>
                        ))
                      ) : (
                        <span>{t("networkSession.host.noNetwork")}</span>
                      )}
                      <p className="lt-settings-field-hint">{t("networkSession.host.sameWifi")}</p>
                    </div>
                  </div>

                  <h3 className="lt-network-heading">
                    {t("networkSession.host.guests", { count: host.guests.length })}
                  </h3>
                  {host.guests.length === 0 ? (
                    <p className="lt-settings-field-hint">{t("networkSession.host.noGuests")}</p>
                  ) : (
                    <ul className="lt-network-list">
                      {host.guests.map((entry) => (
                        <li key={entry.deviceId} className="lt-network-row">
                          <span className="lt-network-row-name">
                            {entry.deviceName}
                            <small>
                              {entry.platform}
                              {entry.rttMs !== null
                                ? ` · ${t("networkSession.latency", { ms: Math.round(entry.rttMs / 2) })}`
                                : ""}
                              {entry.trusted ? ` · ${t("networkSession.host.trustedTag")}` : ""}
                            </small>
                          </span>
                          <select
                            aria-label={t("networkSession.host.roleOf", { name: entry.deviceName })}
                            value={entry.grants.role}
                            onChange={(event) =>
                              void run(() =>
                                setGuestRole(entry.deviceId, event.target.value as NetworkRole),
                              )
                            }
                          >
                            {ROLES.map((role) => (
                              <option key={role} value={role}>
                                {t(`networkSession.roles.${role}`)}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="lt-settings-icon-button"
                            aria-label={t("networkSession.host.kick", { name: entry.deviceName })}
                            onClick={() => void run(() => kickGuest(entry.deviceId))}
                          >
                            <span className="material-symbols-outlined">person_remove</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : null}

              {host && host.trusted.length > 0 ? (
                <>
                  <h3 className="lt-network-heading">{t("networkSession.host.trusted")}</h3>
                  <ul className="lt-network-list">
                    {host.trusted.map((device) => (
                      <li key={device.deviceId} className="lt-network-row">
                        <span className="lt-network-row-name">
                          {device.deviceName}
                          <small>{t(`networkSession.roles.${device.role}`)}</small>
                        </span>
                        <button
                          type="button"
                          className="lt-secondary-button"
                          onClick={() => void run(() => revokeTrustedDevice(device.deviceId))}
                        >
                          {t("networkSession.host.revoke")}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
          ) : (
            <section className="lt-network-panel" role="tabpanel">
              {guest.joined ? (
                <div className="lt-network-joined">
                  <p>
                    <strong>{guest.hostName || guest.address}</strong>
                    {" · "}
                    {t(`networkSession.state.${guest.state || "connecting"}`)}
                    {guest.role ? ` · ${t(`networkSession.roles.${guest.role}`)}` : ""}
                  </p>
                  {guest.state === "rejected" && guest.reason ? (
                    <p className="lt-network-error" role="alert">
                      {t(`networkSession.rejected.${guest.reason}`, {
                        version: guest.expectedProtocol ?? "",
                      })}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="lt-secondary-button"
                    onClick={() => void run(leaveHost)}
                  >
                    {t("networkSession.join.leave")}
                  </button>
                </div>
              ) : (
                <form
                  className="lt-settings-section-grid"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(() => joinHost(target, pin.trim() || null, remember));
                  }}
                >
                  <label className="lt-settings-field">
                    <span className="lt-settings-field-label">{t("networkSession.join.address")}</span>
                    <input
                      type="text"
                      inputMode="url"
                      autoComplete="off"
                      placeholder="192.168.1.20"
                      value={target}
                      onChange={(event) => setTarget(event.target.value)}
                    />
                    <span className="lt-settings-field-hint">{t("networkSession.join.addressHint")}</span>
                  </label>
                  <label className="lt-settings-field">
                    <span className="lt-settings-field-label">{t("networkSession.join.pin")}</span>
                    <input
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      value={pin}
                      onChange={(event) => setPin(event.target.value)}
                    />
                    <span className="lt-settings-field-hint">{t("networkSession.join.pinHint")}</span>
                  </label>
                  <label className="lt-settings-toggle">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(event) => setRemember(event.target.checked)}
                    />
                    <span className="lt-settings-toggle-copy">
                      <span>{t("networkSession.join.remember")}</span>
                    </span>
                  </label>
                  <div className="lt-network-actions">
                    <button
                      type="submit"
                      className="lt-primary-button"
                      disabled={busy || hosting || !target.trim()}
                    >
                      {t("networkSession.join.connect")}
                    </button>
                    {hosting ? (
                      <span className="lt-settings-field-hint">
                        {t("networkSession.join.stopHostingFirst")}
                      </span>
                    ) : null}
                  </div>
                </form>
              )}
            </section>
          )}
        </div>
      </section>
    </div>
  );
}

function HostSettingsForm({
  settings,
  disabled,
  onSave,
}: {
  settings: NetworkSessionSettings;
  disabled: boolean;
  onSave: (settings: NetworkSessionSettings) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  return (
    <form
      className="lt-settings-section-grid"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <label className="lt-settings-field">
        <span className="lt-settings-field-label">{t("networkSession.host.deviceName")}</span>
        <input
          type="text"
          value={draft.deviceName}
          onChange={(event) => setDraft({ ...draft, deviceName: event.target.value })}
        />
        <span className="lt-settings-field-hint">{t("networkSession.host.deviceNameHint")}</span>
      </label>
      <label className="lt-settings-field">
        <span className="lt-settings-field-label">{t("networkSession.host.controlPin")}</span>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={draft.controlPin}
          onChange={(event) => setDraft({ ...draft, controlPin: event.target.value })}
        />
        <span className="lt-settings-field-hint">{t("networkSession.host.controlPinHint")}</span>
      </label>
      <label className="lt-settings-field">
        <span className="lt-settings-field-label">{t("networkSession.host.editPin")}</span>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={draft.editPin}
          onChange={(event) => setDraft({ ...draft, editPin: event.target.value })}
        />
        <span className="lt-settings-field-hint">{t("networkSession.host.editPinHint")}</span>
      </label>
      <label className="lt-settings-toggle">
        <input
          type="checkbox"
          checked={draft.keepHostingAfterRestart}
          onChange={(event) =>
            setDraft({ ...draft, keepHostingAfterRestart: event.target.checked })
          }
        />
        <span className="lt-settings-toggle-copy">
          <span>{t("networkSession.host.keepHosting")}</span>
        </span>
      </label>
      {dirty ? (
        <div className="lt-network-actions">
          <button type="submit" className="lt-secondary-button" disabled={disabled}>
            {t("networkSession.host.saveSettings")}
          </button>
        </div>
      ) : null}
    </form>
  );
}
