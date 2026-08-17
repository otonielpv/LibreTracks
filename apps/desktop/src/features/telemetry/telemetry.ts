import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TelemetryPreference = "undecided" | "enabled" | "disabled";

type TelemetryState = {
  preference: TelemetryPreference;
  setPreference: (preference: TelemetryPreference) => void;
};

const TELEMETRY_ENDPOINT =
  "https://libretracks.pages.dev/api/telemetry/events";
const TELEMETRY_CONSENT_VERSION = 3;
const INSTALL_SECRET_KEY = "libretracks.telemetry.install-secret.v1";
const INSTALL_PROFILE_KEY = "libretracks.telemetry.install-profile.v1";
let submittedThisSession = false;
let configuredVersion = "";
let platformThisSession: Promise<TelemetryPlatform> | null = null;
const submittedProductEvents = new Set<ProductEventName>();

export const PRODUCT_EVENT_NAMES = [
  "project_created",
  "project_opened",
  "audio_imported",
  "audio_import_failed",
  "playback_started",
  "project_saved",
  "session_exported",
  "session_export_failed",
  "project_open_failed",
  "feature_compact_view",
  "feature_metronome",
  "feature_voice_guide",
  "feature_ambient_pads",
  "feature_automation",
  "feature_warp",
  "feature_midi",
  "feature_remote_panel",
  "active_5m",
  "active_15m",
  "active_30m",
  "active_60m",
] as const;

export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

export type InstallationProfile = {
  installationAgeBucket: "day_0" | "days_1_7" | "days_8_30" | "days_31_90" | "days_91_plus";
  activeDaysBucket: "1" | "2_3" | "4_7" | "8_30" | "31_plus";
};

export const useTelemetryStore = create<TelemetryState>()(
  persist(
    (set) => ({
      preference: "undecided",
      setPreference: (preference) => {
        if (preference !== "enabled") {
          localStorage.removeItem(INSTALL_SECRET_KEY);
          localStorage.removeItem(INSTALL_PROFILE_KEY);
        }
        set({ preference });
      },
    }),
    {
      name: "libretracks.telemetry.preference.v1",
      version: TELEMETRY_CONSENT_VERSION,
      migrate: (persistedState) => ({
        ...(persistedState as Partial<TelemetryState>),
        // Country-level analytics expands the originally described dataset.
        // Ask every existing participant for fresh, informed consent.
        preference: "undecided",
      }),
    },
  ),
);

export type TelemetryPlatform = {
  os: "windows" | "macos" | "linux" | "android" | "ios" | "unknown";
  arch: "x86_64" | "arm64" | "unknown";
  deviceClass: "desktop" | "mobile" | "tablet" | "unknown";
};

export function classifyPlatform(
  userAgent: string,
  platform = "",
): TelemetryPlatform {
  const source = `${userAgent} ${platform}`.toLowerCase();
  const isTablet = /ipad|tablet/.test(source);
  const isMobile = /android|iphone|ipod|mobile/.test(source);

  let os: TelemetryPlatform["os"] = "unknown";
  if (/android/.test(source)) os = "android";
  else if (/iphone|ipad|ipod/.test(source)) os = "ios";
  else if (/windows|win32|win64/.test(source)) os = "windows";
  else if (/macintosh|mac os|macintel/.test(source)) os = "macos";
  else if (/linux/.test(source)) os = "linux";

  let arch: TelemetryPlatform["arch"] = "unknown";
  if (/arm64|aarch64/.test(source)) arch = "arm64";
  else if (/x86_64|x64|win64|amd64/.test(source)) arch = "x86_64";

  return {
    os,
    arch,
    deviceClass: isTablet ? "tablet" : isMobile ? "mobile" : "desktop",
  };
}

async function resolvePlatform(): Promise<TelemetryPlatform> {
  if ((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<TelemetryPlatform>("get_telemetry_platform");
    } catch {
      // Fall through to broad User-Agent classification for older builds.
    }
  }
  return classifyPlatform(navigator.userAgent, navigator.platform ?? "");
}

function sessionPlatform(): Promise<TelemetryPlatform> {
  platformThisSession ??= resolvePlatform();
  return platformThisSession;
}

function randomInstallSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function getInstallSecret(): string {
  const existing = localStorage.getItem(INSTALL_SECRET_KEY);
  if (existing && /^[a-f0-9]{64}$/.test(existing)) return existing;
  const created = randomInstallSecret();
  localStorage.setItem(INSTALL_SECRET_KEY, created);
  return created;
}

export async function dailyDeviceToken(
  installSecret: string,
  now = new Date(),
): Promise<string> {
  const utcDay = now.toISOString().slice(0, 10);
  const bytes = new TextEncoder().encode(`${installSecret}:${utcDay}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function dayNumber(utcDay: string): number {
  return Math.floor(Date.parse(`${utcDay}T00:00:00Z`) / 86_400_000);
}

export function updateInstallationProfile(now = new Date()): InstallationProfile {
  const today = now.toISOString().slice(0, 10);
  let stored: { firstDay: string; lastActiveDay: string; activeDays: number } = {
    firstDay: today,
    lastActiveDay: today,
    activeDays: 1,
  };
  try {
    const parsed = JSON.parse(localStorage.getItem(INSTALL_PROFILE_KEY) ?? "null") as Partial<typeof stored> | null;
    if (
      parsed &&
      typeof parsed.firstDay === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(parsed.firstDay) &&
      typeof parsed.lastActiveDay === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(parsed.lastActiveDay) &&
      typeof parsed.activeDays === "number"
    ) {
      stored = {
        firstDay: parsed.firstDay,
        lastActiveDay: parsed.lastActiveDay,
        activeDays: Math.max(1, Math.min(10_000, Math.floor(parsed.activeDays))),
      };
    }
  } catch {
    // Replace malformed local telemetry metadata with a fresh coarse profile.
  }

  if (stored.lastActiveDay !== today) {
    stored.activeDays = Math.min(10_000, stored.activeDays + 1);
    stored.lastActiveDay = today;
  }
  localStorage.setItem(INSTALL_PROFILE_KEY, JSON.stringify(stored));

  const ageDays = Math.max(0, dayNumber(today) - dayNumber(stored.firstDay));
  const installationAgeBucket =
    ageDays === 0
      ? "day_0"
      : ageDays <= 7
        ? "days_1_7"
        : ageDays <= 30
          ? "days_8_30"
          : ageDays <= 90
            ? "days_31_90"
            : "days_91_plus";
  const activeDaysBucket =
    stored.activeDays === 1
      ? "1"
      : stored.activeDays <= 3
        ? "2_3"
        : stored.activeDays <= 7
          ? "4_7"
          : stored.activeDays <= 30
            ? "8_30"
            : "31_plus";
  return { installationAgeBucket, activeDaysBucket };
}

async function submitTelemetryEvent(
  event: "app_started" | ProductEventName,
  profile?: InstallationProfile,
): Promise<boolean> {
  if (!configuredVersion || useTelemetryStore.getState().preference !== "enabled") return false;
  const [platform, token] = await Promise.all([
    sessionPlatform(),
    dailyDeviceToken(getInstallSecret()),
  ]);

  try {
    const response = await fetch(TELEMETRY_ENDPOINT, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        consentVersion: TELEMETRY_CONSENT_VERSION,
        version: configuredVersion,
        dailyDeviceToken: token,
        ...platform,
        ...profile,
      }),
    });
    return response.ok;
  } catch {
    // Best effort only. Never log telemetry failures into the user's error log.
    return false;
  }
}

async function submitWithRetry(
  event: "app_started" | ProductEventName,
  profile?: InstallationProfile,
): Promise<void> {
  for (const delay of [0, 1_500, 5_000]) {
    if (delay > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
    }
    if (useTelemetryStore.getState().preference !== "enabled") return;
    if (await submitTelemetryEvent(event, profile)) return;
  }
}

/**
 * Records one app start after explicit opt-in. The random installation secret
 * never leaves this device; only its one-day derivative is sent. Failures are
 * intentionally silent because analytics must never affect the audio app.
 */
export async function submitAppSession(version: string): Promise<void> {
  if (submittedThisSession || useTelemetryStore.getState().preference !== "enabled") {
    return;
  }
  submittedThisSession = true;
  configuredVersion = version;
  await submitWithRetry("app_started", updateInstallationProfile());
}

/** Records adoption, outcomes and engagement once per app process and event. */
export function recordProductEvent(event: ProductEventName): void {
  if (
    submittedProductEvents.has(event) ||
    useTelemetryStore.getState().preference !== "enabled" ||
    !configuredVersion
  ) {
    return;
  }
  submittedProductEvents.add(event);
  void submitWithRetry(event);
}

export function recordPlaybackTransition(
  previousState: string | null | undefined,
  nextState: string | null | undefined,
): void {
  if (previousState !== "playing" && nextState === "playing") {
    recordProductEvent("playback_started");
  }
}

export function startEngagementTracking(): () => void {
  const thresholds: Array<[number, ProductEventName]> = [
    [5 * 60_000, "active_5m"],
    [15 * 60_000, "active_15m"],
    [30 * 60_000, "active_30m"],
    [60 * 60_000, "active_60m"],
  ];
  let activeMs = 0;
  let lastTick = Date.now();
  const interval = window.setInterval(() => {
    const now = Date.now();
    const elapsed = Math.min(30_000, Math.max(0, now - lastTick));
    lastTick = now;
    if (document.visibilityState !== "hidden") activeMs += elapsed;
    for (const [threshold, event] of thresholds) {
      if (activeMs >= threshold) recordProductEvent(event);
    }
  }, 15_000);
  return () => window.clearInterval(interval);
}

export function resetTelemetrySessionForTest(): void {
  submittedThisSession = false;
  configuredVersion = "";
  platformThisSession = null;
  submittedProductEvents.clear();
}
