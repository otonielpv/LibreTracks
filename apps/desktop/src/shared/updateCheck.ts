import type { AppLanguage } from "./i18n";

export const RELEASES_API_URL =
  "https://api.github.com/repos/otonielpv/LibreTracks/releases/latest";
export const DOWNLOADS_PAGE_URL = "https://libretracks.pages.dev/downloads";

const STORAGE_KEYS = {
  skippedVersion: "libretracks.updateCheck.skippedVersion",
  remindAfter: "libretracks.updateCheck.remindAfter",
  lastCheck: "libretracks.updateCheck.lastCheck",
} as const;

const REMIND_LATER_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

export async function fetchLatestRelease(
  options: FetchOptions = {},
): Promise<ReleaseInfo | null> {
  const response = await fetch(RELEASES_API_URL, {
    headers: { Accept: "application/vnd.github+json" },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}`);
  }
  const data = (await response.json()) as GithubRelease;
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

export function getRemindAfter(): number {
  const raw = safeStorage()?.getItem(STORAGE_KEYS.remindAfter);
  const value = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(value) ? value : 0;
}

export function snoozeUntil(now: number = Date.now()): void {
  safeStorage()?.setItem(
    STORAGE_KEYS.remindAfter,
    String(now + REMIND_LATER_MS),
  );
}

export function clearSnooze(): void {
  safeStorage()?.removeItem(STORAGE_KEYS.remindAfter);
}

export function getLastCheck(): number {
  const raw = safeStorage()?.getItem(STORAGE_KEYS.lastCheck);
  const value = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(value) ? value : 0;
}

export function setLastCheck(now: number = Date.now()): void {
  safeStorage()?.setItem(STORAGE_KEYS.lastCheck, String(now));
}

export type ShouldNotifyArgs = {
  currentVersion: string;
  release: ReleaseInfo;
  now?: number;
  bypassSnooze?: boolean;
};

export function shouldNotify({
  currentVersion,
  release,
  now = Date.now(),
  bypassSnooze = false,
}: ShouldNotifyArgs): boolean {
  if (!isNewerVersion(release.version, currentVersion)) return false;
  const skipped = getSkippedVersion();
  if (skipped && compareVersions(skipped, release.version) >= 0) return false;
  if (!bypassSnooze && now < getRemindAfter()) return false;
  return true;
}

export function shouldRunAutoCheck(now: number = Date.now()): boolean {
  const last = getLastCheck();
  if (!last) return true;
  return now - last >= CHECK_INTERVAL_MS;
}
