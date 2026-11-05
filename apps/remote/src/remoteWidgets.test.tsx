import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_SETTINGS } from "@libretracks/shared/models";

import { App } from "./App";
import { defaultLayout, writeStoredLayout } from "./remoteLayout";

/**
 * Widgets driven by live data: a fake desktop on the other end of the
 * WebSocket sends settings and a two-song session, and every command the
 * remote sends back is recorded.
 */
const sent: Record<string, unknown>[] = [];
let socket: FakeWebSocket | null = null;

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  binaryType = "";
  private listeners: Record<string, ((event: unknown) => void)[]> = {};
  constructor() {
    socket = this;
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener() {}
  send(data: string) {
    sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {}
  emit(type: string, event: unknown) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
  message(event: string, payload: unknown) {
    this.emit("message", { data: JSON.stringify({ event, payload }) });
  }
}

const region = (id: string, name: string, startSeconds: number) => ({
  id,
  name,
  startSeconds,
  endSeconds: startSeconds + 100,
  transposeSemitones: 0,
  key: null,
  master: { gain: 1 },
});

function connect() {
  act(() => {
    socket!.readyState = 1;
    socket!.emit("open", {});
    socket!.message("settings", { ...DEFAULT_APP_SETTINGS, locale: "en" });
    socket!.message("songView", {
      id: "s",
      title: "Set",
      bpm: 120,
      timeSignature: "4/4",
      durationSeconds: 200,
      tracks: [],
      clips: [],
      sectionMarkers: [],
      tempoMarkers: [],
      timeSignatureMarkers: [],
      regions: [region("r1", "Oceans", 0), region("r2", "Way Maker", 100)],
      projectRevision: 1,
    });
  });
}

/** One tab holding just these widgets, stacked full width. */
function layoutWith(...types: string[]) {
  const layout = defaultLayout("standard");
  let y = 0;
  layout.tabs = [
    {
      id: "t",
      name: "Test",
      widgets: types.map((type, index) => {
        const widget = { id: `w${index}`, type, x: 0, y, w: 24, h: 10 };
        y += 10;
        return widget as (typeof layout.tabs)[number]["widgets"][number];
      }),
    },
  ];
  layout.activeTabId = "t";
  layout.customized = true;
  writeStoredLayout(layout);
}

beforeEach(() => {
  window.localStorage.clear();
  sent.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("jump to song", () => {
  it("chooses the song to jump to in the widget itself", () => {
    layoutWith("jumpToSongButton");
    render(<App />);
    connect();

    fireEvent.change(screen.getByLabelText("Song"), { target: { value: "r2" } });
    fireEvent.click(screen.getByRole("button", { name: /jump to song/i }));

    const jump = sent.find((command) => command.cmd === "scheduleRegionJump");
    expect(jump?.targetRegionId).toBe("r2");
  });
});

describe("folding settings panels", () => {
  it("folds a panel to its header, keeps its switch, and remembers it", () => {
    layoutWith("metronomeSettings", "voiceGuideSettings");
    const { unmount } = render(<App />);
    connect();

    const metronome = screen.getByRole("button", { name: "Metronome" });
    expect(metronome.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(metronome);
    expect(metronome.getAttribute("aria-expanded")).toBe("false");

    const widget = metronome.closest(".layout-widget") as HTMLElement;
    expect(widget.classList.contains("is-collapsed")).toBe(true);
    // The on/off switch stays in the folded header.
    expect(within(widget.querySelector("header") as HTMLElement).getByRole("checkbox")).toBeTruthy();
    // The other panel is untouched.
    const guide = screen.getByRole("button", { name: "Voice guide" });
    expect(guide.getAttribute("aria-expanded")).toBe("true");

    unmount();
    render(<App />);
    connect();
    expect(screen.getByRole("button", { name: "Metronome" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("does not fold while the layout is being edited", () => {
    layoutWith("metronomeSettings");
    render(<App />);
    connect();
    fireEvent.click(screen.getByRole("button", { name: "Metronome" }));
    fireEvent.click(screen.getByRole("button", { name: /edit layout/i }));
    expect(document.querySelector(".layout-widget.is-collapsed")).toBeNull();
  });
});
