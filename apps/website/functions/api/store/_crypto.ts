/// <reference types="@cloudflare/workers-types" />

/** Signed JWTs for the App Store Connect (ES256) and Google (RS256) APIs. */

const encoder = new TextEncoder();

export function base64url(input: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof input === "string"
      ? encoder.encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/\n/g, "\n")
    .replace(/-----(BEGIN|END)[^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  pem: string,
  algorithm: "ES256" | "RS256",
): Promise<string> {
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const params =
    algorithm === "ES256"
      ? ({ name: "ECDSA", namedCurve: "P-256" } as const)
      : ({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const);
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(pem), params, false, ["sign"]);
  // WebCrypto's ECDSA output is already the raw r||s form that JWS wants.
  const signature = await crypto.subtle.sign(
    algorithm === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" },
    key,
    encoder.encode(unsigned),
  );
  return `${unsigned}.${base64url(signature)}`;
}

export function appStoreConnectJwt(keyId: string, issuerId: string, pem: string): Promise<string> {
  // iat a little in the past: Apple answers 401 now and then to a token whose
  // iat is a hair ahead of its clock.
  const now = Math.floor(Date.now() / 1000) - 30;
  return signJwt(
    { alg: "ES256", kid: keyId, typ: "JWT" },
    { iss: issuerId, iat: now, exp: now + 1100, aud: "appstoreconnect-v1" },
    pem,
    "ES256",
  );
}

export type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

export async function googleAccessToken(account: ServiceAccount, scopes: string[]): Promise<string> {
  const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt(
    { alg: "RS256", typ: "JWT" },
    { iss: account.client_email, scope: scopes.join(" "), aud: tokenUri, iat: now, exp: now + 3600 },
    account.private_key,
    "RS256",
  );
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`google token ${response.status}`);
  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}
