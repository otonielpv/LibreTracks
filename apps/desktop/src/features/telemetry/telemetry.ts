import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TelemetryPreference = "undecided" | "enabled" | "disabled";

type TelemetryState = {
  preference: TelemetryPreference;
  setPreference: (preference: TelemetryPreference) => void;
};

const TELEMETRY_ENDPOINT =
  "https://libretracks.pages.dev/api/telemetry/events";
const TELEMETRY_CONSENT_VERSION = 2;
const INSTALL_SECRET_KEY = "libretracks.telemetry.install-secret.v1";
let submittedThisSession = false;

export const useTelemetryStore = create<TelemetryState>()(
  persist(
    (set) => ({
      preference: "undecided",
      setPreference: (preference) => {
        if (preference !== "enabled") {
          localStorage.removeItem(INSTALL_SECRET_KEY);
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

  const platform = await resolvePlatform();
  const token = await dailyDeviceToken(getInstallSecret());

  try {
    await fetch(TELEMETRY_ENDPOINT, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "app_started",
        consentVersion: TELEMETRY_CONSENT_VERSION,
        version,
        dailyDeviceToken: token,
        ...platform,
      }),
    });
  } catch {
    // Best effort only. Never log telemetry failures into the user's error log.
  }
}

export function resetTelemetrySessionForTest(): void {
  submittedThisSession = false;
}
