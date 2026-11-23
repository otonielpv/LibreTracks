import type { MarkerKind } from "../models";

import vocabulary from "./sectionVocab.json";

/**
 * The one vocabulary of section names, read from `sectionVocab.json`, which
 * `crates/libretracks-core/src/section_vocab.rs` generates. There is no
 * second table: to add a word, add it in Rust and regenerate
 * (`UPDATE_SECTION_VOCAB=1 cargo test -p libretracks-core section_vocab_json`).
 *
 * `canonicalLabel` is Rust `canonical_label`, line for line; both pass
 * `sectionLabels.cases.json`.
 */

/** Where a label was written: abbreviations ("V1", "C") only count in a
 * sequence, where every item is a label. */
export type LabelContext = "header" | "sequence" | "free";

export type LabelMeaning = { kind: MarkerKind; number: number | null };

type Phrase = [string[], string];

const joinedPhrases = (phrases: Phrase[]) =>
  phrases.map(([words, kind]) => [words.join(""), kind] as const);

const LABEL_WORDS = [...joinedPhrases(vocabulary.labelPhrases as Phrase[]), ...joinedPhrases(vocabulary.phrases as Phrase[])];
const SECTION_KINDS = new Set<string>(vocabulary.sectionKinds);
const ABBREVIATIONS = new Map(vocabulary.abbreviations as Array<[string, string]>);
const FAMILIES = new Map(vocabulary.families as Array<[string, string]>);
const CHART_KIND_ALIASES = new Map(vocabulary.chartKindAliases as Array<[string, string]>);
const LYRICLESS = new Set<string>(vocabulary.lyricless);
const NUMBER_WORDS = new Map(vocabulary.numberWords as Array<[string, number]>);
const ROMAN_NUMERALS = new Map(vocabulary.romanNumerals as Array<[string, number]>);
/** Kinds a written label may name (Rust `section_token`): cues never. */
const LABEL_KINDS = new Set<string>(vocabulary.labelKinds);

const ACCENTS: Record<string, string> = {
  á: "a", à: "a", ä: "a", â: "a", ã: "a",
  é: "e", è: "e", ë: "e", ê: "e",
  í: "i", ì: "i", ï: "i", î: "i",
  ó: "o", ò: "o", ö: "o", ô: "o", õ: "o",
  ú: "u", ù: "u", ü: "u", û: "u",
  ñ: "n", ç: "c",
};

/** Rust `tokens`: lowercase, accents off, hyphens joined, other punctuation
 * as spaces. */
export function vocabTokens(text: string): string[] {
  let cleaned = "";
  for (const raw of text) {
    const lower = raw.length === 1 && raw >= "A" && raw <= "Z" ? raw.toLowerCase() : raw;
    const accent = ACCENTS[lower] ?? ACCENTS[lower.toLowerCase()];
    if (accent) cleaned += accent;
    else if (raw === "-") continue;
    else if (/[\p{L}\p{N}]/u.test(raw)) cleaned += lower;
    else cleaned += " ";
  }
  return cleaned.split(/\s+/).filter(Boolean);
}

function numberWord(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  return NUMBER_WORDS.get(token) ?? null;
}

function isRepeatMark(word: string): boolean {
  return /^x\d+$/.test(word) || /^\d+x$/.test(word);
}

function exactLabelKind(text: string): string | null {
  const phrase = LABEL_WORDS.find(([joined]) => joined === text)?.[1];
  const kind = phrase ?? [...SECTION_KINDS].find((candidate) => candidate.replace(/_/g, "") === text) ?? null;
  return kind && LABEL_KINDS.has(kind) ? kind : null;
}

function labelKind(letters: string): string | null {
  return (
    exactLabelKind(letters) ??
    (letters.endsWith("s") ? exactLabelKind(letters.slice(0, -1)) : null) ??
    (letters.endsWith("es") ? exactLabelKind(letters.slice(0, -2)) : null)
  );
}

/**
 * The section a written label names and its number: "Estrofa 2",
 * "Pre-Coro", "CORO (x2)", "Verse II", "Coro final", "V1" (only in a
 * sequence). Cues, counts, unknown text and number 0 → `null`.
 */
export function canonicalLabel(text: string, context: LabelContext): LabelMeaning | null {
  const words = vocabTokens(text);
  if (words.length > 1 && isRepeatMark(words[words.length - 1])) words.pop();
  let number: number | null = null;
  if (words.length > 1) {
    const last = words[words.length - 1];
    const value = numberWord(last) ?? ROMAN_NUMERALS.get(last) ?? null;
    if (value !== null) {
      number = value;
      words.pop();
    }
  }
  const joined = words.join("");
  const letters = joined.replace(/\d+$/, "");
  const glued = joined.slice(letters.length);
  if (glued) {
    if (number !== null) return null;
    number = Number(glued);
  }
  if (number === 0 || (number !== null && number > 99)) return null;
  if (!letters) return null;
  const kind = labelKind(letters) ?? (context === "sequence" ? (ABBREVIATIONS.get(letters) ?? null) : null);
  if (!kind) return null;
  return { kind: kind as MarkerKind, number };
}

/** The family of a kind: the names of the same part of a song in different
 * sheets ("Refrain" plays the "Coro"). `custom` and nothing → `null`. */
export function sectionFamily(kind: MarkerKind | string | null | undefined): string | null {
  if (!kind || kind === "custom") return null;
  return FAMILIES.get(kind) ?? kind;
}

/** How a chord chart reads a kind (`chartKindAliases`): a refrain header is the sheet's chorus. */
export function chartKind(kind: MarkerKind): MarkerKind {
  return (CHART_KIND_ALIASES.get(kind) as MarkerKind | undefined) ?? kind;
}

/** Sections usually played, not sung (Rust `is_lyricless`). */
export function isLyricless(kind: MarkerKind | string | null | undefined): boolean {
  return Boolean(kind && LYRICLESS.has(kind));
}
