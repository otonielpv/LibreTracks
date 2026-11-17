import type { LeadTime } from "../desktopApi";

/** The units a lead can be expressed in, as stored. */
export type LeadUnit = LeadTime["unit"];

/** One-click choices in the editor. The custom row covers everything else. */
export const LEAD_PRESETS: ReadonlyArray<{ key: string; lead: LeadTime }> = [
  { key: "halfBeat", lead: { unit: "beats", count: 0.5 } },
  { key: "oneBeat", lead: { unit: "beats", count: 1 } },
  { key: "twoBeats", lead: { unit: "beats", count: 2 } },
  { key: "oneBar", lead: { unit: "bars", count: 1 } },
  { key: "twoBars", lead: { unit: "bars", count: 2 } },
];

/** The amount of a lead in its own unit. */
export function leadAmount(lead: LeadTime): number {
  return lead.unit === "seconds" ? lead.seconds : lead.count;
}

/** A lead of `amount` in `unit`. */
export function makeLead(unit: LeadUnit, amount: number): LeadTime {
  return unit === "seconds" ? { unit, seconds: amount } : { unit, count: amount };
}

/**
 * `null` for "no lead": missing, zero, negative or not a number. The backend
 * reads those the same way; normalizing here keeps "no lead" from being saved
 * as `{count: 0}`.
 */
export function normalizeLead(lead: LeadTime | null | undefined): LeadTime | null {
  if (!lead) return null;
  const amount = leadAmount(lead);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return lead;
}

export function sameLead(a: LeadTime | null, b: LeadTime | null): boolean {
  if (a === null || b === null) return a === b;
  return a.unit === b.unit && Math.abs(leadAmount(a) - leadAmount(b)) < 1e-9;
}

/** The preset a lead matches, if any. */
export function presetKeyOf(lead: LeadTime | null): string | null {
  if (lead === null) return null;
  return LEAD_PRESETS.find((preset) => sameLead(preset.lead, lead))?.key ?? null;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Short human label: "1 beat", "2 bars", "0.75 s". */
export function describeLead(lead: LeadTime, t: Translate): string {
  const amount = leadAmount(lead);
  const shown = Number.isInteger(amount) ? String(amount) : String(Number(amount.toFixed(3)));
  if (lead.unit === "seconds") {
    return t("transport.lead.amountSeconds", { amount: shown });
  }
  return t(lead.unit === "beats" ? "transport.lead.amountBeats" : "transport.lead.amountBars", {
    amount: shown,
    count: amount,
  });
}
