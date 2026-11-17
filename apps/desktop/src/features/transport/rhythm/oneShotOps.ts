// Operaciones puras sobre el set de one shots (plan drum-loops, paso 09).
// Devuelven un set nuevo, siempre con 12 huecos en el banco tocado.
import {
  ONE_SHOT_MAX_BANKS,
  ONE_SHOT_PADS_PER_BANK,
  type OneShotBank,
  type OneShotPad,
  type OneShotSet,
} from "@libretracks/shared/models";

const LETTERS = ["A", "B", "C", "D"];

function padded(bank: OneShotBank): OneShotBank {
  const pads = bank.pads.slice(0, ONE_SHOT_PADS_PER_BANK);
  while (pads.length < ONE_SHOT_PADS_PER_BANK) pads.push(null);
  return { ...bank, pads };
}

/** El set con al menos `bankIndex + 1` bancos (A-D). */
export function ensureBank(set: OneShotSet, bankIndex: number): OneShotSet {
  const banks = set.banks.map(padded);
  const target = Math.min(ONE_SHOT_MAX_BANKS - 1, Math.max(0, bankIndex));
  while (banks.length <= target) {
    const letter = LETTERS[banks.length];
    banks.push({ id: letter.toLowerCase(), name: letter, pads: new Array(ONE_SHOT_PADS_PER_BANK).fill(null) });
  }
  return { banks };
}

function withBank(set: OneShotSet, bankIndex: number, edit: (bank: OneShotBank) => OneShotBank): OneShotSet {
  const next = ensureBank(set, bankIndex);
  const banks = next.banks.slice();
  banks[bankIndex] = padded(edit(banks[bankIndex]));
  return { banks };
}

export function setPad(set: OneShotSet, bankIndex: number, padIndex: number, pad: OneShotPad | null): OneShotSet {
  return withBank(set, bankIndex, (bank) => {
    const pads = padded(bank).pads.slice();
    if (padIndex >= 0 && padIndex < ONE_SHOT_PADS_PER_BANK) pads[padIndex] = pad;
    return { ...bank, pads };
  });
}

export function swapPads(set: OneShotSet, bankIndex: number, a: number, b: number): OneShotSet {
  if (a === b) return set;
  return withBank(set, bankIndex, (bank) => {
    const pads = padded(bank).pads.slice();
    [pads[a], pads[b]] = [pads[b], pads[a]];
    return { ...bank, pads };
  });
}

export function renameBank(set: OneShotSet, bankIndex: number, name: string): OneShotSet {
  return withBank(set, bankIndex, (bank) => ({ ...bank, name }));
}
