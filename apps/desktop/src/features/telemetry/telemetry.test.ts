import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyPlatform,
  dailyDeviceToken,
  resetTelemetrySessionForTest,
  submitAppSession,
  useTelemetryStore,
} from "./telemetry";

describe("privacy-preserving telemetry", () => {
  beforeEach(() => {
    localStorage.clear();
    useTelemetryStore.setState({ preference: "undecided" });
    resetTelemetrySessionForTest();
    vi.restoreAllMocks();
  });

  it("classifies only broad platform properties", () => {
    expect(
      classifyPlatform(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Win32",
      ),
    ).toEqual({ os: "windows", arch: "x86_64", deviceClass: "desktop" });
    expect(classifyPlatform("Mozilla/5.0 (Linux; Android 15; Mobile)"))
      .toMatchObject({ os: "android", deviceClass: "mobile" });
  });

  it("uses a stable token within one UTC day and rotates the next day", async () => {
    const secret = "a".repeat(64);
    const first = await dailyDeviceToken(secret, new Date("2026-08-17T01:00:00Z"));
    const sameDay = await dailyDeviceToken(secret, new Date("2026-08-17T23:00:00Z"));
    const nextDay = await dailyDeviceToken(secret, new Date("2026-08-18T00:00:00Z"));

    expect(first).toHaveLength(64);
    expect(sameDay).toBe(first);
    expect(nextDay).not.toBe(first);
  });

  it("sends nothing before opt-in and only one start per app session", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));

    await submitAppSession("1.10.0");
    expect(fetchMock).not.toHaveBeenCalled();

    useTelemetryStore.getState().setPreference("enabled");
    await submitAppSession("1.10.0");
    await submitAppSession("1.10.0");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ event: "app_started", version: "1.10.0" });
    expect(body.dailyDeviceToken).toMatch(/^[a-f0-9]{64}$/);
  });
});
