import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ redundancy: true }));
vi.mock("@libretracks/shared/featureFlags", () => ({ FEATURE_FLAGS: flags }));

const api = vi.hoisted(() => ({
  getRedundancySettings: vi.fn(async () => ({
    role: "main" as const,
    backupPin: "4321",
    backupTrusted: [],
    backupMayForward: false,
    mainAddress: "",
    forwardLocalInputsToMain: false,
    correctionThresholdMs: 5,
    heartbeatTimeoutMs: 1000,
    manualOffsetMs: 0,
    pilotToneEnabled: false,
    pilotToneChannel: 0,
    pilotToneFrequencyHz: 1000,
    pilotToneLevelDb: -12,
    pilotToneOnBackup: false,
    onMainLostMidi: [],
  })),
  saveRedundancySettings: vi.fn(async (patch: unknown) => patch),
  getRedundancyStatus: vi.fn(async () => {
    throw new Error("not in tests");
  }),
}));
vi.mock("./redundancyApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./redundancyApi")>();
  return { ...actual, ...api };
});

import i18n from "../../shared/i18n";
import {
  MOBILE_HIDDEN_SETTINGS_TABS,
  visibleSettingsTabs,
} from "../transport/settings/visibleSettingsTabs";
import type { RedundancyStatus } from "./redundancyApi";
import { RedundancyBadge } from "./RedundancyBadge";
import { RedundancySettingsTab, formatMidiBytes, parseMidiBytes } from "./RedundancySettingsTab";
import { INITIAL_REDUNDANCY_STATE, useRedundancyStore } from "./redundancyStore";
import { useTransportGuard } from "./useTransportGuard";

function status(partial: Partial<RedundancyStatus>): RedundancyStatus {
  return {
    role: "backup",
    state: "following",
    offsetMs: 3.4,
    corrections: 0,
    otherName: "PC A",
    diffs: [],
    reason: "",
    roleOffer: null,
    uncleanExitWarning: false,
    sampleRateDiffers: false,
    pilotToneOn: false,
    ...partial,
  };
}

beforeEach(() => {
  flags.redundancy = true;
  useRedundancyStore.setState(INITIAL_REDUNDANCY_STATE);
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("es");
});

const TABLE: Array<{
  partial: Partial<RedundancyStatus>;
  es: string;
  en: string;
  icon: string;
  tone: string;
}> = [
  { partial: { role: "main", state: "noBackup" }, es: "Sin respaldo", en: "No backup", icon: "shield", tone: "is-idle" },
  { partial: { role: "main", state: "backupConnected" }, es: "Respaldo: sincronizando", en: "Backup: syncing", icon: "sync", tone: "is-pending" },
  { partial: { role: "main", state: "backupArmed" }, es: "Respaldo armado", en: "Backup armed", icon: "verified", tone: "is-ok" },
  { partial: { role: "main", state: "backupMismatch" }, es: "Respaldo: sesión distinta", en: "Backup: different session", icon: "difference", tone: "is-error" },
  { partial: { role: "main", state: "backupLost" }, es: "Respaldo perdido", en: "Backup lost", icon: "link_off", tone: "is-lost" },
  { partial: { state: "pairing" }, es: "Respaldo: conectando", en: "Backup: connecting", icon: "shield", tone: "is-idle" },
  { partial: { state: "following", offsetMs: 3.4 }, es: "Siguiendo: 3,4 ms", en: "Following: 3.4 ms", icon: "sync", tone: "is-pending" },
  { partial: { state: "armed", offsetMs: -0.8 }, es: "Armado: 0,8 ms", en: "Armed: 0.8 ms", icon: "verified", tone: "is-ok" },
  { partial: { state: "sessionMismatch" }, es: "Sesión distinta", en: "Different session", icon: "difference", tone: "is-error" },
  { partial: { state: "mainLost" }, es: "PRINCIPAL PERDIDO", en: "MAIN LOST", icon: "warning", tone: "is-lost" },
  { partial: { state: "standalone" }, es: "En solitario", en: "Standalone", icon: "person", tone: "is-standalone" },
];

describe("redundancy pill", () => {
  for (const row of TABLE) {
    for (const language of ["es", "en"] as const) {
      it(`${row.partial.role ?? "backup"} ${row.partial.state} in ${language}`, async () => {
        await i18n.changeLanguage(language);
        useRedundancyStore.setState({ status: status(row.partial) });
        render(<RedundancyBadge />);
        const button = screen.getByRole("button", { name: new RegExp(row[language]) });
        expect(button.textContent).toContain(row[language]);
        expect(button.className).toContain(row.tone);
        expect(button.querySelector(`[data-icon="${row.icon}"]`)).not.toBeNull();
        expect(screen.getByRole("status")).toBeTruthy();
      });
    }
  }

  it("is hidden with redundancy off", () => {
    useRedundancyStore.setState({ status: status({ role: "off", state: "off" }) });
    const { container } = render(<RedundancyBadge />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing at all with the feature flag off", () => {
    flags.redundancy = false;
    useRedundancyStore.setState({ status: status({ state: "armed" }) });
    const { container } = render(<RedundancyBadge />);
    expect(container.innerHTML).toBe("");
  });
});

describe("settings tab on phones", () => {
  it("is hidden on mobile and shown on desktop", () => {
    const tabs = [{ id: "audio" as const }, { id: "redundancy" as const }];
    expect(MOBILE_HIDDEN_SETTINGS_TABS).toContain("redundancy");
    expect(visibleSettingsTabs(tabs, { isMobile: true, midiAvailable: true }).map((tab) => tab.id)).toEqual(["audio"]);
    expect(visibleSettingsTabs(tabs, { isMobile: false, midiAvailable: true }).map((tab) => tab.id)).toEqual(["audio", "redundancy"]);
  });
});

function GuardedPlay({ onPlay }: { onPlay: () => void }) {
  const guard = useTransportGuard();
  return (
    <button type="button" aria-label="Play" aria-disabled={guard.locked || undefined} title={guard.lockTitle} onClick={guard.guard(onPlay)}>
      play
    </button>
  );
}

describe("transport lock on a following backup", () => {
  it("looks disabled and a press only shows the notice; unlocked when the main is lost", () => {
    const onPlay = vi.fn();
    useRedundancyStore.setState({ status: status({ state: "following" }) });
    render(<GuardedPlay onPlay={onPlay} />);
    const button = screen.getByRole("button", { name: "Play" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toContain("PC A");
    fireEvent.click(button);
    expect(onPlay).not.toHaveBeenCalled();
    expect(useRedundancyStore.getState().notice).toContain("PC A");

    act(() => useRedundancyStore.getState().setStatus(status({ state: "mainLost" })));
    expect(button.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(button);
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it("the main is never locked", () => {
    const onPlay = vi.fn();
    useRedundancyStore.setState({ status: status({ role: "main", state: "backupArmed" }) });
    render(<GuardedPlay onPlay={onPlay} />);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });
});

describe("settings go through their own commands", () => {
  it("loads and saves redundancy.json, never AppSettings", async () => {
    render(<RedundancySettingsTab />);
    const pin = await screen.findByRole("textbox", { name: /PIN del respaldo/ });
    expect((pin as HTMLInputElement).value).toBe("4321");
    fireEvent.change(pin, { target: { value: "9876" } });
    fireEvent.blur(pin);
    expect(api.getRedundancySettings).toHaveBeenCalled();
    expect(api.saveRedundancySettings).toHaveBeenCalledWith({ backupPin: "9876" });
  });

  it("reads and writes MIDI bytes in hex", () => {
    expect(parseMidiBytes("C0 05")).toEqual([0xc0, 5]);
    expect(parseMidiBytes("b0,14,7f")).toEqual([0xb0, 0x14, 0x7f]);
    expect(parseMidiBytes("")).toEqual([]);
    expect(parseMidiBytes("C0")).toBeNull();
    expect(formatMidiBytes([0xc0, 5])).toBe("C0 05");
  });
});
