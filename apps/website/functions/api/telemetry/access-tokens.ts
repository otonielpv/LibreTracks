/// <reference types="@cloudflare/workers-types" />

import {
  type AnalyticsEnv,
  authFailure,
  authenticate,
  isMissingTable,
  listShareTokens,
  mintShareToken,
  serialiseToken,
  sha256Hex,
} from "./_auth";

/**
 * Management of the dashboard's share tokens.
 *
 * Reachable only with the `ANALYTICS_ADMIN_TOKEN` Pages secret. A share token
 * authenticates against `product-stats` and nothing else: presenting one here
 * is answered as though it were wrong, so a token handed to a collaborator can
 * never be used to mint more of itself or to revoke the maintainer's.
 */

const MAX_LABEL_LENGTH = 60;
// Two years. Past that a date is indistinguishable from "never", and "never" is
// already an option that says so honestly.
const MAX_EXPIRY_HOURS = 24 * 730;
// The list is read in full on every open of the panel, and a dashboard with
// hundreds of live credentials is a problem to be noticed rather than absorbed.
const MAX_TOKENS = 100;

const HOUR_MS = 3_600_000;

const json = (body: Record<string, unknown>, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Only the maintainer's secret opens this endpoint. A valid share token is
 * answered with the same 401 as a wrong one: telling its holder that it is
 * genuine but insufficient would confirm the token works somewhere, which is
 * the one thing a leaked token's finder does not otherwise know.
 */
async function requireAdmin(request: Request, env: AnalyticsEnv): Promise<Response | null> {
  const auth = await authenticate(request, env);
  if (auth.role === "admin") return null;
  if (auth.role === "none") return authFailure(auth.reason);
  return authFailure("unauthorized");
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters would survive into the token list and could redraw it;
  // the label is shown as text, never parsed.
  const label = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
  return label.length > 0 ? label : null;
}

/**
 * Resolves the requested lifetime.
 *
 * The client sends a duration rather than an instant so that the expiry is
 * stamped against the edge's clock: a browser running minutes fast would
 * otherwise mint a token that outlives, or falls short of, what was asked for.
 *
 * Returns `undefined` for an unusable value so that a malformed request fails
 * loudly instead of silently minting a token that never expires.
 */
function resolveExpiry(value: unknown, now: number): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const hours = Math.round(value);
  if (hours < 1 || hours > MAX_EXPIRY_HOURS) return undefined;
  return now + hours * HOUR_MS;
}

export const onRequestGet: PagesFunction<AnalyticsEnv> = async ({ request, env }) => {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  try {
    const tokens = await listShareTokens(env);
    return json({ tokens: tokens.map(serialiseToken), maxTokens: MAX_TOKENS });
  } catch (error) {
    if (isMissingTable(error)) return authFailure("migration_required");
    throw error;
  }
};

export const onRequestPost: PagesFunction<AnalyticsEnv> = async ({ request, env }) => {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const label = cleanLabel(payload.label);
  if (!label) return json({ error: "invalid_label" }, 400);

  const now = Date.now();
  const expiresAt = resolveExpiry(payload.expiresInHours ?? null, now);
  if (expiresAt === undefined) return json({ error: "invalid_expiry" }, 400);

  try {
    const existing = await env.TELEMETRY_DB.prepare(
      "SELECT COUNT(*) AS count FROM analytics_access_tokens",
    ).first<{ count: number }>();
    if ((existing?.count ?? 0) >= MAX_TOKENS) return json({ error: "too_many_tokens" }, 409);

    const token = mintShareToken();
    const id = crypto.randomUUID();
    await env.TELEMETRY_DB.prepare(
      `INSERT INTO analytics_access_tokens
         (id, token_hash, label, created_at, expires_at, last_used_at, use_count)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0)`,
    )
      .bind(id, await sha256Hex(token), label, now, expiresAt)
      .run();

    // The only time the plaintext exists anywhere. The table holds its SHA-256,
    // so a token that is not copied out of this response is gone for good and
    // the row it left behind has to be deleted and a new one created.
    return json({
      token,
      record: serialiseToken({
        id,
        label,
        createdAt: now,
        expiresAt,
        lastUsedAt: null,
        useCount: 0,
      }),
    });
  } catch (error) {
    if (isMissingTable(error)) return authFailure("migration_required");
    throw error;
  }
};

export const onRequestDelete: PagesFunction<AnalyticsEnv> = async ({ request, env }) => {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id) return json({ error: "missing_id" }, 400);

  try {
    const result = await env.TELEMETRY_DB.prepare(
      "DELETE FROM analytics_access_tokens WHERE id = ?1",
    )
      .bind(id)
      .run();
    // Revocation is a hard delete: a disabled row that still matches a hash is
    // one bug away from letting the token back in, and the audit value of
    // keeping it does not pay for that.
    return json({ revoked: (result.meta?.changes ?? 0) > 0 });
  } catch (error) {
    if (isMissingTable(error)) return authFailure("migration_required");
    throw error;
  }
};
