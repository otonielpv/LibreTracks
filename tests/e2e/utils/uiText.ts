import en from "../../../apps/desktop/src/shared/i18n/en.ts";
import es from "../../../apps/desktop/src/shared/i18n/es.ts";

/**
 * The language the guide harnesses drive the app in: LT_GUIDESHOTS_LANG=en
 * for the English guide, Spanish otherwise.
 *
 * The harnesses find buttons by the text on them ("Exportar Cancion",
 * "Cancelar"…). Rather than keep a second, English copy of every label by
 * hand, `L()` looks the Spanish label up in the app's own translations and
 * returns what the app shows in the current language — so a renamed string
 * is followed for free, and a label that is not a translation (a song or
 * track name from the session) comes back unchanged.
 */
export const UI_LANG: "es" | "en" = process.env.LT_GUIDESHOTS_LANG === "en" ? "en" : "es";

type Strings = { [key: string]: string | Strings };

function flatten(tree: Strings, prefix = "", out = new Map<string, string>()) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else flatten(value, path, out);
  }
  return out;
}

const esStrings = flatten(es as unknown as Strings);
const enStrings = flatten(en as unknown as Strings);

/**
 * `spanish` as the app shows it in UI_LANG. It may be the start of a label
 * ("Exportar sesi" for "Exportar sesión…"); the match prefers an exact label,
 * then one that starts with it, then one that contains it.
 */
export function L(spanish: string): string {
  if (UI_LANG === "es") return spanish;
  const needle = spanish.toLowerCase();
  const candidates = [...esStrings.entries()].filter(([key, value]) => enStrings.has(key) && value.toLowerCase().includes(needle));
  const pick =
    candidates.find(([, value]) => value.toLowerCase() === needle) ??
    candidates.find(([, value]) => value.toLowerCase().startsWith(needle)) ??
    candidates[0];
  if (!pick) return spanish; // not a UI string (a name from the session)
  const english = enStrings.get(pick[0]) as string;
  // A partial needle maps to the start of the English label of the same length
  // would be guesswork: hand back the whole label, matched with `includes`.
  return english.replace(/\{\{[^}]+\}\}/g, "").trim();
}

/** Same, escaped for a case-insensitive whole-label RegExp. */
export function Lre(spanish: string): string {
  return `^${L(spanish).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}
