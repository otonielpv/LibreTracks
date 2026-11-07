import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  cutPilotToneForTest,
  getRedundancySettings,
  regenerateBackupPin,
  revokeTrustedBackup,
  saveRedundancySettings,
  setPilotToneArmed,
  setRedundancyRole,
  type RedundancyRole,
  type RedundancySettings,
  type RedundancySettingsPatch,
} from "./redundancyApi";
import { useRedundancyStore } from "./redundancyStore";

/** Raw MIDI bytes as the user types them: "C0 05" or "B0 14 7F". */
export function parseMidiBytes(text: string): number[] | null {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return [];
  if (parts.length !== 2 && parts.length !== 3) return null;
  const bytes = parts.map((part) => Number.parseInt(part, 16));
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : null;
}

export function formatMidiBytes(bytes: number[]): string {
  return bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

function Toggle({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="lt-settings-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="lt-settings-toggle-copy">
        <strong>{label}</strong>
        {help ? <small>{help}</small> : null}
      </span>
    </label>
  );
}

function NumberField({
  label,
  help,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  help?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (value: number) => void;
}) {
  return (
    <label className="lt-settings-field">
      <span>{label}</span>
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        defaultValue={value}
        key={value}
        onBlur={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next) && next !== value) onCommit(next);
        }}
      />
      {help ? <small>{help}</small> : null}
    </label>
  );
}

/**
 * Settings → Redundancy. Everything is saved to `redundancy.json` through its
 * own commands (never AppSettings). No paid tiers, no locks (D3); no
 * automatic «take command» option (D1).
 */
export function RedundancySettingsTab() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<RedundancySettings | null>(null);
  const [address, setAddress] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [midiText, setMidiText] = useState("");
  const status = useRedundancyStore((state) => state.status);

  useEffect(() => {
    let cancelled = false;
    void getRedundancySettings()
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        setAddress(loaded.mainAddress);
        setMidiText(formatMidiBytes(loaded.onMainLostMidi));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!settings) {
    return (
      <section className="lt-settings-tab-panel" role="tabpanel" id="lt-settings-panel-redundancy" aria-labelledby="lt-settings-tab-redundancy" />
    );
  }

  const save = (patch: RedundancySettingsPatch) => {
    setError(null);
    void saveRedundancySettings(patch)
      .then(setSettings)
      .catch((reason) => setError(String(reason)));
  };
  const changeRole = (role: RedundancyRole) => {
    setError(null);
    const isBackup = role === "backup";
    void setRedundancyRole(role, isBackup ? address : undefined, isBackup && pin ? pin : undefined)
      .then((applied) => setSettings({ ...settings, role: applied }))
      .catch((reason) => setError(t(`redundancy.errors.${String(reason)}`, { defaultValue: String(reason) })));
  };
  const role = settings.role;

  return (
    <section
      className="lt-settings-tab-panel lt-redundancy-settings"
      role="tabpanel"
      id="lt-settings-panel-redundancy"
      aria-labelledby="lt-settings-tab-redundancy"
    >
      <p className="lt-redundancy-intro">{t("redundancy.settings.intro")}</p>

      <div className="lt-settings-field" role="radiogroup" aria-label={t("redundancy.settings.role")}>
        <span>{t("redundancy.settings.role")}</span>
        <div className="lt-redundancy-roles">
          {(["off", "main", "backup"] as const).map((option) => (
            <label key={option}>
              <input
                type="radio"
                name="lt-redundancy-role"
                value={option}
                checked={role === option}
                onChange={() => changeRole(option)}
              />
              {t(`redundancy.roles.${option}`)}
            </label>
          ))}
        </div>
      </div>
      {error ? (
        <p className="lt-redundancy-warning" role="alert">
          {error}
        </p>
      ) : null}

      <h3>{t("redundancy.settings.mainSection")}</h3>
      <div className="lt-settings-field">
        <span>{t("redundancy.settings.backupPin")}</span>
        <div className="lt-redundancy-row">
          <input
            aria-label={t("redundancy.settings.backupPin")}
            inputMode="numeric"
            defaultValue={settings.backupPin}
            key={settings.backupPin}
            onBlur={(event) => event.target.value !== settings.backupPin && save({ backupPin: event.target.value })}
          />
          <button type="button" onClick={() => void regenerateBackupPin().then(setSettings)}>
            {t("redundancy.settings.regeneratePin")}
          </button>
        </div>
        <small>{t("redundancy.settings.backupPinHelp")}</small>
      </div>
      {settings.backupTrusted.length > 0 ? (
        <div className="lt-settings-field">
          <span>{t("redundancy.settings.trusted")}</span>
          <ul className="lt-redundancy-trusted">
            {settings.backupTrusted.map((device) => (
              <li key={device.deviceId}>
                {device.deviceName}
                <button type="button" onClick={() => void revokeTrustedBackup(device.deviceId).then(setSettings)}>
                  {t("redundancy.settings.revoke")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Toggle
        label={t("redundancy.settings.backupMayForward")}
        help={t("redundancy.settings.backupMayForwardHelp")}
        checked={settings.backupMayForward}
        onChange={(value) => save({ backupMayForward: value })}
      />

      <h3>{t("redundancy.settings.pilotSection")}</h3>
      <p className="lt-redundancy-help">{t("redundancy.settings.pilotHelp")}</p>
      <Toggle
        label={t("redundancy.settings.pilotEnabled")}
        checked={settings.pilotToneEnabled}
        onChange={(value) => {
          save({ pilotToneEnabled: value });
          if (role === "main") void setPilotToneArmed(value);
        }}
      />
      <NumberField
        label={t("redundancy.settings.pilotChannel")}
        help={t("redundancy.settings.pilotChannelHelp")}
        value={settings.pilotToneChannel}
        min={0}
        max={64}
        step={1}
        onCommit={(value) => save({ pilotToneChannel: Math.round(value) })}
      />
      <NumberField
        label={t("redundancy.settings.pilotFrequency")}
        value={settings.pilotToneFrequencyHz}
        min={20}
        max={20000}
        step={1}
        onCommit={(value) => save({ pilotToneFrequencyHz: value })}
      />
      <NumberField
        label={t("redundancy.settings.pilotLevel")}
        value={settings.pilotToneLevelDb}
        min={-60}
        max={0}
        step={1}
        onCommit={(value) => save({ pilotToneLevelDb: value })}
      />
      <div className="lt-redundancy-row">
        <button type="button" disabled={!status?.pilotToneOn} onClick={() => void cutPilotToneForTest()}>
          {t("redundancy.settings.cutPilot")}
        </button>
      </div>
      <Toggle
        label={t("redundancy.settings.pilotOnBackup")}
        help={t("redundancy.settings.pilotOnBackupHelp")}
        checked={settings.pilotToneOnBackup}
        onChange={(value) => save({ pilotToneOnBackup: value })}
      />

      <h3>{t("redundancy.settings.backupSection")}</h3>
      <label className="lt-settings-field">
        <span>{t("redundancy.settings.mainAddress")}</span>
        <input
          aria-label={t("redundancy.settings.mainAddress")}
          placeholder="192.168.1.20"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <small>{t("redundancy.settings.mainAddressHelp")}</small>
      </label>
      <label className="lt-settings-field">
        <span>{t("redundancy.settings.mainPin")}</span>
        <input
          aria-label={t("redundancy.settings.mainPin")}
          inputMode="numeric"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
        />
      </label>
      <div className="lt-redundancy-row">
        <button type="button" disabled={!address.trim()} onClick={() => changeRole("backup")}>
          {t("redundancy.settings.connect")}
        </button>
      </div>
      <NumberField
        label={t("redundancy.settings.threshold")}
        help={t("redundancy.settings.thresholdHelp")}
        value={settings.correctionThresholdMs}
        min={2}
        max={20}
        step={0.5}
        onCommit={(value) => save({ correctionThresholdMs: value })}
      />
      <NumberField
        label={t("redundancy.settings.timeout")}
        help={t("redundancy.settings.timeoutHelp")}
        value={settings.heartbeatTimeoutMs / 1000}
        min={0.5}
        max={5}
        step={0.1}
        onCommit={(value) => save({ heartbeatTimeoutMs: Math.round(value * 1000) })}
      />
      <NumberField
        label={t("redundancy.settings.manualOffset")}
        help={t("redundancy.settings.manualOffsetHelp")}
        value={settings.manualOffsetMs}
        min={-100}
        max={100}
        step={0.1}
        onCommit={(value) => save({ manualOffsetMs: value })}
      />
      <Toggle
        label={t("redundancy.settings.forward")}
        help={t("redundancy.settings.forwardHelp")}
        checked={settings.forwardLocalInputsToMain}
        onChange={(value) => save({ forwardLocalInputsToMain: value })}
      />
      <label className="lt-settings-field">
        <span>{t("redundancy.settings.midiOnLost")}</span>
        <input
          aria-label={t("redundancy.settings.midiOnLost")}
          placeholder="C0 05"
          value={midiText}
          onChange={(event) => setMidiText(event.target.value)}
          onBlur={() => {
            const bytes = parseMidiBytes(midiText);
            if (bytes) save({ onMainLostMidi: bytes });
            else setError(t("redundancy.errors.invalidMidi"));
          }}
        />
        <small>{t("redundancy.settings.midiOnLostHelp")}</small>
      </label>
    </section>
  );
}
