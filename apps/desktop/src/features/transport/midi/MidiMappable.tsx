import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";

import type { MidiBinding } from "@libretracks/shared/models";

import { formatMidiBinding } from "../helpers";
import { useTimelineUIStore } from "../uiStore";

/**
 * MIDI Map mode, Ableton style (plan midi-controllers, paso 05, D1-D2).
 *
 * While MIDI Learn is on (`midiLearnMode !== null`), every control declared
 * mappable is tinted; clicking (or tapping) it arms the learn for its target
 * and the next hardware message binds there. A control becomes mappable with
 * one line: wrap it in `<MidiMappable target="track:<id>:volume">`, or, when
 * a wrapper would break its layout, take `useMidiMappable(target)` and put
 * its `className` and `overlay` on an existing container.
 */

/** The current bindings, mirrored from the settings (narrow selectors). */
export const useMidiMappingsStore = create<{
  mappings: Record<string, MidiBinding>;
}>()(() => ({ mappings: {} }));

export function setMidiMappingsForMappable(mappings: Record<string, MidiBinding>) {
  if (useMidiMappingsStore.getState().mappings !== mappings) {
    useMidiMappingsStore.setState({ mappings });
  }
}

export type MidiMappableParts = {
  /** Add to the control's container (it must be able to hold an overlay). */
  className: string;
  /** Interactive cover: arms the learn on click. */
  overlay: ReactNode;
  /**
   * Visual-only binding chip, for controls that keep their own click
   * handling in map mode (the transport buttons).
   */
  badge: ReactNode;
};

const NONE: MidiMappableParts = { className: "", overlay: null, badge: null };

export function useMidiMappable(target: string, label?: string): MidiMappableParts {
  const { t } = useTranslation();
  const learnMode = useTimelineUIStore((state) => state.midiLearnMode);
  const active = learnMode !== null;
  const binding = useMidiMappingsStore((state) =>
    active ? (state.mappings[target] ?? null) : null,
  );
  if (!active) {
    return NONE;
  }
  const armed = learnMode === target;
  const stateClass = `${binding ? "is-mapped" : ""} ${armed ? "is-armed" : ""}`;
  const chip = binding ? (
    <span className="lt-midi-mappable-badge">{formatMidiBinding(binding)}</span>
  ) : null;
  return {
    className: `lt-midi-mappable ${stateClass}`,
    overlay: (
      <button
        type="button"
        className={`lt-midi-mappable-overlay ${stateClass}`}
        aria-label={t("midiMap.mapTarget", { target: label ?? target })}
        aria-pressed={armed}
        data-midi-target={target}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          useTimelineUIStore.getState().setMidiLearnMode(target);
        }}
      >
        {chip}
      </button>
    ),
    badge: chip,
  };
}

export function MidiMappable({
  target,
  label,
  className,
  children,
}: {
  target: string;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  const parts = useMidiMappable(target, label);
  // Outside map mode there is no wrapper at all, so child selectors and flex
  // layouts around the control stay exactly as they were.
  if (!parts.overlay) {
    return <>{children}</>;
  }
  return (
    <div className={`lt-midi-mappable-wrap ${className ?? ""} ${parts.className}`}>
      {children}
      {parts.overlay}
    </div>
  );
}
