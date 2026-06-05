import type { AppLanguage } from "./i18n";

export const RELEASES_API_URL =
  "https://api.github.com/repos/otonielpv/LibreTracks/releases/latest";

/** Localized download page: `/download/` for English, `/es/download/` for Spanish. */
export function downloadsPageUrl(language: AppLanguage): string {
  return language === "es"
    ? "https://libretracks.pages.dev/es/download/"
    : "https://libretracks.pages.dev/download/";
}

const STORAGE_KEYS = {
  skippedVersion: "libretracks.updateCheck.skippedVersion",
} as const;

export type ReleaseInfo = {
  tag: string;
  version: string;
  url: string;
  publishedAt: string | null;
  body: string;
};

type GithubRelease = {
  tag_name?: string;
  html_url?: string;
  published_at?: string | null;
  body?: string | null;
  prerelease?: boolean;
  draft?: boolean;
};

export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

export function parseSemver(value: string): number[] | null {
  const cleaned = normalizeVersion(value);
  const core = cleaned.split(/[-+]/)[0];
  if (!core) return null;
  const parts = core.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

export function compareVersions(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

export function isNewerVersion(remote: string, current: string): boolean {
  return compareVersions(remote, current) > 0;
}

const SECTION_HEADINGS: Record<AppLanguage, RegExp[]> = {
  es: [
    /^#{1,3}\s*Novedades(?:\s+de)?\s+v?\d+\.\d+\.\d+/i,
    /^#{1,3}\s*Novedades/i,
    /^#{1,3}\s*Cambios/i,
  ],
  en: [
    /^#{1,3}\s*What['’]s\s+New\s+in\s+v?\d+\.\d+\.\d+/i,
    /^#{1,3}\s*What['’]s\s+New/i,
    /^#{1,3}\s*Changes/i,
    /^#{1,3}\s*Release\s+Notes/i,
  ],
};

const ANY_HEADING = /^#{1,3}\s+/;

export function extractReleaseNotesForLanguage(
  body: string,
  language: AppLanguage,
): string {
  if (!body) return "";

  const lines = body.split(/\r?\n/);
  const patterns = SECTION_HEADINGS[language];

  let startIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (patterns.some((pattern) => pattern.test(lines[i]))) {
      startIndex = i;
      break;
    }
  }

  if (startIndex === -1) {
    return body.trim();
  }

  const collected: string[] = [lines[startIndex]];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (ANY_HEADING.test(lines[i])) break;
    collected.push(lines[i]);
  }

  return collected.join("\n").trim();
}

export type FetchOptions = {
  signal?: AbortSignal;
};

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

/**
 * Fetch the latest release JSON. In a packaged Tauri build the WebView `fetch`
 * to api.github.com is rejected (cross-origin from `tauri://` + GitHub requires
 * a User-Agent), which silently broke the in-app update notification in
 * production while still working in `dev`. So when running inside Tauri we route
 * the request through the Rust `fetch_latest_release` command, which has no
 * origin restrictions and sets the required User-Agent. The browser `fetch`
 * path is kept for the web build and unit tests.
 */
async function fetchReleaseJson(options: FetchOptions): Promise<string> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("fetch_latest_release", { url: RELEASES_API_URL });
  }
  const response = await fetch(RELEASES_API_URL, {
    headers: { Accept: "application/vnd.github+json" },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}`);
  }
  return response.text();
}

export async function fetchLatestRelease(
  options: FetchOptions = {},
): Promise<ReleaseInfo | null> {
  const raw = await fetchReleaseJson(options);
  const data = JSON.parse(raw) as GithubRelease;
  if (data.draft || data.prerelease || !data.tag_name) return null;
  return {
    tag: data.tag_name,
    version: normalizeVersion(data.tag_name),
    url: data.html_url ?? `https://github.com/otonielpv/LibreTracks/releases/tag/${data.tag_name}`,
    publishedAt: data.published_at ?? null,
    body: data.body ?? "",
  };
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getSkippedVersion(): string | null {
  return safeStorage()?.getItem(STORAGE_KEYS.skippedVersion) ?? null;
}

export function setSkippedVersion(version: string): void {
  safeStorage()?.setItem(STORAGE_KEYS.skippedVersion, normalizeVersion(version));
}

export function clearSkippedVersion(): void {
  safeStorage()?.removeItem(STORAGE_KEYS.skippedVersion);
}

/**
 * "Remind me later" snooze. Kept in memory only (not persisted) so it lasts
 * the current app session and the popup shows again on the next launch. The
 * only persistent silencer is "Skip this version" (getSkippedVersion).
 */
let sessionSnoozed = false;

export function isSnoozedThisSession(): boolean {
  return sessionSnoozed;
}

export function snoozeUntil(): void {
  sessionSnoozed = true;
}

export function clearSnooze(): void {
  sessionSnoozed = false;
}

export type ShouldNotifyArgs = {
  currentVersion: string;
  release: ReleaseInfo;
  bypassSnooze?: boolean;
};

export function shouldNotify({
  currentVersion,
  release,
  bypassSnooze = false,
}: ShouldNotifyArgs): boolean {
  if (!isNewerVersion(release.version, currentVersion)) return false;
  const skipped = getSkippedVersion();
  if (skipped && compareVersions(skipped, release.version) >= 0) return false;
  if (!bypassSnooze && sessionSnoozed) return false;
  return true;
}

/**
 * The update check now runs on every app launch (a session only starts once),
 * so the popup reappears each time you open the app unless you skipped the
 * version. Kept as a function so callers and tests have a single seam.
 */
export function shouldRunAutoCheck(): boolean {
  return true;
}
