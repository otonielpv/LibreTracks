/// <reference types="@cloudflare/workers-types" />

/**
 * Authentication shared by the private dashboard endpoints.
 *
 * Two kinds of credential reach these endpoints:
 *
 * - The `ANALYTICS_ADMIN_TOKEN` Pages secret, held by the maintainer. It is the
 *   only credential that can mint or revoke share tokens.
 * - Share tokens from `analytics_access_tokens`, handed to people who need to
 *   read the numbers. They are read-only, individually revocable and may carry
 *   an expiry.
 *
 * The file name starts with an underscore and it exports no `onRequest*`
 * handler, so Pages does not turn it into a route.
 */

export interface AnalyticsEnv {
  TELEMETRY_DB: D1Database;
  ANALYTICS_ADMIN_TOKEN?: string;
}

export const MIN_ADMIN_TOKEN_LENGTH = 15;

/** Marks a share token at a glance, so a stray string is recognisable. */
export const SHARE_TOKEN_PREFIX = "ltm_";

export type ShareToken = {
  id: string;
  label: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  useCount: number;
};

export type Auth =
  | { role: "admin" }
  | { role: "guest"; token: ShareToken }
  | { role: "none"; reason: "not_configured" | "unauthorized" | "migration_required" };

type TokenRow = {
  id: string;
  label: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  use_count: number;
};

/**
 * Compares two secrets without leaking their contents through timing. Length is
 * compared up front and therefore does leak, which is deliberate: the length of
 * the admin token is not the secret, and padding the loop to hide it would only
 * add code with no attacker-visible difference.
 */
export function constantTimeEquals(supplied: string, expected: string): boolean {
  if (supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    difference |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export function bearerToken(request: Request): string {
  return request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function mintShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  const base64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${SHARE_TOKEN_PREFIX}${base64}`;
}

function toShareToken(row: TokenRow): ShareToken {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
  };
}

export function serialiseToken(token: ShareToken): Record<string, unknown> {
  return {
    id: token.id,
    label: token.label,
    createdAt: new Date(token.createdAt).toISOString(),
    expiresAt: token.expiresAt === null ? null : new Date(token.expiresAt).toISOString(),
    lastUsedAt: token.lastUsedAt === null ? null : new Date(token.lastUsedAt).toISOString(),
    useCount: token.useCount,
    expired: token.expiresAt !== null && token.expiresAt <= Date.now(),
  };
}

/**
 * `true` when the share-token table has not been created yet. Migration 0007 is
 * applied by hand like every other one here, so an existing deployment answers
 * every share-token query with "no such table" until someone runs it. That is a
 * setup step, not a bad request, and the endpoints say so rather than reporting
 * a generic failure.
 */
function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

export async function listShareTokens(env: AnalyticsEnv): Promise<ShareToken[]> {
  const result = await env.TELEMETRY_DB.prepare(
    `SELECT id, label, created_at, expires_at, last_used_at, use_count
       FROM analytics_access_tokens
      ORDER BY created_at DESC`,
  ).all<TokenRow>();
  return result.results.map(toShareToken);
}

export async function authenticate(request: Request, env: AnalyticsEnv): Promise<Auth> {
  if (
    !env.ANALYTICS_ADMIN_TOKEN ||
    env.ANALYTICS_ADMIN_TOKEN.length < MIN_ADMIN_TOKEN_LENGTH
  ) {
    return { role: "none", reason: "not_configured" };
  }

  const supplied = bearerToken(request);
  if (supplied.length < MIN_ADMIN_TOKEN_LENGTH) {
    return { role: "none", reason: "unauthorized" };
  }
  if (constantTimeEquals(supplied, env.ANALYTICS_ADMIN_TOKEN)) {
    return { role: "admin" };
  }

  const hash = await sha256Hex(supplied);
  let row: TokenRow | null;
  try {
    row = await env.TELEMETRY_DB.prepare(
      `SELECT id, label, created_at, expires_at, last_used_at, use_count
         FROM analytics_access_tokens
        WHERE token_hash = ?1`,
    )
      .bind(hash)
      .first<TokenRow>();
  } catch (error) {
    if (isMissingTable(error)) return { role: "none", reason: "migration_required" };
    throw error;
  }

  if (!row) return { role: "none", reason: "unauthorized" };
  if (row.expires_at !== null && row.expires_at <= Date.now()) {
    return { role: "none", reason: "unauthorized" };
  }
  return { role: "guest", token: toShareToken(row) };
}

/**
 * Records that a share token was used, and prunes tokens that expired long
 * enough ago to be noise in the list.
 *
 * Meant for `context.waitUntil`: neither write changes the answer being sent,
 * and making the dashboard wait on a bookkeeping round trip would be paying
 * latency on every request for a column nobody reads in real time.
 */
export async function noteTokenUse(env: AnalyticsEnv, token: ShareToken): Promise<void> {
  const now = Date.now();
  try {
    await env.TELEMETRY_DB.batch([
      env.TELEMETRY_DB.prepare(
        `UPDATE analytics_access_tokens
            SET last_used_at = ?1, use_count = use_count + 1
          WHERE id = ?2`,
      ).bind(now, token.id),
      env.TELEMETRY_DB.prepare(
        `DELETE FROM analytics_access_tokens
          WHERE expires_at IS NOT NULL AND expires_at < ?1`,
      ).bind(now - 30 * 86_400_000),
    ]);
  } catch {
    // Bookkeeping only. A failure here must not turn a successful read of the
    // dashboard into an error for the person looking at it.
  }
}

export function authFailure(reason: "not_configured" | "unauthorized" | "migration_required"): Response {
  const status = reason === "unauthorized" ? 401 : 503;
  const error =
    reason === "not_configured"
      ? "admin_token_not_configured"
      : reason === "migration_required"
        ? "migration_required"
        : "unauthorized";
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export { isMissingTable };
