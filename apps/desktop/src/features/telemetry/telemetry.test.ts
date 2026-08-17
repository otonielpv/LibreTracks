import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyPlatform,
  dailyDeviceToken,
  recordProductEvent,
  resetTelemetrySessionForTest,
  submitAppSession,
  updateInstallationProfile,
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
    expect(body).toMatchObject({
      event: "app_started",
      consentVersion: 3,
      version: "1.10.0",
      installationAgeBucket: "day_0",
      activeDaysBucket: "1",
    });
    expect(body.dailyDeviceToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reports only coarse installation maturity buckets", () => {
    expect(updateInstallationProfile(new Date("2026-08-01T12:00:00Z"))).toEqual({
      installationAgeBucket: "day_0",
      activeDaysBucket: "1",
    });
    expect(updateInstallationProfile(new Date("2026-08-02T12:00:00Z"))).toEqual({
      installationAgeBucket: "days_1_7",
      activeDaysBucket: "2_3",
    });
    expect(updateInstallationProfile(new Date("2026-09-15T12:00:00Z"))).toEqual({
      installationAgeBucket: "days_31_90",
      activeDaysBucket: "2_3",
    });
  });

  it("sends each allowlisted product signal at most once per app session", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));
    useTelemetryStore.getState().setPreference("enabled");
    await submitAppSession("1.10.0");

    recordProductEvent("feature_metronome");
    recordProductEvent("feature_metronome");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      event: "feature_metronome",
      consentVersion: 3,
    });
    expect(body).not.toHaveProperty("installationAgeBucket");
  });

  it("serializes telemetry requests instead of creating concurrent bursts", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));
    useTelemetryStore.getState().setPreference("enabled");
    await submitAppSession("1.10.0");

    let finishFirstProduct!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { finishFirstProduct = resolve; }),
    );
    recordProductEvent("feature_metronome");
    recordProductEvent("feature_compact_view");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    finishFirstProduct(new Response(null, { status: 202 }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("reuses the daily SHA-256 token across queued events", async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));
    useTelemetryStore.getState().setPreference("enabled");

    await submitAppSession("1.10.0");
    recordProductEvent("feature_metronome");
    recordProductEvent("feature_compact_view");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it("requires fresh consent when the stored disclosure version is old", async () => {
    localStorage.setItem(
      "libretracks.telemetry.preference.v1",
      JSON.stringify({ state: { preference: "enabled" }, version: 2 }),
    );

    await useTelemetryStore.persist.rehydrate();

    expect(useTelemetryStore.getState().preference).toBe("undecided");
  });
});
