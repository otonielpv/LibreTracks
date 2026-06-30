// Keyboard-binding normalisation and display formatting.
//
// A "binding" is a canonical string description of a key chord with a fixed
// modifier order, e.g. "Ctrl+S", "Shift+Space", "Ctrl+Shift+Z", "S",
// "ArrowLeft". This is the single textual form we persist, compare, and show
// (after re-formatting) in the shortcuts panel.
//
// Why a canonical string rather than an object: it makes the override map a
// plain `Record<actionId, string>` that serialises straight to localStorage,
// and makes conflict detection a trivial string-equality lookup.
//
// macOS note: historically every "Ctrl+X" shortcut in the app was matched with
// `event.ctrlKey || event.metaKey`, so Cmd+S worked the same as Ctrl+S on a
// Mac. We preserve that by normalising the Cmd (Meta) modifier to the same
// "Ctrl" token. There is therefore no separate "Meta+" binding — the primary
// command modifier is always written "Ctrl+" and matches either physical key.

/** Fixed modifier order so two equal chords always serialise identically. */
const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift"] as const;

const MODIFIER_KEY_NAMES = new Set([
  "Control",
  "Meta",
  "Alt",
  "Shift",
  "OS", // some older WebViews report the Windows/Cmd key as "OS"
]);

/**
 * True when the event's key is itself only a modifier (Shift, Ctrl, ...). A
 * lone modifier press never produces a binding — we wait for the real key.
 */
export function isModifierOnlyEvent(event: KeyboardEvent): boolean {
  return MODIFIER_KEY_NAMES.has(event.key);
}

/**
 * Canonical name for the "main" (non-modifier) key of an event.
 *
 * - Space → "Space" (we key off event.code so it's layout-independent and
 *   doesn't collide with the literal " " character).
 * - Single printable characters → upper-cased ("s" → "S", "=" → "="). Upper-
 *   casing makes "S" and Shift+"s" describe the same physical key; the Shift
 *   modifier is tracked separately.
 * - Named keys (Arrow*, Home, End, Delete, Backspace, Escape, Tab, Enter, ...)
 *   → used verbatim from event.key.
 */
function mainKeyName(event: KeyboardEvent): string | null {
  if (event.code === "Space") {
    return "Space";
  }

  const key = event.key;
  if (!key || MODIFIER_KEY_NAMES.has(key)) {
    return null;
  }

  if (key === " ") {
    return "Space";
  }

  // Printable single character: normalise to upper case so the Shift modifier
  // is the only thing that distinguishes e.g. "S" from "s".
  if (key.length === 1) {
    return key.toUpperCase();
  }

  return key;
}

/**
 * Convert a keyboard event to its canonical binding string, or null when the
 * event can't form a binding (modifier-only press, dead key, etc.).
 */
export function eventToBinding(event: KeyboardEvent): string | null {
  const main = mainKeyName(event);
  if (main === null) {
    return null;
  }

  const parts: string[] = [];
  // Cmd (Meta) folds into the primary "Ctrl" modifier — see file header.
  if (event.ctrlKey || event.metaKey) {
    parts.push("Ctrl");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }

  // Re-order defensively in case the pushes above ever diverge from
  // MODIFIER_ORDER; keeps serialisation stable.
  parts.sort((a, b) => MODIFIER_ORDER.indexOf(a as never) - MODIFIER_ORDER.indexOf(b as never));

  parts.push(main);
  return parts.join("+");
}

const DISPLAY_KEY_LABELS: Record<string, string> = {
  Space: "Space",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Delete: "Del",
  Backspace: "⌫",
  Escape: "Esc",
  Enter: "↵",
};

const MAC_MODIFIER_SYMBOLS: Record<string, string> = {
  Ctrl: "⌘",
  Alt: "⌥",
  Shift: "⇧",
};

/**
 * Human-friendly rendering of a binding for the shortcuts panel. On macOS the
 * modifiers become the familiar glyphs (⌘⌥⇧) and the "Ctrl" token maps to ⌘
 * (the primary command key), matching how the chord is actually pressed there.
 */
export function formatBindingForDisplay(
  binding: string | null,
  isMac: boolean,
): string {
  if (!binding) {
    return "";
  }

  const parts = binding.split("+");
  const main = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  const mainLabel = DISPLAY_KEY_LABELS[main] ?? main;

  if (isMac) {
    const symbols = modifiers.map((mod) => MAC_MODIFIER_SYMBOLS[mod] ?? mod);
    return [...symbols, mainLabel].join("");
  }

  return [...modifiers, mainLabel].join("+");
}

/** Best-effort platform check usable in the renderer. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const platform =
    // navigator.platform is deprecated but still the most reliable signal in
    // the Tauri WebView; fall back to userAgent.
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent ??
    "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}
