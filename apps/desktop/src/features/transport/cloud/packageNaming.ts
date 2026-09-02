/**
 * Musical metadata carried in the file name of a package in the cloud.
 *
 * # Why the name, and not somewhere tidier
 *
 * Because the name is the one thing that survives everywhere. It is what the
 * user sees in Drive itself, in a share, in a download folder, and on another
 * device — none of which run LibreTracks. A song called `Cuan grande es El` is
 * three different arrangements once a band has been going a while; the same
 * name with `[120bpm Am 4-4]` after it is the one they meant.
 *
 * It is also what makes searching work at all: the app can only see the files
 * it created, and for those it gets a name and a size. Putting the tempo, key
 * and meter in the name means they can be searched and filtered without any
 * extra bookkeeping to keep in sync.
 */

export type PackageMeta = {
  /** Beats per minute, rounded to a whole number for the name. */
  bpm?: number | null;
  /** Canonical sharp-notation key, e.g. `Am`, `F#`. */
  key?: string | null;
  /** Time signature as written, e.g. `4/4`. */
  timeSignature?: string | null;
};

export type ParsedPackageName = PackageMeta & {
  /** The name without the metadata group, for display. */
  title: string;
};

/** `/` cannot appear in a file name, so meters travel as `4-4`. */
function meterToToken(timeSignature: string): string {
  return timeSignature.replace("/", "-");
}

function tokenToMeter(token: string): string {
  return token.replace("-", "/");
}

/**
 * Characters that would break a file name on some platform or other. Replaced
 * rather than stripped so two songs whose names differ only in punctuation do
 * not collide.
 */
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|[\]]/g, "-").trim();
}

/**
 * Build `Nombre [120bpm Am 4-4].ltpkg`.
 *
 * Fields that are unknown are simply left out, and with nothing known the name
 * is just the title plus its extension — an export never fails for want of
 * metadata.
 */
export function buildPackageFileName(
  title: string,
  extension: string,
  meta: PackageMeta,
): string {
  const tokens: string[] = [];
  if (typeof meta.bpm === "number" && Number.isFinite(meta.bpm) && meta.bpm > 0) {
    tokens.push(`${Math.round(meta.bpm)}bpm`);
  }
  if (meta.key) {
    tokens.push(sanitize(meta.key));
  }
  if (meta.timeSignature) {
    tokens.push(meterToToken(meta.timeSignature));
  }

  const base = sanitize(title) || "cancion";
  const suffix = tokens.length > 0 ? ` [${tokens.join(" ")}]` : "";
  return `${base}${suffix}${extension}`;
}

const BPM_TOKEN = /^(\d+(?:\.\d+)?)bpm$/i;
const KEY_TOKEN = /^([A-G][#b]?m?)$/;
const METER_TOKEN = /^(\d{1,2}-\d{1,2})$/;

/**
 * Read back what {@link buildPackageFileName} wrote.
 *
 * Tokens are matched by shape rather than by position, so a name written by an
 * older version — or edited by hand in Drive, which people do — still yields
 * whatever it does contain instead of nothing. A name with no metadata group at
 * all parses to just its title, which is the common case for anything uploaded
 * before this existed.
 */
export function parsePackageFileName(fileName: string): ParsedPackageName {
  const withoutExtension = fileName.replace(/\.(ltpkg|ltset)$/i, "");
  const match = withoutExtension.match(/^(.*?)\s*\[([^\]]*)\]\s*$/);
  if (!match) {
    return { title: withoutExtension.trim() };
  }

  const parsed: ParsedPackageName = { title: match[1].trim() };
  for (const token of match[2].split(/\s+/).filter(Boolean)) {
    const bpm = token.match(BPM_TOKEN);
    if (bpm) {
      parsed.bpm = Number(bpm[1]);
      continue;
    }
    const meter = token.match(METER_TOKEN);
    if (meter) {
      parsed.timeSignature = tokenToMeter(meter[1]);
      continue;
    }
    const key = token.match(KEY_TOKEN);
    if (key) {
      parsed.key = key[1];
    }
  }
  return parsed;
}

/** One-line summary of what is known, for a list row. e.g. `120bpm · Am · 4/4`. */
export function describePackageMeta(meta: PackageMeta): string {
  const parts: string[] = [];
  if (typeof meta.bpm === "number") parts.push(`${Math.round(meta.bpm)} bpm`);
  if (meta.key) parts.push(meta.key);
  if (meta.timeSignature) parts.push(meta.timeSignature);
  return parts.join(" · ");
}
