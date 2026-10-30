import {
  cloneElement,
  isValidElement,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
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
 * and the next hardware message binds there.
 *
 * - A button: wrap it in `<MidiMappable target="…">`. Nothing is added
 *   around it: the button itself gets a class, a capture-phase click that
 *   arms the learn instead of running the button, and a tint layer inside.
 *   Its layout and every `.group > button` rule stay as they were.
 * - Something that cannot hold children (a range input): take
 *   `useMidiMappable(target)` and put its `className` and `overlay` on an
 *   existing container.
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
  /** Add to the control (or its container): positions the tint layer. */
  className: string;
  /** Interactive cover for a container: arms the learn on click. */
  overlay: ReactNode;
  /** Visual-only tint and binding chip, for a host that arms by itself. */
  badge: ReactNode;
  /** Arms the learn for this target. */
  arm: () => void;
};

const NONE: MidiMappableParts = {
  className: "",
  overlay: null,
  badge: null,
  arm: () => {},
};

export function useMidiMappable(target: string, label?: string): MidiMappableParts {
  const { t } = useTranslation();
  const learnMode = useTimelineUIStore((state) => state.midiLearnMode);
  const active = learnMode !== null && target !== "";
  const binding = useMidiMappingsStore((state) =>
    active ? (state.mappings[target] ?? null) : null,
  );
  if (!active) {
    return NONE;
  }
  const armed = learnMode === target;
  const stateClass = `${binding ? "is-mapped" : ""} ${armed ? "is-armed" : ""}`;
  const chip = binding ? (
    <span className="lt-midi-mappable-chip">{formatMidiBinding(binding)}</span>
  ) : null;
  const arm = () => useTimelineUIStore.getState().setMidiLearnMode(target);
  return {
    className: `lt-midi-mappable ${stateClass}`,
    // A span, not a button: generic `… button` rules of the host group
    // (sizes, opaque backgrounds) must not restyle the cover.
    overlay: (
      <span
        role="button"
        tabIndex={0}
        className={`lt-midi-mappable-layer is-interactive ${stateClass}`}
        aria-label={t("midiMap.mapTarget", { target: label ?? target })}
        aria-pressed={armed}
        data-midi-target={target}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          arm();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            arm();
          }
        }}
      >
        {chip}
      </span>
    ),
    badge: (
      <span
        className={`lt-midi-mappable-layer ${stateClass}`}
        aria-hidden="true"
        data-midi-target={target}
      >
        {chip}
      </span>
    ),
    arm,
  };
}

type HostProps = {
  className?: string;
  children?: ReactNode;
  onClickCapture?: (event: ReactMouseEvent) => void;
  "aria-label"?: string;
};

export function MidiMappable({
  target,
  label,
  children,
}: {
  target: string;
  label?: string;
  /** One element that can hold children (a button, a label, a div). */
  children: ReactElement<HostProps>;
}) {
  const parts = useMidiMappable(target, label);
  if (!parts.badge || !isValidElement(children)) {
    return children;
  }
  const props = children.props;
  return cloneElement(children, {
    className: `${props.className ?? ""} ${parts.className}`.trim(),
    onClickCapture: (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      parts.arm();
    },
    children: (
      <>
        {props.children}
        {parts.badge}
      </>
    ),
  });
}
