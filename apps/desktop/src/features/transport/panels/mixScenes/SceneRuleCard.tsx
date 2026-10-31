import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  MixScenePanChange,
  MixSceneRule,
  MixSceneTrackChange,
  MixSceneTrackSelector,
  MixSceneVolumeChange,
} from "@libretracks/shared/models";

import type { TrackSongGroup } from "../trackSongGroups";
import { parseWords } from "./sceneRules";

type T = (key: string, options?: Record<string, unknown>) => string;

type SceneRuleCardProps = {
  index: number;
  rule: MixSceneRule;
  folders: string[];
  trackGroups: TrackSongGroup[];
  onChange: (rule: MixSceneRule) => void;
  onRemove: () => void;
};

/** One rule, laid out to read as a sentence: who, except whom, and what. */
export function SceneRuleCard({
  index,
  rule,
  folders,
  trackGroups,
  onChange,
  onRemove,
}: SceneRuleCardProps) {
  const { t } = useTranslation();
  const except = rule.except ?? [];
  const setExcept = (next: MixSceneTrackSelector[]) => onChange({ ...rule, except: next });

  return (
    <div className="lt-scene-rule" data-testid={`scene-rule-${index}`}>
      <div className="lt-scene-rule-line">
        <span className="lt-scene-rule-index" aria-hidden="true">
          {index + 1}
        </span>
        <SelectorEditor
          selector={rule.select}
          allowActiveSong
          folders={folders}
          trackGroups={trackGroups}
          label={t("transport.mixScene.selectLabel", { index: index + 1 })}
          t={t}
          onChange={(select) => onChange({ ...rule, select })}
        />
        <button
          type="button"
          className="lt-scene-icon-button"
          aria-label={t("transport.mixScene.removeRule", { index: index + 1 })}
          onClick={onRemove}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            delete
          </span>
        </button>
      </div>

      {except.map((selector, exceptIndex) => (
        <div className="lt-scene-rule-line is-except" key={exceptIndex}>
          <span className="lt-scene-rule-word">{t("transport.mixScene.except")}</span>
          <SelectorEditor
            selector={selector}
            allowActiveSong={false}
            folders={folders}
            trackGroups={trackGroups}
            label={t("transport.mixScene.exceptLabel", { index: exceptIndex + 1 })}
            t={t}
            onChange={(next) =>
              setExcept(except.map((current, i) => (i === exceptIndex ? next : current)))
            }
          />
          <button
            type="button"
            className="lt-scene-icon-button"
            aria-label={t("transport.mixScene.removeExcept")}
            onClick={() => setExcept(except.filter((_, i) => i !== exceptIndex))}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              close
            </span>
          </button>
        </div>
      ))}

      <div className="lt-scene-rule-line is-except">
        <button
          type="button"
          className="lt-secondary-button lt-scene-add-except"
          onClick={() => setExcept([...except, { type: "nameContains", words: [] }])}
        >
          {t("transport.mixScene.addExcept")}
        </button>
      </div>

      <ChangeEditor change={rule.change} t={t} onChange={(change) => onChange({ ...rule, change })} />
    </div>
  );
}

function SelectorEditor({
  selector,
  allowActiveSong,
  folders,
  trackGroups,
  label,
  t,
  onChange,
}: {
  selector: MixSceneTrackSelector;
  allowActiveSong: boolean;
  folders: string[];
  trackGroups: TrackSongGroup[];
  label: string;
  t: T;
  onChange: (selector: MixSceneTrackSelector) => void;
}) {
  const switchKind = (kind: MixSceneTrackSelector["type"]) => {
    switch (kind) {
      case "activeSong":
        return onChange({ type: "activeSong" });
      case "folder":
        return onChange({ type: "folder", name: folders[0] ?? "" });
      case "nameContains":
        return onChange({ type: "nameContains", words: [] });
      case "track":
        return onChange({
          type: "track",
          trackId: trackGroups[0]?.tracks[0]?.id ?? "",
        });
    }
  };

  return (
    <span className="lt-scene-selector">
      <select
        aria-label={label}
        value={selector.type}
        onChange={(event) => switchKind(event.target.value as MixSceneTrackSelector["type"])}
      >
        {allowActiveSong || selector.type === "activeSong" ? (
          <option value="activeSong">{t("transport.mixScene.selectActiveSong")}</option>
        ) : null}
        <option value="folder">{t("transport.mixScene.selectFolder")}</option>
        <option value="nameContains">{t("transport.mixScene.selectNameContains")}</option>
        <option value="track">{t("transport.mixScene.selectTrack")}</option>
      </select>

      {selector.type === "folder" ? (
        <select
          aria-label={t("transport.mixScene.selectFolder")}
          value={selector.name}
          onChange={(event) => onChange({ type: "folder", name: event.target.value })}
        >
          <option value="" disabled>
            {t(folders.length ? "transport.mixScene.chooseFolder" : "transport.mixScene.noFolders")}
          </option>
          {/* A folder the session no longer has stays visible and selected. */}
          {selector.name && !folders.includes(selector.name) ? (
            <option value={selector.name}>{selector.name}</option>
          ) : null}
          {folders.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      ) : null}

      {selector.type === "nameContains" ? (
        <CommitInput
          ariaLabel={t("transport.mixScene.wordsLabel")}
          placeholder={t("transport.mixScene.wordsPlaceholder")}
          value={selector.words.join(", ")}
          onCommit={(text) => onChange({ type: "nameContains", words: parseWords(text) })}
        />
      ) : null}

      {selector.type === "track" ? (
        <select
          aria-label={t("transport.mixScene.selectTrack")}
          value={selector.trackId}
          onChange={(event) => onChange({ type: "track", trackId: event.target.value })}
        >
          <option value="" disabled>
            {t("transport.mixScene.chooseTrack")}
          </option>
          {selector.trackId &&
          !trackGroups.some((group) => group.tracks.some((track) => track.id === selector.trackId)) ? (
            <option value={selector.trackId}>{t("transport.mixScene.missingTrack")}</option>
          ) : null}
          {trackGroups.map((group) => (
            <optgroup
              key={group.region?.id ?? "__no_song__"}
              label={group.region ? group.region.name : t("transport.automation.tracksNoSong")}
            >
              {group.tracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      ) : null}
    </span>
  );
}

function ChangeEditor({
  change,
  t,
  onChange,
}: {
  change: MixSceneTrackChange;
  t: T;
  onChange: (change: MixSceneTrackChange) => void;
}) {
  const volumeMode = change.volume?.type ?? "none";
  const panMode = change.pan?.type ?? "none";
  return (
    <div className="lt-scene-rule-changes">
      <span className="lt-scene-change">
        <span className="lt-scene-change-label">{t("transport.mixScene.volume")}</span>
        <select
          aria-label={t("transport.mixScene.volume")}
          value={volumeMode}
          onChange={(event) => {
            const mode = event.target.value;
            const volume: MixSceneVolumeChange | null =
              mode === "absolute"
                ? { type: "absolute", value: 0.5 }
                : mode === "relativeDb"
                  ? { type: "relativeDb", value: -6 }
                  : null;
            onChange({ ...change, volume });
          }}
        >
          <option value="none">{t("transport.mixScene.noChange")}</option>
          <option value="relativeDb">{t("transport.mixScene.relativeDb")}</option>
          <option value="absolute">{t("transport.mixScene.setPercent")}</option>
        </select>
        {change.volume?.type === "relativeDb" ? (
          <CommitInput
            type="number"
            ariaLabel={t("transport.mixScene.volumeDb")}
            suffix="dB"
            value={String(change.volume.value)}
            onCommit={(text) => {
              const db = Number(text);
              if (Number.isFinite(db)) {
                onChange({ ...change, volume: { type: "relativeDb", value: clamp(db, -60, 24) } });
              }
            }}
          />
        ) : null}
        {change.volume?.type === "absolute" ? (
          <CommitInput
            type="number"
            ariaLabel={t("transport.mixScene.volumePercent")}
            suffix="%"
            value={String(Math.round(change.volume.value * 100))}
            onCommit={(text) => {
              const percent = Number(text);
              if (Number.isFinite(percent)) {
                onChange({
                  ...change,
                  volume: { type: "absolute", value: clamp(percent, 0, 100) / 100 },
                });
              }
            }}
          />
        ) : null}
      </span>

      <span className="lt-scene-change">
        <span className="lt-scene-change-label">{t("transport.mixScene.pan")}</span>
        <select
          aria-label={t("transport.mixScene.pan")}
          value={panMode}
          onChange={(event) => {
            const mode = event.target.value;
            const pan: MixScenePanChange | null =
              mode === "absolute"
                ? { type: "absolute", value: 0 }
                : mode === "relative"
                  ? { type: "relative", value: 0.25 }
                  : null;
            onChange({ ...change, pan });
          }}
        >
          <option value="none">{t("transport.mixScene.noChange")}</option>
          <option value="absolute">{t("transport.mixScene.setPan")}</option>
          <option value="relative">{t("transport.mixScene.relativePan")}</option>
        </select>
        {change.pan ? (
          <CommitInput
            type="number"
            ariaLabel={t("transport.mixScene.panAmount")}
            value={String(Math.round(change.pan.value * 100))}
            onCommit={(text) => {
              const amount = Number(text);
              if (Number.isFinite(amount) && change.pan) {
                const limit = change.pan.type === "absolute" ? 100 : 200;
                onChange({
                  ...change,
                  pan: { type: change.pan.type, value: clamp(amount, -limit, limit) / 100 },
                });
              }
            }}
          />
        ) : null}
      </span>

      <SwitchChange
        label={t("transport.mixScene.mute")}
        value={change.muted}
        t={t}
        onChange={(muted) => onChange({ ...change, muted })}
      />
      <SwitchChange
        label={t("transport.mixScene.solo")}
        value={change.solo}
        t={t}
        onChange={(solo) => onChange({ ...change, solo })}
      />
    </div>
  );
}

function SwitchChange({
  label,
  value,
  t,
  onChange,
}: {
  label: string;
  value: boolean | null | undefined;
  t: T;
  onChange: (value: boolean | null) => void;
}) {
  return (
    <span className="lt-scene-change">
      <span className="lt-scene-change-label">{label}</span>
      <select
        aria-label={label}
        value={value == null ? "none" : value ? "on" : "off"}
        onChange={(event) =>
          onChange(event.target.value === "none" ? null : event.target.value === "on")
        }
      >
        <option value="none">{t("transport.mixScene.noChange")}</option>
        <option value="on">{t("transport.mixScene.switchOn")}</option>
        <option value="off">{t("transport.mixScene.switchOff")}</option>
      </select>
    </span>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * A text field that saves on blur or Enter, not per keystroke: saving
 * "voz," would parse to ["voz"] and eat the comma being typed.
 */
export function CommitInput({
  value,
  onCommit,
  ariaLabel,
  placeholder,
  type = "text",
  suffix,
}: {
  value: string;
  onCommit: (text: string) => void;
  ariaLabel: string;
  placeholder?: string;
  type?: "text" | "number";
  suffix?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <span className={`lt-scene-input ${type === "number" ? "is-number" : ""}`}>
      <input
        type={type}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={draft}
        step={type === "number" ? 1 : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      {suffix ? <span className="lt-scene-input-suffix">{suffix}</span> : null}
    </span>
  );
}
