import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsTabNav, type SettingsTabItem } from "./SettingsTabNav";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const TABS: SettingsTabItem[] = [
  { id: "general", label: "Interface", group: "general" },
  { id: "timeline", label: "Timeline", group: "general" },
  { id: "editing", label: "Editing", group: "general" },
  { id: "audio", label: "Audio" },
  { id: "midi", label: "Devices", group: "midi" },
  { id: "midiLearn", label: "MIDI Learn", group: "midi" },
  { id: "diagnostics", label: "Diagnostics" },
];

const groupToggle = (name: RegExp) => screen.getByRole("button", { name });

afterEach(cleanup);

describe("SettingsTabNav", () => {
  it("starts with only the group holding the active tab open", () => {
    render(<SettingsTabNav tabs={TABS} activeTab="audio" onTabChange={vi.fn()} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.id)).toEqual([
      "lt-settings-tab-audio",
      "lt-settings-tab-diagnostics",
    ]);
    expect(groupToggle(/tabGeneral/).getAttribute("aria-expanded")).toBe("false");
  });

  it("opening a group selects its first tab and leaves the other group open", () => {
    const onTabChange = vi.fn();
    const { rerender } = render(
      <SettingsTabNav tabs={TABS} activeTab="midiLearn" onTabChange={onTabChange} />,
    );
    expect(screen.getByRole("tab", { name: "MIDI Learn" })).toBeTruthy();

    fireEvent.click(groupToggle(/tabGeneral/));
    expect(onTabChange).toHaveBeenCalledWith("general");
    rerender(<SettingsTabNav tabs={TABS} activeTab="general" onTabChange={onTabChange} />);
    expect(screen.getByRole("tab", { name: "Timeline" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "MIDI Learn" })).toBeTruthy();
  });

  it("collapsing the open group keeps the selection", () => {
    const onTabChange = vi.fn();
    render(<SettingsTabNav tabs={TABS} activeTab="editing" onTabChange={onTabChange} />);
    fireEvent.click(groupToggle(/tabGeneral/));
    expect(screen.queryByRole("tab", { name: "Editing" })).toBeNull();
    expect(onTabChange).not.toHaveBeenCalled();
    expect(groupToggle(/tabGeneral/).className).toContain("holds-active");
  });

  it("jumping to a tab from outside opens its group", () => {
    const { rerender } = render(
      <SettingsTabNav tabs={TABS} activeTab="audio" onTabChange={vi.fn()} />,
    );
    rerender(<SettingsTabNav tabs={TABS} activeTab="midi" onTabChange={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Devices" }).getAttribute("aria-selected")).toBe("true");
  });

  it("a group left with one visible tab shows that tab, not a fold", () => {
    const tabs = TABS.filter((tab) => tab.id !== "midiLearn");
    render(<SettingsTabNav tabs={tabs} activeTab="audio" onTabChange={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Devices" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /tabMidi/ })).toBeNull();
  });
});
