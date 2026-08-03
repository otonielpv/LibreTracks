import { useEffect, useRef, useState } from "react";

import type { MidiEventKindSummary, MidiEventSummary } from "../desktopApi";

type Translate = (key: string, options?: Record<string, unknown>) => string;

const EVENT_TYPES: MidiEventKindSummary["type"][] = [
  "note",
  "controlChange",
  "programChange",
  "controlCurve",
];

const EVENT_LABEL_KEYS: Record<MidiEventKindSummary["type"], string> = {
  note: "transport.midi.eventNote",
  controlChange: "transport.midi.eventControlChange",
  programChange: "transport.midi.eventProgramChange",
  controlCurve: "transport.midi.eventControlCurve",
};

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Keep an empty/intermediate number editable without writing 0 to the model. */
function NumericInput({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max?: number;
  step?: number;
  onChange: (next: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(() => String(value));
  const normalize = (next: number) =>
    max === undefined
      ? Math.max(min, next)
      : clamp(next, min, max);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(String(value));
    }
  }, [value]);

  return (
    <input
      ref={inputRef}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(event) => {
        const nextDraft = event.target.value;
        setDraft(nextDraft);
        if (nextDraft.trim() === "") return;
        const parsed = Number(nextDraft);
        if (Number.isFinite(parsed)) onChange(normalize(parsed));
      }}
      onBlur={() => {
        const parsed = Number(draft);
        const next = draft.trim() === "" || !Number.isFinite(parsed)
          ? value
          : normalize(parsed);
        setDraft(String(next));
        onChange(next);
      }}
    />
  );
}

/** 0-127 field. Every MIDI data byte is 7-bit, so they all share this shape. */
function DataField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="lt-settings-field">
      <span className="lt-settings-field-label">{label}</span>
      {hint ? <small className="lt-settings-field-hint">{hint}</small> : null}
      <NumericInput
        min={0}
        max={127}
        value={value}
        onChange={onChange}
      />
    </label>
  );
}

/** Seconds field (offset / duration): non-negative, no upper bound. */
function SecondsField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="lt-settings-field">
      <span className="lt-settings-field-label">{label}</span>
      {hint ? <small className="lt-settings-field-hint">{hint}</small> : null}
      <NumericInput
        min={0}
        step={0.01}
        value={value}
        onChange={onChange}
      />
    </label>
  );
}

/**
 * The editable fields of one MIDI message.
 *
 * Split out of MidiClipModal so the modal stays about the list (collapse,
 * reorder, add) and this stays about one row's inputs.
 */
export function MidiEventFields({
  event,
  index,
  inheritedChannelLabel,
  t,
  onChangeType,
  onChange,
  onChangeKind,
}: {
  event: MidiEventSummary;
  index: number;
  inheritedChannelLabel: string;
  t: Translate;
  onChangeType: (index: number, type: MidiEventKindSummary["type"]) => void;
  onChange: (index: number, event: MidiEventSummary) => void;
  onChangeKind: (index: number, kind: MidiEventKindSummary) => void;
}) {
  const kind = event.kind;

  return (
    <div className="lt-automation-action-fields">
      <label className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.midi.eventType")}
        </span>
        <select
          value={kind.type}
          onChange={(e) =>
            onChangeType(index, e.target.value as MidiEventKindSummary["type"])
          }
        >
          {EVENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(EVENT_LABEL_KEYS[type])}
            </option>
          ))}
        </select>
      </label>

      <SecondsField
        label={t("transport.midi.offsetSeconds")}
        value={event.atSeconds}
        onChange={(next) => onChange(index, { ...event, atSeconds: next })}
      />

      {/* Blank = inherit the track's channel, which is the normal case. */}
      <label className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.midi.channelOverride")}
        </span>
        <small className="lt-settings-field-hint">
          {t("transport.midi.channelOverrideHint")}
        </small>
        <input
          type="number"
          min={1}
          max={16}
          placeholder={inheritedChannelLabel}
          value={event.channel ?? ""}
          onChange={(e) =>
            onChange(index, {
              ...event,
              channel:
                e.target.value.trim() === ""
                  ? null
                  : clamp(Number(e.target.value) || 1, 1, 16),
            })
          }
        />
      </label>

      {kind.type === "note" ? (
        <>
          <DataField
            label={t("transport.midi.note")}
            value={kind.note}
            onChange={(note) => onChangeKind(index, { ...kind, note })}
          />
          <DataField
            label={t("transport.midi.velocity")}
            value={kind.velocity}
            onChange={(velocity) => onChangeKind(index, { ...kind, velocity })}
          />
          <SecondsField
            label={t("transport.midi.durationSeconds")}
            hint={t("transport.midi.durationNoteHint")}
            value={kind.durationSeconds}
            onChange={(durationSeconds) =>
              onChangeKind(index, { ...kind, durationSeconds })
            }
          />
        </>
      ) : null}

      {kind.type === "controlChange" ? (
        <>
          <DataField
            label={t("transport.midi.controller")}
            value={kind.controller}
            onChange={(controller) => onChangeKind(index, { ...kind, controller })}
          />
          <DataField
            label={t("transport.midi.value")}
            value={kind.value}
            onChange={(value) => onChangeKind(index, { ...kind, value })}
          />
        </>
      ) : null}

      {kind.type === "programChange" ? (
        <DataField
          label={t("transport.midi.program")}
          value={kind.program}
          onChange={(program) => onChangeKind(index, { ...kind, program })}
        />
      ) : null}

      {kind.type === "controlCurve" ? (
        <>
          <DataField
            label={t("transport.midi.controller")}
            value={kind.controller}
            onChange={(controller) => onChangeKind(index, { ...kind, controller })}
          />
          <DataField
            label={t("transport.midi.fromValue")}
            value={kind.fromValue}
            onChange={(fromValue) => onChangeKind(index, { ...kind, fromValue })}
          />
          <DataField
            label={t("transport.midi.toValue")}
            value={kind.toValue}
            onChange={(toValue) => onChangeKind(index, { ...kind, toValue })}
          />
          <SecondsField
            label={t("transport.midi.durationSeconds")}
            hint={t("transport.midi.durationCurveHint")}
            value={kind.durationSeconds}
            onChange={(durationSeconds) =>
              onChangeKind(index, { ...kind, durationSeconds })
            }
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * One-line summary shown on a collapsed row, so a folded list still tells the
 * user what each message does.
 */
export function describeEvent(
  event: MidiEventSummary,
  t: Translate,
  inheritedChannel: number,
): string {
  const channel = event.channel ?? inheritedChannel;
  const at = event.atSeconds > 0 ? `+${event.atSeconds}s · ` : "";
  const ch = t("transport.midi.channelShort", { channel });

  switch (event.kind.type) {
    case "note":
      return `${at}${ch} · ${event.kind.note} · v${event.kind.velocity}`;
    case "controlChange":
      return `${at}${ch} · CC${event.kind.controller} = ${event.kind.value}`;
    case "programChange":
      return `${at}${ch} · #${event.kind.program}`;
    case "controlCurve":
      return `${at}${ch} · CC${event.kind.controller} ${event.kind.fromValue}→${event.kind.toValue}`;
  }
}
