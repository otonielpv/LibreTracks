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
  type NetworkHostStatus,
  type NetworkRole,
  type NetworkSessionSettings,
} from "@libretracks/shared/networkApi";

import { useDismissOnBack } from "../transport/mobile/backNavigation";
import { RemoteFirewallNotice } from "../transport/panels/RemoteFirewallNotice";
import { useNetworkSessionStore } from "./networkSessionStore";
import { useHostDiscovery } from "./useHostDiscovery";
import "./network.css";

type Tab = "host" | "join";

const ROLES: NetworkRole[] = ["viewer", "controller", "editor"];

function errorCode(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Host / join a network session. Wide and two-column: on a tablet in
 * landscape it fills the screen with the setup on the left and what is
 * happening (address, guests, hosts found) on the right, instead of one long
 * column that wastes the width and has to scroll.
 */
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
  const [target, setTarget] = useState("");
  const [pin, setPin] = useState("");
  const [remember, setRemember] = useState(true);
  const discovery = useHostDiscovery(isOpen && tab === "join" && !guest.joined);

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
        <header className="lt-network-modal-header">
          <div className="lt-network-modal-title">
            <span className="lt-settings-modal-eyebrow">{t("networkSession.eyebrow")}</span>
            <h2 id="lt-network-modal-title">{t("networkSession.title")}</h2>
          </div>
          <div className="lt-network-tabs" role="tablist">
            {(["host", "join"] as Tab[]).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`lt-network-tab${tab === id ? " is-active" : ""}`}
                onClick={() => setTab(id)}
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  {id === "host" ? "cell_tower" : "login"}
                </span>
                {t(`networkSession.tabs.${id}`)}
              </button>
            ))}
          </div>
          <button type="button" className="lt-settings-modal-close" onClick={closeModal}>
            <span className="material-symbols-outlined">close</span>
            {t("common.close")}
          </button>
        </header>

        <div className="lt-network-modal-body">
          {errorText ? (
            <p className="lt-network-error" role="alert">
              {errorText}
            </p>
          ) : null}

          {tab === "host" ? (
            <section className="lt-network-columns" role="tabpanel">
              <div className="lt-network-column">
                {/* Before anything else, as in the remote panel: hosting is
                    pointless if Windows drops every connection. Renders
                    nothing when there is nothing to fix or off Windows. */}
                <RemoteFirewallNotice textKeys="networkSession.firewall" />
                {settings ? (
                  <HostSettingsForm
                    settings={settings}
                    disabled={busy}
                    onSave={(next) =>
                      void run(async () => setSettings(await saveNetworkSessionSettings(next)))
                    }
                  />
                ) : null}
                <div className="lt-network-actions">
                  {hosting ? (
                    <button
                      type="button"
                      className="lt-network-button"
                      disabled={busy}
                      onClick={() => void run(stopHosting)}
                    >
                      {t("networkSession.host.stop")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="lt-network-button is-primary"
                      disabled={busy || guest.joined}
                      onClick={() => void run(startHosting)}
                    >
                      {t("networkSession.host.start")}
                    </button>
                  )}
                  {guest.joined && !hosting ? (
                    <span className="lt-settings-field-hint">{t("networkSession.host.leaveFirst")}</span>
                  ) : null}
                </div>
              </div>

              <div className="lt-network-column">
                {host?.suspended ? (
                  <p className="lt-network-card lt-network-note" role="status">
                    {t("networkSession.host.suspended")}
                  </p>
                ) : null}
                {hosting && host ? (
                  <HostAddressCard host={host} />
                ) : (
                  <p className="lt-network-card lt-network-note">{t("networkSession.host.idle")}</p>
                )}
                {hosting && host ? (
                  <div className="lt-network-card">
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
                              className="lt-network-select"
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
                              className="lt-network-button is-icon is-danger"
                              aria-label={t("networkSession.host.kick", { name: entry.deviceName })}
                              title={t("networkSession.host.kick", { name: entry.deviceName })}
                              onClick={() => void run(() => kickGuest(entry.deviceId))}
                            >
                              <span className="material-symbols-outlined">person_remove</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
                {host && host.trusted.length > 0 ? (
                  <div className="lt-network-card">
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
                            className="lt-network-button"
                            onClick={() => void run(() => revokeTrustedDevice(device.deviceId))}
                          >
                            {t("networkSession.host.revoke")}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </section>
          ) : guest.joined ? (
            <section className="lt-network-columns is-single" role="tabpanel">
              <div className="lt-network-card lt-network-joined">
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
                  className="lt-network-button"
                  onClick={() => void run(leaveHost)}
                >
                  {t("networkSession.join.leave")}
                </button>
              </div>
            </section>
          ) : (
            <section className="lt-network-columns" role="tabpanel">
              <div className="lt-network-column">
                <div className="lt-network-card">
                  <h3 className="lt-network-heading">{t("networkSession.discovery.title")}</h3>
                  {discovery.hosts.length === 0 ? (
                    <p className="lt-settings-field-hint lt-network-searching">
                      {t("networkSession.discovery.searching")}
                    </p>
                  ) : (
                    <ul className="lt-network-list" aria-label={t("networkSession.discovery.title")}>
                      {discovery.hosts.map((found) => (
                        <li key={found.hostId} className="lt-network-row">
                          <span className="lt-network-row-name">
                            {found.name}
                            <small>
                              {found.addresses[0]}
                              {found.requiresPin ? ` · ${t("networkSession.discovery.pinBadge")}` : ""}
                            </small>
                            {!found.compatible ? (
                              <small className="lt-network-warning">
                                {t("networkSession.discovery.needsUpdate")}
                              </small>
                            ) : null}
                          </span>
                          <button
                            type="button"
                            className="lt-network-button is-primary"
                            disabled={busy || hosting || !found.compatible}
                            aria-label={`${t("networkSession.discovery.join")}: ${found.name}`}
                            onClick={() =>
                              void run(() =>
                                joinHost(found.addresses[0], pin.trim() || null, remember, found.hostId),
                              )
                            }
                          >
                            {t("networkSession.discovery.join")}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {discovery.showNotFoundHints ? (
                    <div className="lt-network-hints" role="note">
                      <strong>{t("networkSession.discovery.notFoundTitle")}</strong>
                      <ul>
                        <li>{t("networkSession.discovery.notFoundSameWifi")}</li>
                        <li>{t("networkSession.discovery.notFoundIos")}</li>
                        <li>{t("networkSession.discovery.notFoundFirewall")}</li>
                        <li>{t("networkSession.discovery.notFoundManual")}</li>
                      </ul>
                    </div>
                  ) : null}
                </div>
              </div>

              <form
                className="lt-network-column"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(() => joinHost(target, pin.trim() || null, remember));
                }}
              >
                <div className="lt-network-card">
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
                </div>
                <div className="lt-network-card">
                  <h3 className="lt-network-heading">{t("networkSession.discovery.manual")}</h3>
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
                  <div className="lt-network-actions">
                    <button
                      type="submit"
                      className="lt-network-button is-primary"
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
                </div>
              </form>
            </section>
          )}
        </div>
      </section>
    </div>
  );
}

function HostAddressCard({ host }: { host: NetworkHostStatus }) {
  const { t } = useTranslation();
  const [qr, setQr] = useState<string | null>(null);
  const joinUrl = host.joinUrl;

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

  return (
    <div className="lt-network-card lt-network-address">
      {qr ? <img className="lt-network-qr" src={qr} alt={t("networkSession.host.qrAlt")} /> : null}
      <div>
        <span className="lt-settings-field-label">{t("networkSession.host.addresses")}</span>
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
      className="lt-network-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <label className="lt-settings-field is-wide">
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
      <label className="lt-settings-toggle is-wide">
        <input
          type="checkbox"
          checked={draft.keepHostingAfterRestart}
          onChange={(event) => setDraft({ ...draft, keepHostingAfterRestart: event.target.checked })}
        />
        <span className="lt-settings-toggle-copy">
          <span>{t("networkSession.host.keepHosting")}</span>
        </span>
      </label>
      {dirty ? (
        <div className="lt-network-actions is-wide">
          <button type="submit" className="lt-network-button" disabled={disabled}>
            {t("networkSession.host.saveSettings")}
          </button>
        </div>
      ) : null}
    </form>
  );
}
