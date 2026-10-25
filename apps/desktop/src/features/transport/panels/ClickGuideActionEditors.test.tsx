import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AutomationCueSummary } from "@libretracks/shared/models";
import { describeAutomationCue } from "../timeline/describeAutomationCue";
import {
  MetronomeActionEditor,
  VoiceGuideActionEditor,
  isValidMetronomeAction,
  isValidVoiceGuideAction,
} from "./ClickGuideActionEditors";

const t = (key: string, options?: Record<string, unknown>) =>
  key === "transport.automation.cueMetronome" || key === "transport.automation.cueVoiceGuide"
    ? `${key}(${String(options?.changes)})`
    : key;

const select = (label: string) =>
  screen.getByRole("combobox", { name: label }) as HTMLSelectElement;

describe("click and voice guide cue actions", () => {
  it("needs at least one setting and only known values", () => {
    expect(isValidMetronomeAction({ type: "setMetronome" })).toBe(false);
    expect(isValidMetronomeAction({ type: "setMetronome", enabled: false })).toBe(true);
    expect(isValidMetronomeAction({ type: "setMetronome", accentPreset: 99 })).toBe(false);
    expect(isValidMetronomeAction({ type: "setMetronome", subdivision: 5 })).toBe(false);

    expect(isValidVoiceGuideAction({ type: "setVoiceGuide" })).toBe(false);
    expect(isValidVoiceGuideAction({ type: "setVoiceGuide", language: "en" })).toBe(true);
    expect(isValidVoiceGuideAction({ type: "setVoiceGuide", language: "fr" })).toBe(false);
    expect(isValidVoiceGuideAction({ type: "setVoiceGuide", leadBars: 3 })).toBe(false);
  });

  it("leaves a setting unchanged until the user picks a value", () => {
    const onChange = vi.fn();
    render(
      <MetronomeActionEditor
        action={{ type: "setMetronome", enabled: true }}
        routeOptions={[{ value: "master", label: "Master" }]}
        t={t}
        onChange={onChange}
      />,
    );

    const accent = select("transport.settingsModal.metronomeAccentSound");
    expect(accent.value).toBe("");
    fireEvent.change(accent, { target: { value: "2" } });
    expect(onChange).toHaveBeenLastCalledWith({
      type: "setMetronome",
      enabled: true,
      accentPreset: 2,
    });

    fireEvent.change(select("transport.automation.clickState"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ type: "setMetronome", enabled: null });
  });

  it("offers the monitor output and the count styles for the voice guide", () => {
    const onChange = vi.fn();
    render(
      <VoiceGuideActionEditor
        action={{ type: "setVoiceGuide", enabled: true }}
        routeOptions={[{ value: "master", label: "Master" }]}
        t={t}
        onChange={onChange}
      />,
    );

    const output = select("transport.settingsModal.voiceGuideOutput");
    expect(Array.from(output.options).map((o) => o.value)).toEqual(["", "monitor", "master"]);

    fireEvent.change(select("transport.settingsModal.voiceGuideCountStyle"), {
      target: { value: "halfTime" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      type: "setVoiceGuide",
      enabled: true,
      countStyle: "halfTime",
    });
  });

  it("describes only the settings a cue changes", () => {
    const cue: AutomationCueSummary = {
      id: "c",
      name: "Bridge",
      atSeconds: 10,
      enabled: true,
      actions: [
        { type: "setMetronome", enabled: false, subdivision: 2 },
        { type: "setVoiceGuide", language: "en" },
      ],
    };
    const lines = describeAutomationCue(cue, null, t).split("\n");
    expect(lines[1]).toBe(
      "transport.automation.cueMetronome(transport.automation.cueOff · " +
        "transport.settingsModal.metronomeSubdivision: " +
        "transport.settingsModal.metronomeSubdivisionOption.2)",
    );
    expect(lines[2]).toBe(
      "transport.automation.cueVoiceGuide(transport.settingsModal.voiceGuideLanguage: English)",
    );
  });
});
