import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MidiBinding } from "@libretracks/shared/models";

import { getMidiInputs, getMidiOutputs, isTauriApp } from "../desktopApi";
import {
  applyControllerProfile,
  BUILTIN_CONTROLLER_PROFILES,
  detectControllerProfile,
  parseControllerProfile,
  profileFromMappings,
  type ControllerProfile,
} from "./controllerProfiles";

/**
 * Controller profiles in the MIDI Learn tab (plan midi-controllers, paso 07):
 * pick a built-in profile, or the one detected from the connected port's
 * name, and apply it in one go; import a JSON profile, or export the current
 * device-level bindings as one (to the clipboard, which also works on a
 * phone, and as a file where the platform allows a download).
 */
export function ControllerProfilesPanel({
  midiMappings,
  selectedInput,
  disabled,
  onApply,
}: {
  midiMappings: Record<string, MidiBinding>;
  selectedInput: string | null;
  disabled: boolean;
  /** Replace the mappings; `controllerOutput` set when a matching port exists. */
  onApply: (mappings: Record<string, MidiBinding>, controllerOutput: string | null) => void;
}) {
  const { t } = useTranslation();
  const [profileId, setProfileId] = useState(BUILTIN_CONTROLLER_PROFILES[0]?.id ?? "");
  const [ports, setPorts] = useState<{ inputs: string[]; outputs: string[] }>({
    inputs: [],
    outputs: [],
  });
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isTauriApp) return;
    let active = true;
    void Promise.all([getMidiInputs(), getMidiOutputs()])
      .then(([inputs, outputs]) => {
        if (active) setPorts({ inputs, outputs });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [selectedInput]);

  const detected = detectControllerProfile(
    selectedInput ? [selectedInput, ...ports.inputs] : ports.inputs,
  );

  const apply = (profile: ControllerProfile) => {
    const output =
      detectControllerProfile(ports.outputs, [profile])?.port ?? null;
    onApply(applyControllerProfile(midiMappings, profile), output);
    setMessage(t("midiMap.profileApplied", { name: profile.name }));
  };

  const exportProfile = async () => {
    const profile = profileFromMappings(
      midiMappings,
      selectedInput || t("midiMap.profileCustomName"),
      selectedInput,
    );
    const text = JSON.stringify(profile, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setMessage(t("midiMap.profileCopied"));
    } catch {
      setMessage(null);
    }
    if (!isTauriApp || typeof URL.createObjectURL !== "function") return;
    try {
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${profile.id}.ltmidi.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      // The clipboard copy above is the fallback.
    }
  };

  const importFile = (file: File) => {
    void file.text().then((text) => {
      try {
        apply(parseControllerProfile(text));
      } catch (error) {
        setMessage(t("midiMap.profileInvalid", { reason: String((error as Error).message) }));
      }
    });
  };

  const selected = BUILTIN_CONTROLLER_PROFILES.find((profile) => profile.id === profileId);

  return (
    <div className="lt-midi-profiles">
      <span className="lt-settings-field-label">{t("midiMap.profiles")}</span>
      {detected ? (
        <div className="lt-midi-profiles-detected" role="status">
          <span>{t("midiMap.profileDetected", { name: detected.profile.name })}</span>
          <button type="button" className="lt-ghost-button" disabled={disabled} onClick={() => apply(detected.profile)}>
            {t("midiMap.profileApply")}
          </button>
        </div>
      ) : null}
      <div className="lt-midi-profiles-row">
        <select
          aria-label={t("midiMap.profiles")}
          value={profileId}
          disabled={disabled}
          onChange={(event) => setProfileId(event.target.value)}
        >
          {BUILTIN_CONTROLLER_PROFILES.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="lt-ghost-button"
          disabled={disabled || !selected}
          onClick={() => selected && apply(selected)}
        >
          {t("midiMap.profileApply")}
        </button>
        <button type="button" className="lt-ghost-button" disabled={disabled} onClick={() => fileRef.current?.click()}>
          {t("midiMap.profileImport")}
        </button>
        <button type="button" className="lt-ghost-button" disabled={disabled} onClick={() => void exportProfile()}>
          {t("midiMap.profileExport")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          data-testid="lt-midi-profile-file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) importFile(file);
            event.target.value = "";
          }}
        />
      </div>
      {selected?.notes ? (
        <small>
          {/* Built-in profiles are translated; an imported one shows its own notes. */}
          {t(`midiMap.profileNotes.${selected.id}`, { defaultValue: selected.notes })}
        </small>
      ) : null}
      {message ? (
        <p className="lt-midi-profiles-message" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
}
