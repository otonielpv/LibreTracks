import { describe, expect, it, vi } from "vitest";

import {
  createMidiLearnHandlers,
  type MidiLearnHandlerDeps,
} from "./midiLearnHandlers";

function setup(overrides: Partial<MidiLearnHandlerDeps> = {}) {
  let mode: string | null = null;
  const deps: MidiLearnHandlerDeps = {
    getMidiLearnMode: () => mode,
    setMidiLearnMode: vi.fn((next: string | null) => {
      mode = next;
    }),
    setIsSettingsModalOpen: vi.fn(),
    setIsRemoteModalOpen: vi.fn(),
    t: (key) => key,
    prompt: vi.fn(async () =>"3"),
    ...overrides,
  };
  return { handlers: createMidiLearnHandlers(deps), deps };
}

describe("createMidiLearnHandlers", () => {
  it("toggle turns learn mode on (empty string) from off (null)", () => {
    const { handlers, deps } = setup({ getMidiLearnMode: () => null });
    handlers.handleMidiLearnToggle();
    expect(deps.setMidiLearnMode).toHaveBeenCalledWith("");
  });

  it("toggle with closePanels also closes both modals", () => {
    const { handlers, deps } = setup({ getMidiLearnMode: () => "" });
    handlers.handleMidiLearnToggle({ closePanels: true });
    expect(deps.setIsSettingsModalOpen).toHaveBeenCalledWith(false);
    expect(deps.setIsRemoteModalOpen).toHaveBeenCalledWith(false);
    expect(deps.setMidiLearnMode).toHaveBeenCalledWith(null);
  });

  it("target is ignored while learn mode is off unless armed", () => {
    const { handlers, deps } = setup({ getMidiLearnMode: () => null });
    expect(handlers.handleMidiLearnTarget("ctrl:play")).toBe(false);
    expect(deps.setMidiLearnMode).not.toHaveBeenCalled();

    expect(handlers.handleMidiLearnTarget("ctrl:play", { arm: true })).toBe(
      true,
    );
    expect(deps.setMidiLearnMode).toHaveBeenCalledWith("ctrl:play");
  });

  it("dynamic jump arms the marker action for a valid index", async () => {
    const { handlers, deps } = setup({ prompt: vi.fn(async () =>"5") });
    await handlers.handleDynamicMidiLearnJump("marker");
    expect(deps.setMidiLearnMode).toHaveBeenCalledWith("action:jump_marker_5");
  });

  it("dynamic jump rejects out-of-range / non-integer indices", () => {
    const cases = ["0", "101", "abc", "2.5"];
    for (const value of cases) {
      const { handlers, deps } = setup({ prompt: vi.fn(async () =>value) });
      handlers.handleDynamicMidiLearnJump("marker");
      expect(deps.setMidiLearnMode).not.toHaveBeenCalled();
    }
  });

  it("dynamic jump caps songs at 20", () => {
    const { handlers, deps } = setup({ prompt: vi.fn(async () =>"21") });
    handlers.handleDynamicMidiLearnJump("song");
    expect(deps.setMidiLearnMode).not.toHaveBeenCalled();
  });

  it("dynamic jump is cancelled when the prompt is dismissed", () => {
    const { handlers, deps } = setup({ prompt: vi.fn(async () =>null) });
    handlers.handleDynamicMidiLearnJump("song");
    expect(deps.setMidiLearnMode).not.toHaveBeenCalled();
  });
});
